import { sliceForKey } from '../../slice/sliceForKey.js';
import { normaliseStateKey } from '../../record-paths/codec.js';
import { collectScopeCoverage, recordGapCollector } from '../recordCoverage.js';
import { nodeIdFor } from '../recordIdentity.js';
import { readKeysForStage } from '../recordScope.js';
import { queryMemo } from '../queryMemo.js';
import type { PreparedRecordScope, RecordInspection } from '../recordTypes.js';
import type { GapCode, GraphContext, GraphEdge } from '../types.js';

/** Work belongs to one boundary inspection, including references that produce no edge. */
export function spendSubflowWork(work: { left: number }): boolean {
  if (!Number.isSafeInteger(work.left) || work.left < 1) return false;
  work.left--;
  return true;
}

/**
 * Resolve a literal root at the saved exclusive cutoff through the existing slice authority.
 * Finding its writer is depth zero; the ordinary graph query later inspects that writer's parents.
 */
export function subflowSource(
  scope: PreparedRecordScope,
  literalRoot: string,
  beforeCommitIdx: number,
  context: GraphContext,
  work: { left: number },
  extraGapCodes?: readonly GapCode[],
): RecordInspection {
  const refused = (code: GapCode): RecordInspection => ({
    adjacency: { edges: [], complete: false },
    gaps: [{ code, evidence: [] }],
  });
  // Charge before validation and memo lookup as well as before a fresh slice.
  if (!spendSubflowWork(work)) return refused('edge-limit');
  if (context.signal.aborted) return refused('cancelled');
  if (!Number.isSafeInteger(beforeCommitIdx) || beforeCommitIdx < 0 || beforeCommitIdx > scope.log.length)
    return refused('invalid-data');
  const inspect = (): RecordInspection => {
    const coverage = recordGapCollector();
    for (const code of extraGapCodes ?? []) coverage.addGap(code);
    for (const code of scope.readSources?.gaps ?? []) coverage.addGap(code);
    if (!scope.complete) coverage.addGap('not-collected');
    const key = normaliseStateKey([literalRoot]);
    const slice = sliceForKey(scope.log, key, (id) => readKeysForStage(scope, id), {
      before: beforeCommitIdx,
      maxDepth: 0,
      maxNodes: 1,
    });
    for (const note of slice.notes ?? []) coverage.addGap(note.code === 'redacted' ? 'redacted' : 'conservative');
    const edges: GraphEdge[] = [];
    if (slice.writer) {
      const commitIdx = scope.log.indexOf(slice.writer);
      collectScopeCoverage(scope, slice.writer, extraGapCodes, coverage.addGap);
      const nodeId = nodeIdFor(scope.address, { runtimeStageId: slice.writer.runtimeStageId, commitIdx, key });
      if (commitIdx < 0 || commitIdx >= beforeCommitIdx || nodeId === 'record:invalid') coverage.addGap('invalid-data');
      else edges.push({ nodeId, kind: 'data', attribution: 'stage', evidence: ['commit:' + commitIdx] });
    } else coverage.addGap('untracked-input');
    return { adjacency: { edges, complete: coverage.gaps.length === 0 }, gaps: coverage.gaps };
  };
  // The admitted scope object is the owner: equal addresses in another graph cannot share an answer.
  const key = 'subflow-source:' + JSON.stringify([beforeCommitIdx, literalRoot]);
  const result = queryMemo(context)?.remember(scope, key, inspect) ?? inspect();
  return context.signal.aborted ? refused('cancelled') : result;
}
