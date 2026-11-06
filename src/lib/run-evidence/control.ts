/**
 * control.ts — which decision let an execution run, folded from stored facts.
 *
 * The same rule as `ControlDepRecorder`, read off the file: a decider's branch entry is its first child by execution
 * index, a selector's its first N, and the governing decision of an execution is the nearest entry on its way up,
 * through `resumes`, else `parent`.
 *
 * It is one forward pass, not a walk. `admit.ts` refuses any edge that does not point at an earlier execution, so in
 * execution-index order every answer's next step is already known: a chain cannot cycle, its length cannot cost more than
 * the file does, and no recursion or per-query walk exists.
 *
 * WHAT THE ANSWER PROMISES. No decider with `collected` means a whole chain to the true root with no decision on it.
 * Everything else that cannot finish says so: a parentless execution that is not the root (`resumed-leg`), a parent no log
 * given holds (`log-not-given`: the fold never reaches past what it was given), a stage whose `about` is missing, or a
 * child that only such a stage could tell apart from a branch entry (`no-about`). Following a `resumes` edge reads `conservative`, because stages after a re-entry may be over-attributed to
 * the branch it continued.
 */

import type { GapCode } from '../evidence/codes.js';
import { executionIndexOf } from '../ids/runtimeStageId.js';
import type { StoredDecisionEvidence } from './kinds.js';
import type { RunControl } from './rows.js';

/** One execution's way up, and what its log says about how far to trust it. */
export interface ControlEdge {
  readonly id: string;
  readonly parent?: string;
  readonly resumes?: string;
  readonly gaps: readonly GapCode[];
}

/** One decision: how many children it governs, and the rule that made it. */
export interface ControlDecision {
  readonly id: string;
  readonly entries: number;
  readonly label?: string;
}

const CONSERVATIVE: readonly GapCode[] = Object.freeze(['conservative']);
const BOUNDARY: readonly GapCode[] = Object.freeze(['scope-boundary']);
const LOST: readonly GapCode[] = Object.freeze(['not-collected']);

function union(a: readonly GapCode[], b: readonly GapCode[]): readonly GapCode[] {
  if (b.length === 0) return a;
  if (a.length === 0) return b;
  const merged = [...a];
  for (const code of b) if (!merged.includes(code)) merged.push(code);
  return merged.length === a.length ? a : Object.freeze(merged);
}

function answer(gaps: readonly GapCode[], decider?: string, label?: string, why?: string): RunControl {
  return Object.freeze({
    status: gaps.length === 0 ? 'collected' : 'partial',
    ...(decider === undefined ? {} : { decider }),
    ...(label === undefined ? {} : { label }),
    gaps,
    ...(why === undefined ? {} : { why }),
  });
}

/** The answer one step up, carried down: its decider and reason, with these gaps added. */
function inherited(up: RunControl, gaps: readonly GapCode[], why?: string): RunControl {
  return answer(union(up.gaps, gaps), up.decider, up.label, up.why ?? why);
}

/**
 * The rule that made a decision: the matched rule of the chosen branch, else the first matched. A selector picks N
 * branches, so no one label is its.
 */
export function decisionLabel(evidence: StoredDecisionEvidence | undefined): string | undefined {
  if (evidence === undefined || 'selected' in evidence) return undefined;
  const { rules, chosen } = evidence;
  return (rules.find((rule) => rule.matched && rule.branch === chosen) ?? rules.find((rule) => rule.matched))?.label;
}

/** How many of the ascending `sorted` are below `value`. */
function countBelow(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Each decision's branch entries: its first N children by execution index. `edges` are in that order.
 *
 * An execution with a commit and no edge names no parent, so it may be one of those children. A child with N known
 * children before it is no entry, and one still within N if every such execution were a child is an entry. Any other is
 * `unsure`: missing metadata never promotes a continuation into a branch entry.
 */
function entriesOf(
  edges: readonly ControlEdge[],
  decisions: ReadonlyMap<string, ControlDecision>,
  committed: ReadonlySet<string>,
): { readonly entries: ReadonlyMap<string, ControlDecision>; readonly unsure: ReadonlySet<string> } {
  const named = new Set(edges.map((edge) => edge.id));
  const silent = [...committed]
    .filter((id) => !named.has(id))
    .map((id) => executionIndexOf(id))
    .sort((x, y) => x - y);
  const taken = new Map<string, number>();
  const entries = new Map<string, ControlDecision>();
  const unsure = new Set<string>();
  for (const { id, parent } of edges) {
    const decision = parent === undefined ? undefined : decisions.get(parent);
    if (decision === undefined) continue;
    const used = taken.get(decision.id) ?? 0;
    if (used >= decision.entries) continue;
    taken.set(decision.id, used + 1);
    const between = countBelow(silent, executionIndexOf(id)) - countBelow(silent, executionIndexOf(decision.id) + 1);
    if (used + between < decision.entries) entries.set(id, decision);
    else unsure.add(id);
  }
  return { entries, unsure };
}

/** One execution's answer. Everything earlier is already in `answers`. */
function step(edge: ControlEdge, answers: ReadonlyMap<string, RunControl>, committed: ReadonlySet<string>): RunControl {
  const { id, parent, resumes, gaps } = edge;
  const resumed = resumes === undefined ? undefined : answers.get(resumes);
  if (resumed !== undefined) return inherited(resumed, union(gaps, CONSERVATIVE));
  // A `resumes` it cannot follow: the leg it names was not given.
  const blocked = resumes !== undefined;
  if (parent === undefined) {
    if (!blocked && executionIndexOf(id) === 0) return answer(gaps);
    return answer(union(gaps, BOUNDARY), undefined, undefined, 'resumed-leg');
  }
  const up = answers.get(parent);
  if (up !== undefined)
    return inherited(up, blocked ? union(gaps, BOUNDARY) : gaps, blocked ? 'resumed-leg' : undefined);
  if (committed.has(parent)) return answer(union(gaps, LOST), undefined, undefined, 'no-about');
  return answer(union(gaps, BOUNDARY), undefined, undefined, blocked ? 'resumed-leg' : 'log-not-given');
}

/**
 * Fold every execution's answer. `edges` must be in execution-index order: that order is what makes one pass enough.
 * `committed` is every id a given log holds a commit for, with or without an `about`.
 */
export function foldControl(
  edges: readonly ControlEdge[],
  decisions: ReadonlyMap<string, ControlDecision>,
  committed: ReadonlySet<string>,
): ReadonlyMap<string, RunControl> {
  const { entries, unsure } = entriesOf(edges, decisions, committed);
  const answers = new Map<string, RunControl>();
  for (const edge of edges) {
    const entry = entries.get(edge.id);
    if (unsure.has(edge.id)) answers.set(edge.id, answer(union(edge.gaps, LOST), undefined, undefined, 'no-about'));
    else if (entry !== undefined) answers.set(edge.id, answer(edge.gaps, entry.id, entry.label));
    else answers.set(edge.id, step(edge, answers, committed));
  }
  return answers;
}
