import { queryMemo } from './queryMemo.js';
import { resolveRecordNode } from './recordIdentity.js';
import { inspectRecordNode } from './recordInspection.js';
import type { RecordLoadFailure, RecordScopeLoader, ResolvedRecordNode } from './recordTypes.js';
import type { GraphContext, NodeId } from './types.js';

/** Both dependency directions share the same admitted node and canonical inspection within a query. */
export function createRecordQuery(loader: RecordScopeLoader, maximumEdges: number) {
  const resolutionOwner = {},
    inspectionOwner = {};
  return {
    resolve(nodeId: NodeId, context: GraphContext) {
      const resolve = () => resolveRecordNode(nodeId, context, loader),
        memo = queryMemo(context);
      // A retained success must never bypass the loader's existing cancellation check.
      return memo && !context.signal.aborted ? memo.remember(resolutionOwner, nodeId, resolve) : resolve();
    },
    inspect(node: ResolvedRecordNode, context: GraphContext) {
      const inspect = () => inspectRecordNode(node, maximumEdges, loader.extraGapCodes(node.scope));
      return queryMemo(context)?.remember(inspectionOwner, node, inspect) ?? inspect();
    },
  };
}

/** Every port maps the same fixed loading failure while projecting only admitted nodes. */
export function whenResolved<T>(
  node: ResolvedRecordNode | RecordLoadFailure,
  onNode: (node: ResolvedRecordNode) => T,
  onFailure: (failure: RecordLoadFailure) => T,
): T {
  return 'failure' in node ? onFailure(node) : onNode(node);
}
