import { captureCoverage, type CaptureQuery } from './recordCapture.js';
import type { LogAddress } from '../memory/eventPosition.js';
import { childrenForRecordNode } from './recordChildren.js';
import { attentionForRecordNode, gapForRecordFailure } from './recordCoverage.js';
import { nodeIdFor } from './recordIdentity.js';
import { createRecordScopeLoader, openRecordScope } from './recordLoading.js';
import { createRecordQuery, whenResolved } from './recordQuery.js';
import { withSourceLinkPage } from './sourceLinks/page.js';
import { createSourceLinkProjection } from './sourceLinks/project.js';
import { subflowChildren } from './recordSubflowGraph.js';
import { recordOptions } from './recordScope.js';
import { truncatedRecordRead, withRecordValueFallback, withRecordValueReads } from './recordValueWork.js';
import type {
  CaptureAwareRecordGraph,
  RecordGraphOptions,
  RecordLoaderResult,
  RecordLoadFailure,
  RecordNode,
  RecordScope,
} from './recordTypes.js';
import { addressKey, addressOf, recordList, recordOwn, RecordRefusal } from './recordValidation.js';
import type { Adjacency, GraphContext, NodeId } from './types.js';

/** Give each failed port its own incomplete page rather than sharing a mutable edge array. */
const unavailableAdjacency = (failure: RecordLoadFailure): Adjacency => ({
  edges: [],
  complete: false,
  ...(failure.scopeLoadFailed ? { gaps: gapForRecordFailure(failure.failure) } : {}),
});

export type {
  CaptureAwareRecordGraph,
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
): CaptureAwareRecordGraph {
  const limits = recordOptions(options),
    loader = createRecordScopeLoader(load, limits);
  const query = createRecordQuery(loader, limits.maxEdges, limits.maxFields);
  const linksFor = createSourceLinkProjection(limits.sourceLinkPolicy, limits.maxFields);
  return Object.freeze({
    nodeId: (address: LogAddress, node: RecordNode) => nodeIdFor(address, node),
    captureCoverage: (address: LogAddress, query: CaptureQuery, context: GraphContext) =>
      captureCoverage(loader, address, query, context),
    openScope: (address: LogAddress, context: GraphContext) => openRecordScope(address, context, loader),
    async parents(nodeId: NodeId, context: GraphContext) {
      return whenResolved<Promise<Adjacency>>(
        await query.resolve(nodeId, context),
        async (node) => {
          const { adjacency } = await query.parents(node, context);
          return adjacency.gaps ? adjacency : withSourceLinkPage(adjacency, linksFor(node, context, 'parents'));
        },
        async (failure) => unavailableAdjacency(failure),
      );
    },
    async gaps(nodeId: NodeId, context: GraphContext) {
      return whenResolved(
        await query.resolve(nodeId, context),
        async (node) => (await query.parents(node, context)).gaps,
        async (failure) => gapForRecordFailure(failure.failure),
      );
    },
    async attention(nodeId: NodeId, context: GraphContext) {
      return whenResolved(await query.resolve(nodeId, context), attentionForRecordNode, () => []);
    },
    async children(nodeId: NodeId, context: GraphContext) {
      return whenResolved(
        await query.resolve(nodeId, context),
        async (node) => {
          const inspection = query.inspect(node, context);
          if (inspection.adjacency.gaps) return inspection.adjacency;
          const local = withRecordValueFallback(
            () =>
              withRecordValueReads(node.scope.log, limits.maxFields, () =>
                childrenForRecordNode(node, limits.maxEdges, inspection),
              ),
            () => truncatedRecordRead().adjacency,
          );
          if (local.gaps) return local;
          const adjacency = await subflowChildren(node, context, loader, limits.maxEdges, local);
          return withSourceLinkPage(adjacency, linksFor(node, context, 'children'));
        },
        async (failure) => unavailableAdjacency(failure),
      );
    },
  });
}

/** A finished record already in memory; payload admission is lazy per requested scope. */
export function createRecordGraph(
  scopes: readonly RecordScope[],
  options: RecordGraphOptions = {},
): CaptureAwareRecordGraph {
  const limits = recordOptions(options);
  return createLazyRecordGraph((address) => {
    for (const raw of recordList(scopes, limits.maxScopes)) {
      if (addressKey(addressOf(recordOwn(raw, 'address'))) === addressKey(address))
        return { scope: raw as RecordScope };
    }
    throw new RecordRefusal('unavailable');
  }, limits);
}
