import type { GapCode } from '../../evidence/codes.js';
import { stageIdOf } from '../../ids/runtimeStageId.js';
import { relation } from '../../memory/keyPaths.js';
import type { UnchangedWriteRecording } from '../../memory/unchangedWriteTypes.js';
import { prepareUnchangedWrites } from '../../memory/unchangedWrites.js';
import { readDecisionWindow, type PositionedDecision } from '../../run-evidence/decisionPositions.js';
import type { StoredLog } from '../../time-travel/storedRecord.js';
import { skippedBranches } from './dispatch.js';
import { readSkippedKeyHistory } from './keyHistory.js';
import type { NormalizedControl, NormalizedSkippedStage, SkippedPathGap, SkippedWork, SkippedWriter } from './types.js';

export interface AdmittedSkippedChart {
  readonly stages: ReadonlyMap<string, NormalizedSkippedStage>;
  readonly controlsByStage: ReadonlyMap<string, readonly NormalizedControl[]>;
  readonly binding: 'native' | 'host-attested';
}

export interface CouldHaveChangedCandidate {
  readonly decision: PositionedDecision['decision'];
  readonly skippedEntry: string;
  readonly writers: readonly SkippedWriter[];
  readonly binding: AdmittedSkippedChart['binding'];
}

export type SkippedGap = GapCode | Exclude<SkippedPathGap, 'limit'> | 'loop-evidence';

/** Internal fold. An authenticated adapter must own and admit the graph before passing it here. */
export function analyzeBoundSkippedPaths(
  log: StoredLog,
  graph: AdmittedSkippedChart,
  key: string,
  beforeIdx: number,
  budget: SkippedWork,
  fromIdx = 0,
  retained?: UnchangedWriteRecording,
): { readonly candidates: readonly CouldHaveChangedCandidate[]; readonly gaps: readonly SkippedGap[] } {
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
  const candidates: CouldHaveChangedCandidate[] = [];
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
        binding: graph.binding,
      });
    }
    for (const gap of result.gaps) gaps.add(gap === 'limit' ? 'truncated' : gap);
    if (result.gaps.includes('limit')) break;
  }
  return { candidates, gaps: [...gaps] };
}
