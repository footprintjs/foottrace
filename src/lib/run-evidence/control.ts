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
 * given holds (`log-not-given`: the fold never reaches past what it was given), a stage whose `about` is missing
 * (`no-about`). Following a `resumes` edge reads `conservative`, because stages after a re-entry may be over-attributed to
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

/** Each decision's branch entries: its first N children by execution index. `edges` are in that order. */
function entriesOf(
  edges: readonly ControlEdge[],
  decisions: ReadonlyMap<string, ControlDecision>,
): ReadonlyMap<string, ControlDecision> {
  const taken = new Map<string, number>();
  const entries = new Map<string, ControlDecision>();
  for (const { id, parent } of edges) {
    const decision = parent === undefined ? undefined : decisions.get(parent);
    if (decision === undefined) continue;
    const used = taken.get(decision.id) ?? 0;
    if (used >= decision.entries) continue;
    taken.set(decision.id, used + 1);
    entries.set(id, decision);
  }
  return entries;
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
  const entries = entriesOf(edges, decisions);
  const answers = new Map<string, RunControl>();
  for (const edge of edges) {
    const entry = entries.get(edge.id);
    answers.set(
      edge.id,
      entry === undefined ? step(edge, answers, committed) : answer(edge.gaps, entry.id, entry.label),
    );
  }
  return answers;
}
