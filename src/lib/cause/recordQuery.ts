import { queryMemo } from './queryMemo.js';
import { resolveRecordNode } from './recordIdentity.js';
import { inspectRecordNode } from './recordInspection.js';
import { subflowParents } from './recordSubflowGraph.js';
import type { RecordLoadFailure, RecordScopeLoader, ResolvedRecordNode } from './recordTypes.js';
import type { Gap, GraphContext, NodeId } from './types.js';

/** Keep both local and boundary references when they describe the same coverage gap. */
function mergedGaps(local: readonly Gap[], boundary: readonly Gap[]): Gap[] {
  const gaps = local.map((gap) => ({ ...gap, evidence: [...gap.evidence] }));
  let truncated = false;
  for (const gap of boundary) {
    const found = gaps.find((other) => other.code === gap.code && other.nodeId === gap.nodeId);
    if (!found) {
      gaps.push({ ...gap, evidence: [...gap.evidence] });
      continue;
    }
    for (const reference of gap.evidence) {
      if (found.evidence.includes(reference)) continue;
      if (found.evidence.length >= 32) truncated = true;
      else found.evidence.push(reference);
    }
  }
  if (truncated && !gaps.some((gap) => gap.code === 'truncated')) gaps.push({ code: 'truncated', evidence: [] });
  return gaps;
}

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
        const gaps = mergedGaps(local.gaps, cross.gaps);
        const edges = [...local.adjacency.edges];
        for (const edge of cross.adjacency.edges)
          if (!edges.some((other) => other.nodeId === edge.nodeId && other.kind === edge.kind)) edges.push(edge);
        if (edges.length > maximumEdges && !gaps.some((gap) => gap.code === 'edge-limit'))
          gaps.push({ code: 'edge-limit', evidence: [] });
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
