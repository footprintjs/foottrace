import type { LogAddress } from '../memory/eventPosition.js';
import { childrenForRecordNode } from './recordChildren.js';
import { attentionForRecordNode, gapForRecordFailure } from './recordCoverage.js';
import { nodeIdFor, resolveRecordNode } from './recordIdentity.js';
import { createRecordScopeLoader, openRecordScope } from './recordLoading.js';
import { inspectRecordNode } from './recordParents.js';
import { recordOptions } from './recordScope.js';
import type {
  RecordCauseGraph,
  RecordGraphOptions,
  RecordLoaderResult,
  RecordNode,
  RecordScope,
} from './recordTypes.js';
import { addressKey, addressOf, list, own, RecordRefusal } from './recordValidation.js';
import type { GraphContext, NodeId } from './types.js';

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
  const resolve = (nodeId: NodeId, context: GraphContext) => resolveRecordNode(nodeId, context, loader);
  return Object.freeze({
    nodeId: (address: LogAddress, node: RecordNode) => nodeIdFor(address, node),
    openScope: (address: LogAddress, context: GraphContext) => openRecordScope(address, context, loader),
    async parents(nodeId: NodeId, context: GraphContext) {
      const node = await resolve(nodeId, context);
      return 'failure' in node
        ? { edges: [], complete: false }
        : inspectRecordNode(node, limits.maxEdges, loader.extraGapCodes(node.scope)).adjacency;
    },
    async gaps(nodeId: NodeId, context: GraphContext) {
      const node = await resolve(nodeId, context);
      return 'failure' in node
        ? gapForRecordFailure(node.failure)
        : inspectRecordNode(node, limits.maxEdges, loader.extraGapCodes(node.scope)).gaps;
    },
    async attention(nodeId: NodeId, context: GraphContext) {
      return attentionForRecordNode(await resolve(nodeId, context));
    },
    async children(nodeId: NodeId, context: GraphContext) {
      const node = await resolve(nodeId, context);
      return 'failure' in node
        ? { edges: [], complete: false }
        : childrenForRecordNode(node, limits.maxEdges, loader.extraGapCodes(node.scope));
    },
  });
}

/** A finished record already in memory; payload admission is lazy per requested scope. */
export function createRecordGraph(scopes: readonly RecordScope[], options: RecordGraphOptions = {}): RecordCauseGraph {
  const limits = recordOptions(options);
  return createLazyRecordGraph((address) => {
    for (const raw of list(scopes, limits.maxScopes)) {
      if (addressKey(addressOf(own(raw, 'address'))) === addressKey(address)) return { scope: raw as RecordScope };
    }
    throw new RecordRefusal('unavailable');
  }, limits);
}
