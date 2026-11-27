import type { GapCode } from '../../evidence/codes.js';
import { stageIdOf } from '../../ids/runtimeStageId.js';
import { relation } from '../../memory/keyPaths.js';
import type { UnchangedWriteRecording } from '../../memory/unchangedWriteTypes.js';
import { prepareUnchangedWrites } from '../../memory/unchangedWrites.js';
import { readDecisionWindow, type PositionedDecision } from '../../run-evidence/decisionPositions.js';
import type { StoredLog } from '../../time-travel/storedRecord.js';
import { skippedBranches } from './dispatch.js';
import { readSkippedKeyHistory } from './keyHistory.js';
import type { NormalizedSkippedChart } from './normalize.js';
import type { SkippedPathGap, SkippedWork, SkippedWriter } from './types.js';

export interface SkippedPathCandidate {
  readonly decision: PositionedDecision['decision'];
  readonly skippedEntry: string;
  readonly writers: readonly SkippedWriter[];
}

export type SkippedGap = GapCode | Exclude<SkippedPathGap, 'limit'> | 'loop-evidence';

/** Internal fold over a structurally normalized graph. Binding belongs to the calling adapter. */
export function analyzeSkippedPaths(
  log: StoredLog,
  graph: NormalizedSkippedChart,
  key: string,
  beforeIdx: number,
  budget: SkippedWork,
  fromIdx = 0,
  retained?: UnchangedWriteRecording,
): { readonly candidates: readonly SkippedPathCandidate[]; readonly gaps: readonly SkippedGap[] } {
  const history = readSkippedKeyHistory(log, key, beforeIdx, budget, fromIdx);
  if (history.status === 'unknown') return { candidates: [], gaps: [history.reason] };
  const observed = new Set(history.observed);
  if (retained !== undefined) {
    const prepared = prepareUnchangedWrites(retained, log.commitLog, budget);
    try {
      for (const stage of prepared.observedBefore(key, beforeIdx, fromIdx)) observed.add(stage);
    } catch {
      return { candidates: [], gaps: ['truncated'] };
    }
  }
  if (observed.size) {
    const seen = new Set<string>();
    for (const stage of graph.stages.values()) {
      if (budget.left < 1) return { candidates: [], gaps: ['truncated'] };
      budget.left--;
      // Static IDs can name several different placements (for example builder-created fallbacks).
      if (stage.role === 'stage' && observed.has(stage.stageId)) {
        if (seen.has(stage.stageId)) observed.delete(stage.stageId);
        else seen.add(stage.stageId);
      }
    }
  }
  const window = readDecisionWindow(log, beforeIdx, history.lastChangeIdx, budget, fromIdx);
  const gaps = new Set<SkippedGap>(window.gaps);
  const candidates: SkippedPathCandidate[] = [];
  const declaredMatches = (path: string) => relation(path, key) !== undefined;
  for (const { decision, entryPosition } of window.decisions) {
    if (budget.left < 1) {
      gaps.add('truncated');
      break;
    }
    budget.left--;
    const controls = graph.controlsByStage.get(stageIdOf(decision.id));
    if (controls?.length !== 1) {
      gaps.add('graph-ambiguous');
      continue;
    }
    const result = skippedBranches(
      decision,
      controls[0],
      graph.stages,
      observed,
      declaredMatches,
      {
        recorded: window.loopEvidence,
        sawReturn: (target) =>
          window.returnTargets.get(decision.id)?.has(target) === true ||
          (window.unownedReturnCutoffs.get(target) ?? -1) > entryPosition,
      },
      budget,
    );
    for (const branch of result.branches) {
      candidates.push({
        decision,
        skippedEntry: branch.entry,
        writers: branch.writers,
      });
    }
    for (const gap of result.gaps) gaps.add(gap === 'limit' ? 'truncated' : gap);
    if (result.gaps.includes('limit')) break;
  }
  return { candidates, gaps: [...gaps] };
}
