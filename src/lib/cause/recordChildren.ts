import { forwardSliceForKey } from '../slice/forwardSliceForKey.js';
import type { ForwardNode } from '../slice/types.js';
import { appendControlChildren } from './recordControl.js';
import { allStageReadsCollected, writtenKeysForNode } from './recordCoverage.js';
import { nodeIdFor } from './recordIdentity.js';
import { readKeysForStage } from './recordScope.js';
import type { PreparedRecordScope, RecordIdentity, RecordInspection, ResolvedRecordNode } from './recordTypes.js';
import type { Adjacency, GraphEdge } from './types.js';

/** Keep per-write and conservative fed edges distinct while retaining existing cap and deduplication order. */
function appendFedChildren(
  scope: PreparedRecordScope,
  root: ForwardNode,
  maximumEdges: number,
  edges: GraphEdge[],
): boolean {
  let complete = true;
  for (const edge of root.fedEdges) {
    const child = edge.child;
    if (child.commitIdx === undefined || !child.runtimeStageId) {
      complete = false;
      continue;
    }
    if (edges.length >= maximumEdges) {
      complete = false;
      break;
    }
    const nodeId = nodeIdFor(scope.address, {
      runtimeStageId: child.runtimeStageId,
      commitIdx: child.commitIdx,
      key: child.key,
    });
    if (!edges.some((existing) => existing.nodeId === nodeId))
      edges.push({ nodeId, kind: 'data', attribution: edge.basis, evidence: ['commit:' + child.commitIdx] });
    if (edge.basis === 'stage') complete = false;
  }
  return complete;
}

/** A consumer with no writes still needs a qualified node so its recorded control flow remains reachable. */
function appendReadOnlyChildren(
  scope: PreparedRecordScope,
  root: ForwardNode,
  key: string,
  maximumEdges: number,
  edges: GraphEdge[],
): boolean {
  let complete = true;
  for (const read of root.reads) {
    if (scope.log[read.commitIdx]?.trace.length) continue;
    if (edges.length >= maximumEdges) {
      complete = false;
      break;
    }
    const nodeId = nodeIdFor(
      scope.address,
      { runtimeStageId: read.runtimeStageId, commitIdx: read.commitIdx, key },
      true,
    );
    if (!edges.some((existing) => existing.nodeId === nodeId))
      edges.push({ nodeId, kind: 'data', attribution: 'per-write', evidence: ['commit:' + read.commitIdx] });
  }
  return complete;
}

/** Query each written value at its original commit boundary instead of the value's latest writer. */
function appendDataChildren(
  scope: PreparedRecordScope,
  identity: RecordIdentity,
  commitIndex: number,
  maximumEdges: number,
  edges: GraphEdge[],
): boolean {
  let complete = true;
  const lookup = (runtimeStageId: string) => readKeysForStage(scope, runtimeStageId);
  for (const key of writtenKeysForNode(scope.log[commitIndex], identity)) {
    const forward = forwardSliceForKey(scope.log, key, lookup, {
      before: commitIndex + 1,
      maxDepth: 1,
      maxNodes: maximumEdges + 1,
    });
    if (forward.root?.truncated?.byNodes) complete = false;
    if (forward.root?.commitIdx !== commitIndex) {
      complete = false;
      continue;
    }
    complete = appendFedChildren(scope, forward.root, maximumEdges, edges) && complete;
    complete = appendReadOnlyChildren(scope, forward.root, key, maximumEdges, edges) && complete;
  }
  return complete;
}

/** Share parent-side coverage checks before appending data then control children in their established order. */
export function childrenForRecordNode(
  node: ResolvedRecordNode,
  maximumEdges: number,
  inspection: RecordInspection,
): Adjacency {
  const { scope, identity, commitIndex } = node;
  const edges: GraphEdge[] = [];
  let complete = inspection.gaps.length === 0;
  if (!allStageReadsCollected(scope)) complete = false;
  complete = appendDataChildren(scope, identity, commitIndex, maximumEdges, edges) && complete;
  complete = appendControlChildren(scope, identity, commitIndex, maximumEdges, edges) && complete;
  return { edges, complete };
}
