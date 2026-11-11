/**
 * recordBuiltOn.ts — the cause graph's edges for a write whose value still holds an earlier one.
 *
 * WHY THIS FILE EXISTS. A node of the cause graph is one COMMIT's write of one key. The value that
 * write left can still hold what was there, in two ways (`memory/builtOn.ts`, the one rule):
 *   - the write did not replace the key (a merge, an append, a row inside it): it was FOLDED onto
 *     what the write just before it had left, in commit order;
 *   - the writer built a `set` row on the step's VIEW (`TraceEntry.builtOnView`): the row holds what
 *     the view held, so the commit read the key from its view. Its source is the read rule's
 *     (`memory/readWindow.ts`), asked with the moment that commit's view was pinned
 *     (`CommitBundle.viewAt`).
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
 * every commit can carry a marked row, and bundles that say no index can leave the place of a view
 * open over a long stretch of the log. One question about ONE KEY of a node (its parents or its
 * children through these edges) therefore costs the size of the log and no more: one model of the
 * log (the door's copy is not frozen, so nothing keeps a model between lookups), one pass to place
 * the views, and one halving per write of the key. Both functions also stop at the number of edges
 * the caller can use (`limit`). The work is counted (`queryWork`) and pinned by a counted test
 * (`test/cause/built-on-view.test.ts`). A node that names no key is asked once per key its commit
 * wrote, here as in the callers' older code.
 */
import { builtDirectlyOn, builtOnBefore, readFromView } from '../memory/builtOn.js';
import { lastWriterPosition, writersOf } from '../memory/commitLogUtils.js';
import { lowerBound, queryWork } from '../memory/keyPaths.js';
import { logModel } from '../memory/logModel.js';
import { readOfValue, readSourcesOf } from '../memory/readWindow.js';
import { placesOf } from '../memory/windowPlacement.js';
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

/** What the write of `key` at a commit was built on: the earlier writes, and whether a view of the pre-run value is. */
export interface BuiltOnParents {
  readonly parents: readonly BuiltOnParent[];
  /**
   * The commit holds a `set` row built on a view that held no write of the key, or may have held none
   * (where the view cannot be placed): that part of the row came from before the run, or from nothing,
   * and there is no node to point at. WHY ONLY THE VIEW IS SAID. A write FOLDED onto the pre-run value
   * has no node either, and no caller needs to hear it from here: its node already says so through
   * its slice (`recordInspection.ts · addBuiltOnParents`). A marked `set` is a whole write, so this
   * flag is the only thing that says it.
   */
  readonly viewHeldPreRun: boolean;
}

/**
 * The writes the value of `key` after the commit at `commitIndex` still holds, as edges, each named
 * once, ascending, at most `limit` of them:
 *   - the write just before it, when this one did not replace the value (certain; it may be an
 *     earlier commit of the same step);
 *   - what its view held, when the writer built a `set` row of it on the view: the last write
 *     before the moment the view was pinned, for certain. Only where that moment cannot be placed
 *     at one position of the record's log (`memory/windowPlacement.ts`; bundles that say no index
 *     are the usual case) can a write lie inside the range it could be in; then each of those
 *     writes is a possible source.
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
  const add = (position: number, certain: boolean): void => {
    if (position >= 0) found.set(position, (found.get(position) ?? false) || certain);
  };
  const folded = builtOnBefore(
    key,
    commitIndex,
    (position) => scope.log[position],
    (path, before) => lastWriterPosition(scope.log, path, before),
  );
  if (folded !== undefined) add(folded, true);
  let viewHeldPreRun = false;
  if (readFromView(scope.log[commitIndex], key)) {
    // The sources of a window are every write of the key inside it, one writer lookup each. ONE model
    // answers them all; asked one by one, each lookup could build a model of its own.
    const model = logModel(scope.log);
    const seen = readSourcesOf(key, placesOf(scope.log).view(commitIndex), (path, before) =>
      model.lastWriterBefore(path, before),
    );
    queryWork.units += 1 + seen.during.length;
    const certain = seen.during.length === 0;
    viewHeldPreRun = seen.before < 0;
    add(seen.before, certain);
    for (const position of seen.during) add(position, false);
  }
  return {
    parents: [...found]
      .sort(([a], [b]) => a - b)
      .slice(0, limit)
      .map(([position, certain]) => ({ edge: edgeTo(scope, key, position), certain })),
    viewHeldPreRun,
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
  const viewAt = placesOf(scope.log).view;
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
    // Could this commit's view hold the write? Whether it is then the certain source or a possible
    // one is the parent side's to say; a child is listed either way.
    if (readOfValue(viewAt(position), commitIndex, next, false) !== false) found.push(position);
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
