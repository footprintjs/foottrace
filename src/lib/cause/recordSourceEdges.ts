import { sliceForKey } from '../slice/sliceForKey.js';
import { relation } from '../memory/keyPaths.js';
import { builtOnChildren, builtOnParent } from './recordBuiltOn.js';
import { collectControlChildCoverage, collectControlParentCoverage } from './recordControl.js';
import { collectScopeCoverage, recordGapCollector, writtenKeysForNode } from './recordCoverage.js';
import { nodeIdFor } from './recordIdentity.js';
import { readKeysForStage } from './recordScope.js';
import type { ExactRecordRead } from './recordSources.js';
import type { AddRecordGap, PreparedRecordScope, RecordInspection, ResolvedRecordNode } from './recordTypes.js';
import type { Adjacency, GapCode, GraphEdge } from './types.js';

function evidence(read: ExactRecordRead): string[] {
  return [
    ...(read.commitIdx === undefined ? [] : ['commit:' + read.commitIdx]),
    'read:' + read.occurrence.ordinal,
    // Long canonical attempts remain reachable through the original read ordinal; graph refs have a 512-character ceiling.
    ...(read.occurrence.attemptId && read.occurrence.attemptId.length <= 512 ? [read.occurrence.attemptId] : []),
  ];
}
/** An identity past the ID ceiling is invalid data, not a full list: only `'full'` stops a caller's loop. */
function append(edges: GraphEdge[], edge: GraphEdge, maximum: number): 'added' | 'invalid' | 'full' {
  if (edge.nodeId === 'record:invalid') return 'invalid';
  if (edges.length >= maximum) return 'full';
  edges.push(edge);
  return 'added';
}

/** An exact source proves a read by an execution; no occurrence-to-write join is recorded. */
export function inspectSourceParents(
  node: ResolvedRecordNode,
  maximum: number,
  extraGapCodes: readonly GapCode[] | undefined,
): RecordInspection {
  const { scope, identity, commitIndex } = node,
    sources = scope.readSources!,
    coverage = recordGapCollector();
  const first = scope.log.findIndex((bundle) => bundle.runtimeStageId === identity.runtimeStageId),
    bundle = scope.log[commitIndex];
  collectScopeCoverage(scope, bundle, extraGapCodes, coverage.addGap);
  for (const gap of sources.gaps) coverage.addGap(gap);
  collectControlParentCoverage(scope, identity, first, coverage.addGap);
  if (identity.key !== undefined && !identity.read) {
    const slice = sliceForKey(scope.log, identity.key, (id) => readKeysForStage(scope, id), {
      before: commitIndex + 1,
      maxDepth: 0,
      maxNodes: 1,
    });
    if (!slice.writer || scope.log.indexOf(slice.writer) !== commitIndex) {
      coverage.addGap('invalid-data');
      return { adjacency: { edges: [], complete: false }, gaps: coverage.gaps };
    }
  }
  const rows =
    identity.key === undefined ? [] : bundle.trace.filter((row) => relation(row.path, identity.key!) !== undefined);
  const keys =
    identity.read && identity.key !== undefined
      ? [identity.key]
      : identity.key === undefined
      ? readKeysForStage(scope, identity.runtimeStageId)
      : [...new Set(rows.flatMap((row) => row.readKeys ?? readKeysForStage(scope, identity.runtimeStageId)))];
  const reads = (sources.byOwner.get(identity.runtimeStageId) ?? []).filter(
    (read) =>
      read.occurrence.runtimeStageId === identity.runtimeStageId &&
      (identity.key === undefined || keys.includes(read.path) || keys.includes(read.occurrence.key)),
  );
  if (keys.some((key) => !reads.some((read) => read.path === key || read.occurrence.key === key)))
    coverage.addGap('unavailable');
  if (identity.key === undefined && !scope.sourceCoveredExecutions?.has(identity.runtimeStageId))
    coverage.addGap('not-collected');
  if (!sources.owners.has(identity.runtimeStageId) && keys.length) coverage.addGap('unavailable');
  if (identity.key !== undefined && !identity.read && (keys.length || rows.some((row) => row.readKeys === undefined)))
    coverage.addGap('conservative');
  const edges: GraphEdge[] = [];
  for (const read of reads) {
    if (read.commitIdx === undefined) continue;
    const added = append(
      edges,
      {
        nodeId: nodeIdFor(scope.address, {
          runtimeStageId: scope.log[read.commitIdx].runtimeStageId,
          commitIdx: read.commitIdx,
          key: read.path,
        }),
        kind: 'data',
        attribution: identity.key !== undefined && !identity.read ? 'stage' : 'recorded-read',
        evidence: evidence(read),
      },
      maximum,
    );
    if (added === 'invalid') coverage.addGap('invalid-data');
    if (added === 'full') {
      coverage.addGap('edge-limit');
      break;
    }
  }
  // A write that did not replace its key was folded onto what the commit before it had left. No read
  // occurrence says so; the record's rows do (`recordBuiltOn.ts`). A write folded onto the value from
  // before the run adds nothing here: with exact sources the pre-run state is a known end of the walk,
  // for a write as for a read of it (`docs/cause.md`), and not a gap.
  if (identity.key !== undefined && !identity.read) {
    const under = builtOnParent(scope, identity.key, commitIndex);
    if (under !== undefined && under !== 'pre-run' && !edges.some((edge) => edge.nodeId === under.nodeId)) {
      const added = append(edges, under, maximum);
      if (added === 'invalid') coverage.addGap('invalid-data');
      if (added === 'full') coverage.addGap('edge-limit');
    }
  }
  const deciderId = scope.control?.get(identity.runtimeStageId)?.deciderId;
  const parentIndex = scope.log.findIndex((entry) => entry.runtimeStageId === deciderId);
  if (deciderId && parentIndex >= 0 && parentIndex < first) {
    const added = append(
      edges,
      {
        nodeId: nodeIdFor(scope.address, { runtimeStageId: deciderId, commitIdx: parentIndex }),
        kind: 'control',
        attribution: 'recorded-control',
        evidence: ['commit:' + parentIndex],
      },
      maximum,
    );
    if (added === 'invalid') coverage.addGap('invalid-data');
    if (added === 'full') coverage.addGap('edge-limit');
  }
  collectSourceChildCoverage(node, first, maximum, coverage.addGap);
  return { adjacency: { edges, complete: coverage.gaps.length === 0 }, gaps: coverage.gaps };
}

/** Retain the adapter's shared immediate data/control adjacency cap and control-boundary gaps. */
function collectSourceChildCoverage(
  node: ResolvedRecordNode,
  firstCommitIndex: number,
  maximum: number,
  addGap: AddRecordGap,
): void {
  const { scope, identity } = node,
    children = sourceDataChildren(scope, node, maximum),
    neighbors = new Set(children.edges.map((_, index) => JSON.stringify(['data', index])));
  if (children.invalid) addGap('invalid-data');
  if (!children.complete) addGap('edge-limit');
  collectControlChildCoverage(scope, identity, firstCommitIndex, neighbors, addGap);
  if (neighbors.size > maximum) addGap('edge-limit');
}

/** Missing future source coverage limits impact without changing a complete backward explanation. */
export function sourceChildrenCollected(node: ResolvedRecordNode): boolean {
  const { scope, identity, commitIndex } = node;
  if (!writtenKeysForNode(scope.log[commitIndex], identity).length) return true;
  for (let index = commitIndex + 1; index < scope.log.length; index++)
    if (!scope.sourceCoveredExecutions?.has(scope.log[index].runtimeStageId)) return false;
  return true;
}

/**
 * Forward impact is the exact consuming execution, never an inferred output-write life. `complete: false` means
 * the edge list is full; `invalid` means an identity past the ID ceiling was left out, reported by the parent
 * inspection as `invalid-data`.
 */
export function sourceDataChildren(
  scope: PreparedRecordScope,
  node: ResolvedRecordNode,
  maximum: number,
): Adjacency & { readonly invalid: boolean } {
  const keys = writtenKeysForNode(scope.log[node.commitIndex], node.identity),
    edges: GraphEdge[] = [];
  let invalid = false;
  for (const read of scope.readSources!.byCommit.get(node.commitIndex) ?? []) {
    if (
      read.commitIdx !== node.commitIndex ||
      !keys.some((key) => {
        const position = relation(read.path, key);
        return position === 'exact' || position === 'inside';
      })
    )
      continue;
    const commitIdx = read.readerCommitIdx;
    const added = append(
      edges,
      {
        nodeId: nodeIdFor(scope.address, { runtimeStageId: read.occurrence.runtimeStageId, commitIdx }),
        kind: 'data',
        attribution: 'recorded-read',
        evidence: evidence(read),
      },
      maximum,
    );
    if (added === 'invalid') invalid = true;
    if (added === 'full') return { edges, complete: false, invalid };
  }
  // The writes that were folded onto this one: no read occurrence names them (`recordBuiltOn.ts`).
  for (const key of keys)
    for (const child of builtOnChildren(scope, key, node.commitIndex)) {
      if (edges.some((edge) => edge.nodeId === child.nodeId)) continue;
      const added = append(edges, child, maximum);
      if (added === 'invalid') invalid = true;
      if (added === 'full') return { edges, complete: false, invalid };
    }
  return { edges, complete: true, invalid };
}
