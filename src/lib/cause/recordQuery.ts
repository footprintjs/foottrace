import { queryMemo } from './queryMemo.js';
import { resolveRecordNode } from './recordIdentity.js';
import { inspectRecordNode } from './recordInspection.js';
import { subflowParents } from './recordSubflowGraph.js';
import { recordGapEvidence } from './recordGapEvidence.js';
import type { RecordLoadFailure, RecordScopeLoader, ResolvedRecordNode } from './recordTypes.js';
import type { GraphContext, NodeId } from './types.js';

/** Both dependency directions share the same admitted node and canonical inspection within a query. */
export function createRecordQuery(loader: RecordScopeLoader, maximumEdges: number) {
  const resolutionOwner = {},
    inspectionOwner = {},
    boundaryOwner = {};
  const inspectLocal = (node: ResolvedRecordNode, context: GraphContext) => {
    const inspect = () => inspectRecordNode(node, maximumEdges, loader.extraGapCodes(node.scope));
    return queryMemo(context)?.remember(inspectionOwner, node, inspect) ?? inspect();
  };
  return {
    resolve(nodeId: NodeId, context: GraphContext) {
      const resolve = () => resolveRecordNode(nodeId, context, loader),
        memo = queryMemo(context);
      // A retained success must never bypass the loader's existing cancellation check.
      return memo && !context.signal.aborted ? memo.remember(resolutionOwner, nodeId, resolve) : resolve();
    },
    inspect: inspectLocal,
    parents(node: ResolvedRecordNode, context: GraphContext) {
      const inspect = async () => {
        const local = inspectLocal(node, context);
        const cross = await subflowParents(node, context, loader, maximumEdges);
        const coverage = recordGapEvidence();
        for (const gap of local.gaps) coverage.addGap(gap);
        for (const gap of cross.gaps) coverage.addGap(gap);
        const edges = [...local.adjacency.edges];
        for (const edge of cross.adjacency.edges)
          if (!edges.some((other) => other.nodeId === edge.nodeId && other.kind === edge.kind)) edges.push(edge);
        if (edges.length > maximumEdges) coverage.addGap({ code: 'edge-limit', evidence: [] });
        const gaps = coverage.gaps;
        return {
          adjacency: {
            edges: edges.slice(0, maximumEdges),
            complete: local.adjacency.complete && cross.adjacency.complete && gaps.length === 0,
          },
          gaps,
        };
      };
      return queryMemo(context)?.remember(boundaryOwner, node, inspect) ?? inspect();
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
