/**
 * recordBuiltOn.ts — the cause graph's edges for a write whose value still holds an earlier one.
 *
 * WHY THIS FILE EXISTS. A node of the cause graph is one COMMIT's write of one key. The value that
 * write left can still hold what was there, in two ways (`memory/builtOn.ts`, the one rule):
 *   - the write did not replace the key (a merge, an append, a row inside it): it was FOLDED onto
 *     what the write just before it had left, in commit order;
 *   - the writer built a `set` row on the step's VIEW (`TraceEntry.builtOnView`): the row holds what
 *     the view held, so the commit read the key from its view. Its sources are the read rule's
 *     (`memory/readWindow.ts`), asked with that commit's own window.
 * No read of the step is behind either dependence, so neither of the graph's two ways of finding
 * parents sees it: not the walk over recorded reads, and not the exact read sources. Both ask here.
 *
 * WHY HERE AND NOT THROUGH THE STEP-LEVEL WALK. `causalChain` answers in steps: it draws no edge from
 * a step to itself and lets a certain read stand in for this link. Both are right for steps and
 * wrong for commits. A step's later commit is folded onto its earlier one, and a read can be of one
 * commit of a step while the write was folded onto another. So the graph asks the rule for each
 * node by its own commit. The two directions are each other's inverse commit by commit (pinned over
 * every small log in `test/cause/built-on.test.ts`, and on the real writer in the property test).
 *
 * The edges carry `attribution: 'recorded-write'`: the record's own rows say it.
 *
 * WHAT ONE QUESTION MAY COST. The record comes from outside, so its shape is the sender's choice:
 * every commit can carry a marked row and a window over the whole log. One question (the parents or
 * the children of one node) therefore costs the size of the log and no more: one model of the log
 * (the door's copy is not frozen, so nothing keeps a model between lookups), one pass for the
 * windows, and one halving per write of the key. Both functions also stop at the number of
 * edges the caller can use (`limit`). The work is counted (`queryWork`) and pinned by a counted test
 * (`test/cause/built-on-view.test.ts`).
 */
import { builtDirectlyOn, builtOnBefore, readFromView } from '../memory/builtOn.js';
import { lastWriterPosition, writersOf } from '../memory/commitLogUtils.js';
import { lowerBound, queryWork } from '../memory/keyPaths.js';
import { logModel } from '../memory/logModel.js';
import { readOfValue, readSourcesOf } from '../memory/readWindow.js';
import { windowOf, windowsOf } from '../memory/windowPlacement.js';
import { nodeIdFor } from './recordIdentity.js';
import type { PreparedRecordScope } from './recordTypes.js';
import type { GraphEdge } from './types.js';

const edgeTo = (scope: PreparedRecordScope, key: string, position: number): GraphEdge => ({
  nodeId: nodeIdFor(scope.address, { runtimeStageId: scope.log[position].runtimeStageId, commitIdx: position, key }),
  kind: 'data',
  attribution: 'recorded-write',
  evidence: ['commit:' + position],
});

/** One write that a node's value still holds. `certain: false`: a possible source, not a certain one. */
export interface BuiltOnParent {
  readonly edge: GraphEdge;
  readonly certain: boolean;
}

/** What the write of `key` at a commit was built on: the earlier writes, and whether the pre-run value is under it. */
export interface BuiltOnParents {
  readonly parents: readonly BuiltOnParent[];
  /** Part of the value came from before the run (or from nothing): there is no node to point at. */
  readonly preRun: boolean;
}

/**
 * The writes the value of `key` after the commit at `commitIndex` still holds, as edges, each named
 * once, ascending, at most `limit` of them:
 *   - the write just before it, when this one did not replace the value (certain; it may be an
 *     earlier commit of the same step);
 *   - what its view could have seen, when the writer built a `set` row of it on the view: the last
 *     write before the view, for certain, unless the key was also written inside the commit's
 *     window; then each of those writes is a possible source.
 *
 * @param limit  How many edges the caller can use. Pass one more than its cap, so that it still sees
 *               that there were too many.
 */
export function builtOnParents(
  scope: PreparedRecordScope,
  key: string,
  commitIndex: number,
  limit = Infinity,
): BuiltOnParents {
  const found = new Map<number, boolean>();
  let preRun = false;
  const add = (position: number, certain: boolean): void => {
    if (position < 0) preRun = true;
    else found.set(position, (found.get(position) ?? false) || certain);
  };
  const folded = builtOnBefore(
    key,
    commitIndex,
    (position) => scope.log[position],
    (path, before) => lastWriterPosition(scope.log, path, before),
  );
  if (folded !== undefined) add(folded, true);
  if (readFromView(scope.log[commitIndex], key)) {
    // The sources of a window are every write of the key inside it, one writer lookup each. ONE model
    // answers them all; asked one by one, each lookup could build a model of its own.
    const model = logModel(scope.log);
    const seen = readSourcesOf(key, windowOf(scope.log, commitIndex), (path, before) =>
      model.lastWriterBefore(path, before),
    );
    queryWork.units += 1 + seen.during.length;
    const certain = seen.during.length === 0;
    add(seen.before, certain);
    for (const position of seen.during) add(position, false);
  }
  return {
    parents: [...found]
      .sort(([a], [b]) => a - b)
      .slice(0, limit)
      .map(([position, certain]) => ({ edge: edgeTo(scope, key, position), certain })),
    preRun,
  };
}

/**
 * The inverse of {@link builtOnParents}: the ARRAY positions (ascending, at most `limit`) of the
 * commits whose write of `key` still holds the write at `commitIndex`. The next write of the key,
 * when it was folded onto this one; and every later commit that built a `set` row on a view which
 * could see this write.
 *
 * HOW THE SECOND PART IS ASKED. Each later write of the key is looked at once. One with a marked row
 * is asked the read rule FORWARD (`memory/readWindow.ts · readOfValue`): could a look inside its
 * window see the write at `commitIndex`? That is the same question `builtOnParents` answers for that
 * commit, turned around, and it costs one halving. WHY NOT ask `builtOnParents` for each later
 * write and look for `commitIndex` in the answer: that lists every source of every window, and with
 * a wide window on every commit the cost of ONE question grew with the square of the log (raised by
 * the automated security review of this change).
 *
 * @param limit  As in {@link builtOnParents}.
 */
export function builtOnChildPositions(
  scope: PreparedRecordScope,
  key: string,
  commitIndex: number,
  limit = Infinity,
): number[] {
  const writes = writersOf(scope.log, key);
  const from = lowerBound(writes, commitIndex + 1);
  // The write that ends this one's time as the LAST write of the key: a view pinned after it holds a later one.
  const next = from < writes.length ? writes[from] : undefined;
  const folded = builtDirectlyOn(key, commitIndex, writes, (position) => scope.log[position]);
  const windowAt = windowsOf(scope.log);
  const found: number[] = [];
  for (let at = from; at < writes.length && found.length < limit; at++) {
    const position = writes[at];
    const bundle = scope.log[position];
    queryWork.units += 1 + bundle.trace.length;
    if (position === folded) {
      found.push(position);
      continue;
    }
    if (!readFromView(bundle, key)) continue;
    // Could a look inside this commit's window see the write? Whether it is then the certain source or
    // a possible one is the parent side's to say; a child is listed either way.
    if (readOfValue(windowAt(position), commitIndex, next, false) !== false) found.push(position);
  }
  return found;
}

/** {@link builtOnChildPositions}, as edges. */
export function builtOnChildren(
  scope: PreparedRecordScope,
  key: string,
  commitIndex: number,
  limit = Infinity,
): GraphEdge[] {
  return builtOnChildPositions(scope, key, commitIndex, limit).map((position) => edgeTo(scope, key, position));
}
