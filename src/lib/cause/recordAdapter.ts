import type { LogAddress } from '../memory/eventPosition.js';
import { childrenForRecordNode } from './recordChildren.js';
import { attentionForRecordNode, gapForRecordFailure } from './recordCoverage.js';
import { nodeIdFor } from './recordIdentity.js';
import { createRecordScopeLoader, openRecordScope } from './recordLoading.js';
import { createRecordQuery, whenResolved } from './recordQuery.js';
import { recordOptions } from './recordScope.js';
import type {
  RecordCauseGraph,
  RecordGraphOptions,
  RecordLoaderResult,
  RecordNode,
  RecordScope,
} from './recordTypes.js';
import { addressKey, addressOf, recordList, recordOwn, RecordRefusal } from './recordValidation.js';
import type { Adjacency, GraphContext, NodeId } from './types.js';

/** Give each failed port its own incomplete page rather than sharing a mutable edge array. */
const unavailableAdjacency = (): Adjacency => ({ edges: [], complete: false });

export type {
  RecordCauseGraph,
  RecordGraphOptions,
  RecordLoaderResult,
  RecordNode,
  RecordScope,
} from './recordTypes.js';
export { recordOptions } from './recordScope.js';

/** Common engine for memory and one-scope-at-a-time host storage. Loader functions are trusted executable code. */
export function createLazyRecordGraph(
  load: (address: LogAddress, context: GraphContext) => RecordLoaderResult | Promise<RecordLoaderResult>,
  options: RecordGraphOptions = {},
): RecordCauseGraph {
  const limits = recordOptions(options),
    loader = createRecordScopeLoader(load, limits);
  const query = createRecordQuery(loader, limits.maxEdges);
  return Object.freeze({
    nodeId: (address: LogAddress, node: RecordNode) => nodeIdFor(address, node),
    openScope: (address: LogAddress, context: GraphContext) => openRecordScope(address, context, loader),
    async parents(nodeId: NodeId, context: GraphContext) {
      return whenResolved(
        await query.resolve(nodeId, context),
        (node) => query.inspect(node, context).adjacency,
        unavailableAdjacency,
      );
    },
    async gaps(nodeId: NodeId, context: GraphContext) {
      return whenResolved(
        await query.resolve(nodeId, context),
        (node) => query.inspect(node, context).gaps,
        (failure) => gapForRecordFailure(failure.failure),
      );
    },
    async attention(nodeId: NodeId, context: GraphContext) {
      return whenResolved(await query.resolve(nodeId, context), attentionForRecordNode, () => []);
    },
    async children(nodeId: NodeId, context: GraphContext) {
      return whenResolved(
        await query.resolve(nodeId, context),
        (node) => childrenForRecordNode(node, limits.maxEdges, query.inspect(node, context)),
        unavailableAdjacency,
      );
    },
  });
}

/** A finished record already in memory; payload admission is lazy per requested scope. */
export function createRecordGraph(scopes: readonly RecordScope[], options: RecordGraphOptions = {}): RecordCauseGraph {
  const limits = recordOptions(options);
  return createLazyRecordGraph((address) => {
    for (const raw of recordList(scopes, limits.maxScopes)) {
      if (addressKey(addressOf(recordOwn(raw, 'address'))) === addressKey(address))
        return { scope: raw as RecordScope };
    }
    throw new RecordRefusal('unavailable');
  }, limits);
}
