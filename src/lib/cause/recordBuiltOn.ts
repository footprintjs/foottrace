/**
 * recordBuiltOn.ts — the cause graph's edges for a write that did not replace its key.
 *
 * WHY THIS FILE EXISTS. A node of the cause graph is one COMMIT's write of one key. When that write
 * merged into the value, appended to it or wrote a path inside it, the value it left is made of that
 * write and of what the write before it had left (`memory/builtOn.ts`, the one rule). No read is
 * behind that dependence, so neither of the graph's two ways of finding parents sees it: not the
 * walk over recorded reads, and not the exact read sources. Both ask here.
 *
 * WHY HERE AND NOT THROUGH THE STEP-LEVEL WALK. `causalChain` answers in steps: it draws no edge from
 * a step to itself and lets a certain read stand in for this link. Both are right for steps and
 * wrong for commits. A step's later commit is folded onto its earlier one, and a read can be of one
 * commit of a step while the write was folded onto another. So the graph asks the rule for each
 * node by its own commit: the parent is the write just before it, the child the write just after
 * it, each only when the later of the two did not replace the value. That makes the two directions
 * each other's inverse commit by commit (pinned over every small log in `test/cause/built-on.test.ts`).
 *
 * The edges carry `attribution: 'recorded-write'`: the record's own rows say it, and it is exact.
 */
import { builtDirectlyOn, builtOnBefore } from '../memory/builtOn.js';
import { lastWriterPosition, writersOf } from '../memory/commitLogUtils.js';
import { nodeIdFor } from './recordIdentity.js';
import type { PreparedRecordScope } from './recordTypes.js';
import type { GraphEdge } from './types.js';

const edgeTo = (scope: PreparedRecordScope, key: string, position: number): GraphEdge => ({
  nodeId: nodeIdFor(scope.address, { runtimeStageId: scope.log[position].runtimeStageId, commitIdx: position, key }),
  kind: 'data',
  attribution: 'recorded-write',
  evidence: ['commit:' + position],
});

/**
 * What the write of `key` at `commitIndex` was folded onto: an edge to the write just before it
 * (which may be an earlier commit of the same step); `'pre-run'` when no commit before it wrote the
 * key, so it was folded onto the value from before the run and there is no node to point at;
 * `undefined` when the write replaced the value.
 */
export function builtOnParent(
  scope: PreparedRecordScope,
  key: string,
  commitIndex: number,
): GraphEdge | 'pre-run' | undefined {
  const under = builtOnBefore(
    key,
    commitIndex,
    (position) => scope.log[position],
    (path, before) => lastWriterPosition(scope.log, path, before),
  );
  if (under === undefined) return undefined;
  return under < 0 ? 'pre-run' : edgeTo(scope, key, under);
}

/** The ARRAY position of the commit whose write of `key` was folded directly onto the one at `commitIndex`. */
export function builtOnChildPosition(scope: PreparedRecordScope, key: string, commitIndex: number): number | undefined {
  return builtDirectlyOn(key, commitIndex, writersOf(scope.log, key), (position) => scope.log[position]);
}

/** The write of `key` that was folded directly onto the write at `commitIndex`: an edge to it, if there is one. */
export function builtOnChild(scope: PreparedRecordScope, key: string, commitIndex: number): GraphEdge | undefined {
  const over = builtOnChildPosition(scope, key, commitIndex);
  return over === undefined ? undefined : edgeTo(scope, key, over);
}
