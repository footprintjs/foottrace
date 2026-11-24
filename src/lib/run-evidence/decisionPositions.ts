import type { GapCode } from '../evidence/codes.js';
import { executionIndexOf, stageIdOf } from '../ids/runtimeStageId.js';
import type { StoredLog } from '../time-travel/storedRecord.js';
import { RUN_EVIDENCE_LIMITS, RUN_LOOP_EVIDENCE_VERSION } from './kinds.js';
import { type LocalEdge, mergeEdges, newFold, walk } from './logFold.js';
import { matchLoops } from './loopEvidence.js';
import type { StoredDecision } from './rows.js';

export interface PositionedDecision {
  readonly decision: StoredDecision;
  /** Exclusive-window comparisons use durable entry positions, never execution allocation order. */
  readonly entryPosition: number;
  readonly commitPosition: number;
}

type DecisionWindow = {
  readonly decisions: readonly PositionedDecision[];
  readonly returnTargets: ReadonlyMap<string, ReadonlySet<string>>;
  readonly unownedReturnCutoffs: ReadonlyMap<string, number>;
  readonly loopEvidence: boolean;
  readonly gaps: readonly GapCode[];
};

const unproved = (code: GapCode): DecisionWindow => ({
  decisions: [],
  returnTargets: new Map(),
  unownedReturnCutoffs: new Map(),
  loopEvidence: false,
  gaps: [code],
});

function charge(budget: { left: number }, count: number): boolean {
  if (budget.left < count) {
    budget.left = 0;
    return false;
  }
  budget.left -= count;
  return true;
}

interface ReturnEvidence {
  readonly source: string;
  readonly target: string;
  readonly position: number;
  readonly uncertain: boolean;
}

function attributeReturns(
  returns: readonly ReturnEvidence[],
  edges: ReadonlyMap<string, LocalEdge>,
  decisions: ReadonlyMap<string, number>,
  gaps: Set<GapCode>,
  budget: { left: number },
) {
  const returnTargets = new Map<string, Set<string>>();
  const unownedReturnCutoffs = new Map<string, number>();
  for (const { source, target, position, uncertain } of returns) {
    if (uncertain) gaps.add('conservative');
    let ancestor = source;
    let down = position;
    let reachedRoot = false;
    // A nested decision can dispatch the return on behalf of an outer loop. Keep
    // each applicable ancestor and let the bound chart match the return target.
    for (;;) {
      if (!charge(budget, 1)) return undefined;
      const edge = edges.get(ancestor);
      if (!edge || edge.index >= down || edge.resumes !== undefined) break;
      const entry = decisions.get(ancestor);
      if (entry !== undefined) {
        if (entry >= position) gaps.add('conservative');
        const targets = returnTargets.get(ancestor) ?? new Set<string>();
        targets.add(target);
        returnTargets.set(ancestor, targets);
      }
      if (edge.parent === undefined) {
        // Match control's root rule. A parentless later execution is a resumed leg.
        reachedRoot = executionIndexOf(edge.id) === 0;
        break;
      }
      down = edge.index;
      ancestor = edge.parent;
    }
    if (!reachedRoot) {
      gaps.add('conservative');
      unownedReturnCutoffs.set(target, Math.max(unownedReturnCutoffs.get(target) ?? 0, position));
    }
  }
  return { returnTargets, unownedReturnCutoffs };
}

/**
 * A decision's admitted row and its durable position in one native log.
 * Only notes after their own substantive commit and inside a proven window can supply evidence.
 */
export function readDecisionWindow(
  log: StoredLog,
  beforeIdx: number,
  lastChangeIdx: number | undefined,
  budget: { left: number },
  fromIdx = 0,
): DecisionWindow {
  if (
    !Number.isSafeInteger(beforeIdx) ||
    beforeIdx < 0 ||
    beforeIdx > log.commitLog.length ||
    (lastChangeIdx !== undefined &&
      (!Number.isSafeInteger(lastChangeIdx) || lastChangeIdx < 0 || lastChangeIdx >= beforeIdx))
  ) {
    return unproved('invalid-data');
  }
  if (!charge(budget, log.entries.length * 3)) return unproved('truncated');
  if (log.initialState === undefined || log.entries[0]?.kind !== 'opened') return unproved('not-collected');
  const positions = new Map<number, number>();
  let closingPosition: number | undefined;
  let nextCommit = 0;
  for (let position = 0; position < log.entries.length; position++) {
    const entry = log.entries[position];
    if (entry.kind === 'commit') {
      const idx = entry.bundle.idx;
      if (idx === undefined || idx < nextCommit) return unproved('conservative');
      nextCommit = idx + 1;
      positions.set(idx, position);
    } else if (entry.kind === 'closed' && entry.commits === log.commitLog.length) {
      closingPosition = position;
    }
  }
  const lower = lastChangeIdx === undefined ? 0 : positions.get(lastChangeIdx);
  const upper = beforeIdx === log.commitLog.length && log.complete ? closingPosition : positions.get(beforeIdx);
  if (lower === undefined || upper === undefined || lower >= upper) return unproved('conservative');
  if (log.gaps.some((gap) => gap.index < beforeIdx)) return unproved('not-collected');

  const fold = newFold(log);
  if (fold.why !== undefined) return unproved('not-collected');
  walk(fold, { limits: RUN_EVIDENCE_LIMITS, budget }, false);
  if (budget.left < 1) return unproved('truncated');

  const merged = mergeEdges([fold]);
  const truncated = {};
  const ordered = [...merged.values()];
  try {
    ordered.sort((a, b) => {
      if (!charge(budget, 1)) throw truncated;
      return executionIndexOf(a.id) - executionIndexOf(b.id);
    });
  } catch (error) {
    if (error === truncated) return unproved('truncated');
    throw error;
  }
  if (!charge(budget, ordered.length * 4 + fold.loops.length)) return unproved('truncated');
  const { reentries, uncertain } = matchLoops(ordered, merged, [fold]);
  const gaps = new Set([...fold.gaps, ...(fold.taint.get('decisions') ?? []), ...(fold.taint.get('control') ?? [])]);
  const captureStart = fromIdx === 0 ? 0 : positions.get(fromIdx) ?? upper;
  const inWindow = (position: number) => position > lower && position >= captureStart && position < upper;
  const loopPositions = new Map(fold.loops.map(({ note, index }) => [note.id, index]));
  const returns: ReturnEvidence[] = [];
  const pairedSources = new Set<string>();
  for (const id of new Set([...reentries.keys(), ...uncertain])) {
    if (!charge(budget, 1)) return unproved('truncated');
    const edge = merged.get(id);
    if (edge?.parent === undefined || !inWindow(edge.index)) continue;
    const hop = loopPositions.get(edge.parent);
    const source = fold.abouts.get(edge.parent)?.index;
    const confirmed =
      reentries.has(id) && hop !== undefined && source !== undefined && source < hop && hop < edge.index;
    if (confirmed) pairedSources.add(edge.parent);
    returns.push({ source: edge.parent, target: stageIdOf(id), position: edge.index, uncertain: !confirmed });
  }
  for (const { note, index } of fold.loops) {
    if (!charge(budget, 1)) return unproved('truncated');
    if (inWindow(index) && !pairedSources.has(note.id)) {
      // A retained hop before the cutoff without its confirmed target cannot prove an exit.
      returns.push({ source: note.id, target: note.target, position: index, uncertain: true });
    }
  }

  const decisions: PositionedDecision[] = [];
  const decisionPositions = new Map<string, number>();
  for (const { row, index } of fold.decisions) {
    if (!charge(budget, 1)) return unproved('truncated');
    if (index <= lower || index >= upper) continue;
    const committed = fold.abouts.get(row.id)?.index;
    const commit = committed === undefined ? undefined : log.entries[committed];
    const commitPosition = commit?.kind === 'commit' ? commit.bundle.idx : undefined;
    if (commitPosition === undefined || committed === undefined || committed >= index || commitPosition >= beforeIdx) {
      gaps.add('conservative');
      continue;
    }
    if (commitPosition >= fromIdx) {
      decisions.push({ decision: row, entryPosition: index, commitPosition });
      if (returns.length) decisionPositions.set(row.id, index);
    }
  }
  const attribution = attributeReturns(returns, merged, decisionPositions, gaps, budget);
  if (!attribution) return unproved('truncated');
  return {
    decisions,
    ...attribution,
    loopEvidence: (fold.collects?.v ?? 0) >= RUN_LOOP_EVIDENCE_VERSION && !fold.taint.has('control'),
    gaps: [...gaps],
  };
}
