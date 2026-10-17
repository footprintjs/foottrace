import { causalChain, type CausalEdge } from '../memory/backtrack.js';
import { findLastWriter } from '../memory/commitLogUtils.js';
import { sliceForKey } from '../slice/sliceForKey.js';
import { collectControlParentCoverage, controlParentLookup } from './recordControl.js';
import {
  collectForwardCoverage,
  collectReadCoverage,
  collectScopeCoverage,
  readAttributionIsPrecise,
  recordGapCollector,
} from './recordCoverage.js';
import { nodeIdFor } from './recordIdentity.js';
import { readKeysForStage } from './recordScope.js';
import type { AddRecordGap, PreparedRecordScope, RecordInspection, ResolvedRecordNode } from './recordTypes.js';
import type { Gap, GraphEdge } from './types.js';

/** Anchor writers before the execution so later commits cannot rewrite the recorded causal edge. */
function projectParentEdges(
  scope: PreparedRecordScope,
  parentEdges: readonly CausalEdge[],
  firstCommitIndex: number,
  precise: boolean,
  maximumEdges: number,
  addGap: AddRecordGap,
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const edge of parentEdges) {
    if (edges.length >= maximumEdges) {
      addGap('edge-limit');
      break;
    }
    const writer =
      edge.kind === 'data' && edge.key
        ? findLastWriter(scope.log, edge.key, firstCommitIndex)
        : scope.log.find((bundle) => bundle.runtimeStageId === edge.parent.runtimeStageId);
    if (!writer) {
      addGap('untracked-input');
      continue;
    }
    const writerIndex = scope.log.indexOf(writer);
    edges.push({
      nodeId: nodeIdFor(scope.address, {
        runtimeStageId: writer.runtimeStageId,
        commitIdx: writerIndex,
        ...(edge.kind === 'data' && edge.key ? { key: edge.key } : {}),
      }),
      kind: edge.kind,
      attribution: edge.kind === 'control' ? 'recorded-control' : precise ? 'per-write' : 'stage',
      evidence: ['commit:' + writerIndex],
    });
    if (edge.basis) addGap('conservative');
  }
  return edges;
}

/** Derive parent adjacency and its ordered gaps together from the same bounded canonical query. */
export function inspectRecordNode(
  node: ResolvedRecordNode,
  maximumEdges: number,
  extraGapCodes: readonly Gap['code'][] | undefined,
): RecordInspection {
  const { scope, identity, commitIndex } = node;
  const bundle = scope.log[commitIndex],
    firstCommitIndex = scope.log.findIndex((entry) => entry.runtimeStageId === identity.runtimeStageId),
    coverage = recordGapCollector();
  collectScopeCoverage(scope, bundle, extraGapCodes, coverage.addGap);
  const lookup = (runtimeStageId: string) => readKeysForStage(scope, runtimeStageId);
  collectForwardCoverage(scope, identity, commitIndex, firstCommitIndex, maximumEdges, coverage.addGap);
  const precise = readAttributionIsPrecise(scope, identity, bundle);
  collectReadCoverage(scope, identity, precise, coverage.addGap);
  collectControlParentCoverage(scope, identity, firstCommitIndex, coverage.addGap);
  const control = controlParentLookup(scope);
  const slice =
    identity.key === undefined || identity.read
      ? undefined
      : sliceForKey(scope.log, identity.key, lookup, {
          before: commitIndex + 1,
          maxDepth: 1,
          maxNodes: maximumEdges + 1,
          controlDeps: control,
        });
  if (
    identity.key !== undefined &&
    !identity.read &&
    (!slice?.writer || scope.log.indexOf(slice.writer) !== commitIndex)
  ) {
    coverage.addGap('invalid-data');
    return { adjacency: { edges: [], complete: false }, gaps: coverage.gaps };
  }
  // Read-only identities retain both the read's data writer and the execution's recorded control parent.
  const root =
    identity.read && identity.key !== undefined
      ? causalChain(
          scope.log,
          identity.runtimeStageId,
          (runtimeStageId) => (runtimeStageId === identity.runtimeStageId ? [identity.key!] : lookup(runtimeStageId)),
          { maxDepth: 1, maxNodes: maximumEdges + 1, controlDeps: control },
        )
      : slice?.root ??
        (identity.key === undefined
          ? causalChain(scope.log, identity.runtimeStageId, lookup, {
              maxDepth: 1,
              maxNodes: maximumEdges + 1,
              controlDeps: control,
            })
          : undefined);
  if (root?.preRunReads?.keys.length) coverage.addGap('untracked-input');
  if (root?.truncated?.byNodes) coverage.addGap('edge-limit');
  for (const note of slice?.notes ?? [])
    if (note.code === 'redacted') coverage.addGap('redacted');
    else if (note.code === 'nested-rows' || note.code === 'from-initial-state') coverage.addGap('conservative');
  const edges = projectParentEdges(
    scope,
    root?.parentEdges ?? [],
    firstCommitIndex,
    precise,
    maximumEdges,
    coverage.addGap,
  );
  return { adjacency: { edges, complete: coverage.gaps.length === 0 }, gaps: coverage.gaps };
}
