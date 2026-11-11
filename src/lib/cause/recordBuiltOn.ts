/**
 * recordBuiltOn.ts — the cause graph's edges for a write that did not replace its key.
 *
 * WHY THIS FILE EXISTS. A node of the cause graph is one commit's write of one key. When that write
 * merged into the value, appended to it or wrote a path inside it, the value it left is made of that
 * write and of what the commit before it had left (`memory/builtOn.ts`, the one rule). No read is
 * behind that dependence, so neither of the graph's two ways of finding parents sees it: not the
 * walk over recorded reads, and not the exact read sources. Both ask here, for the parent and, going
 * forward, for the children, so the two directions are each other's inverse by construction.
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
 * What the write of `key` at `commitIndex` was built on: an edge to that commit's write of the key;
 * `'pre-run'` when it was folded onto the value from before the run (no node to point at); `undefined`
 * when the write replaced the value.
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

/** The ARRAY positions of the commits whose write of `key` was built directly on the write at `commitIndex`. */
export function builtOnChildPositions(scope: PreparedRecordScope, key: string, commitIndex: number): number[] {
  return builtDirectlyOn(key, commitIndex, writersOf(scope.log, key), (position) => scope.log[position]);
}

/** The writes of `key` that were built directly on the write at `commitIndex`: one edge to each. */
export function builtOnChildren(scope: PreparedRecordScope, key: string, commitIndex: number): GraphEdge[] {
  return builtOnChildPositions(scope, key, commitIndex).map((position) => edgeTo(scope, key, position));
}
