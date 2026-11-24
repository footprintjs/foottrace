import type { GapCode } from '../evidence/codes.js';
import { executionIndexOf, stageIdOf } from '../ids/runtimeStageId.js';
import type { StoredLog } from '../time-travel/storedRecord.js';
import { RUN_EVIDENCE_LIMITS, RUN_LOOP_EVIDENCE_VERSION } from './kinds.js';
import { mergeEdges, newFold, walk } from './logFold.js';
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
  readonly reenteredFrom: ReadonlySet<string>;
  readonly uncertainTargets: ReadonlyMap<string, ReadonlySet<string>>;
  readonly loopEvidence: boolean;
  readonly gaps: readonly GapCode[];
};

const unproved = (code: GapCode): DecisionWindow => ({
  decisions: [],
  reenteredFrom: new Set(),
  uncertainTargets: new Map(),
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
  const uncertainReentries = new Set(uncertain);
  const gaps = new Set([...fold.gaps, ...(fold.taint.get('decisions') ?? []), ...(fold.taint.get('control') ?? [])]);
  const loopPositions = new Map(fold.loops.map(({ note, index }) => [note.id, index]));
  const reenteredFrom = new Set<string>();
  for (const id of reentries.keys()) {
    const edge = merged.get(id);
    if (edge?.parent === undefined || edge.index >= upper) continue;
    const hopped = loopPositions.get(edge.parent);
    const source = fold.abouts.get(edge.parent)?.index;
    if (hopped === undefined || source === undefined || hopped <= source || hopped >= edge.index) {
      gaps.add('conservative');
      uncertainReentries.add(id);
    } else {
      reenteredFrom.add(edge.parent);
    }
  }
  const decisions: PositionedDecision[] = [];
  const decisionIds = new Set<string>();
  for (const { row, index } of fold.decisions) {
    if (!charge(budget, 1)) {
      gaps.add('truncated');
      break;
    }
    if (index >= upper) continue;
    if (index <= lower && !uncertainReentries.size) continue;
    const committed = fold.abouts.get(row.id)?.index;
    const commit = committed === undefined ? undefined : log.entries[committed];
    const commitPosition = commit?.kind === 'commit' ? commit.bundle.idx : undefined;
    if (commitPosition === undefined || committed === undefined || committed >= index || commitPosition >= beforeIdx) {
      if (index > lower) gaps.add('conservative');
      continue;
    }
    if (uncertainReentries.size) decisionIds.add(row.id);
    if (index > lower && commitPosition >= fromIdx)
      decisions.push({ decision: row, entryPosition: index, commitPosition });
  }
  const uncertainTargets = new Map<string, Set<string>>();
  if (uncertainReentries.size) {
    if (!charge(budget, ordered.length)) return unproved('truncated');
    const captureStart = fromIdx === 0 ? 0 : positions.get(fromIdx) ?? upper;
    const enclosingDecision = new Map<string, string>();
    // Parents precede children in this order. Assign uncertainty to the decision above the
    // incoming edge, even when the return goes through a branch stage. A new decision at
    // the repeated stage starts its own path and can independently prove a later exit.
    for (const edge of ordered) {
      if (edge.index >= upper || edge.resumes !== undefined) continue;
      const owner = edge.parent === undefined ? undefined : enclosingDecision.get(edge.parent);
      if (edge.index > lower && edge.index >= captureStart && uncertainReentries.has(edge.id)) {
        gaps.add('conservative');
        if (owner !== undefined) {
          const targets = uncertainTargets.get(owner) ?? new Set<string>();
          targets.add(stageIdOf(edge.id));
          uncertainTargets.set(owner, targets);
        }
      }
      if (decisionIds.has(edge.id)) enclosingDecision.set(edge.id, edge.id);
      else if (owner !== undefined) enclosingDecision.set(edge.id, owner);
    }
  }
  return {
    decisions,
    reenteredFrom,
    uncertainTargets,
    loopEvidence: (fold.collects?.v ?? 0) >= RUN_LOOP_EVIDENCE_VERSION && !fold.taint.has('control'),
    gaps: [...gaps],
  };
}
