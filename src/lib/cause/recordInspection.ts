import { inspectSourceParents } from './recordSourceEdges.js';
import { causalChain, type CausalEdge } from '../memory/backtrack.js';
import { lastWriterPosition } from '../memory/commitLogUtils.js';
import { type ReadWindow, readSourcesOf } from '../memory/readWindow.js';
import { windowOf } from '../memory/windowPlacement.js';
import { sliceForKey } from '../slice/sliceForKey.js';
import { collectControlParentCoverage, controlParentLookup } from './recordControl.js';
import {
  collectForwardCoverage,
  collectReadCoverage,
  collectScopeCoverage,
  readAttributionIsPrecise,
  recordGapCollector,
} from './recordCoverage.js';
import { builtOnParent } from './recordBuiltOn.js';
import { nodeIdFor } from './recordIdentity.js';
import { readKeysForStage } from './recordScope.js';
import type { AddRecordGap, PreparedRecordScope, RecordInspection, ResolvedRecordNode } from './recordTypes.js';
import type { Gap, GraphEdge } from './types.js';

/**
 * The commits one causal edge points at. An edge names an EXECUTION; a graph node is one commit of it. The
 * rule that made a data edge says which (`memory/readWindow.ts`): the last writer before the step began, or,
 * for an edge marked `'written-while-running'`, each commit of that execution that wrote the key inside
 * the step's read window.
 */
function writerPositions(scope: PreparedRecordScope, edge: CausalEdge, window: ReadWindow): number[] {
  if (edge.kind !== 'data' || !edge.key) {
    const at = scope.log.findIndex((bundle) => bundle.runtimeStageId === edge.parent.runtimeStageId);
    return at < 0 ? [] : [at];
  }
  const sources = readSourcesOf(edge.key, window, (key, before) => lastWriterPosition(scope.log, key, before));
  if (edge.overlap !== 'written-while-running') return sources.before < 0 ? [] : [sources.before];
  return sources.during.filter((at) => scope.log[at].runtimeStageId === edge.parent.runtimeStageId);
}

/** A node's read and control parents, and which of those nodes only a POSSIBLE read named. */
interface ProjectedParents {
  readonly edges: GraphEdge[];
  /** Node ids every edge to which came from a read that is a possible source, not a certain one. */
  readonly onlyPossible: ReadonlySet<string>;
}

/** Anchor writers before the execution so later commits cannot rewrite the recorded causal edge. */
function projectParentEdges(
  scope: PreparedRecordScope,
  parentEdges: readonly CausalEdge[],
  firstCommitIndex: number,
  precise: boolean,
  maximumEdges: number,
  addGap: AddRecordGap,
): ProjectedParents {
  const edges: GraphEdge[] = [];
  const possible = new Set<string>();
  const certain = new Set<string>();
  const projected = (): ProjectedParents => ({
    edges,
    onlyPossible: new Set([...possible].filter((id) => !certain.has(id))),
  });
  // When this step looked at state: placed once for the node, then asked per edge.
  const window = windowOf(scope.log, firstCommitIndex);
  for (const edge of parentEdges) {
    if (edges.length >= maximumEdges) {
      addGap('edge-limit');
      break;
    }
    const positions = writerPositions(scope, edge, window);
    if (positions.length === 0) {
      addGap('untracked-input');
      continue;
    }
    for (const writerIndex of positions) {
      if (edges.length >= maximumEdges) {
        addGap('edge-limit');
        return projected();
      }
      const nodeId = nodeIdFor(scope.address, {
        runtimeStageId: scope.log[writerIndex].runtimeStageId,
        commitIdx: writerIndex,
        ...(edge.kind === 'data' && edge.key ? { key: edge.key } : {}),
      });
      edges.push({
        nodeId,
        kind: edge.kind,
        attribution: edge.kind === 'control' ? 'recorded-control' : precise ? 'per-write' : 'stage',
        evidence: ['commit:' + writerIndex],
      });
      if (edge.kind === 'data') (edge.overlap ? possible : certain).add(nodeId);
    }
    // A source that is only possible (`CausalEdge.overlap`): the ancestry is a superset, as for a nested row.
    if (edge.basis || edge.overlap) addGap('conservative');
  }
  return projected();
}

/**
 * The write this node's own write was folded onto, when it did not replace the key
 * (`recordBuiltOn.ts`): asked for the node's own COMMIT, never read off the step-level walk.
 *
 * WHY NOT THE WALK'S `builtOn` EDGES. The walk answers in steps. It draws no edge from a step to its
 * own earlier commit, and it lets a certain read of the key from the same STEP stand in for this
 * link. A node here is a commit: a step's later commit was folded onto its earlier one, and a read
 * can be of one commit of a step while the write was folded onto another. Read off the walk, the
 * way back to such a commit was missing, though the forward walk reached readers from it.
 *
 * One edge per node. Where a read already names that write:
 *   - a CERTAIN read keeps its edge as it is. A step that read the key and then added to it
 *     (`scope.box.b = 2`) is answered as it always was, byte for byte;
 *   - a read that is only a POSSIBLE source gives its place to this edge, which is certain. The
 *     node keeps the `conservative` gap that read brought: its other sources are still only possible.
 *
 * A write folded onto the value from before the run has no node to point at and adds no gap of its
 * own: the node already carries `conservative` for a value with no whole write in range (the
 * `'from-initial-state'` note of its slice), as it did before this edge existed.
 */
function addBuiltOnParent(
  scope: PreparedRecordScope,
  key: string,
  commitIndex: number,
  parents: ProjectedParents,
  maximumEdges: number,
  addGap: AddRecordGap,
): void {
  const under = builtOnParent(scope, key, commitIndex);
  if (under === undefined || under === 'pre-run') return;
  const named = parents.edges.findIndex((edge) => edge.kind === 'data' && edge.nodeId === under.nodeId);
  if (named >= 0) {
    if (parents.onlyPossible.has(under.nodeId)) parents.edges[named] = under;
  } else if (parents.edges.length >= maximumEdges) addGap('edge-limit');
  else parents.edges.push(under);
}

/** Derive parent adjacency and its ordered gaps together from the same bounded canonical query. */
export function inspectRecordNode(
  node: ResolvedRecordNode,
  maximumEdges: number,
  extraGapCodes: readonly Gap['code'][] | undefined,
): RecordInspection {
  const { scope, identity, commitIndex } = node;
  if (scope.readSources) return inspectSourceParents(node, maximumEdges, extraGapCodes);
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
  // The walk's own `builtOn` edges are left out: they are step-level (`addBuiltOnParent` says why).
  const parents = projectParentEdges(
    scope,
    (root?.parentEdges ?? []).filter((edge) => edge.builtOn === undefined),
    firstCommitIndex,
    precise,
    maximumEdges,
    coverage.addGap,
  );
  if (identity.key !== undefined && !identity.read) {
    addBuiltOnParent(scope, identity.key, commitIndex, parents, maximumEdges, coverage.addGap);
  }
  return { adjacency: { edges: parents.edges, complete: coverage.gaps.length === 0 }, gaps: coverage.gaps };
}
