import { sliceForKey } from '../slice/sliceForKey.js';
import { relation } from '../memory/keyPaths.js';
import { collectControlChildCoverage, collectControlParentCoverage } from './recordControl.js';
import { collectScopeCoverage, recordGapCollector, writtenKeysForNode } from './recordCoverage.js';
import { nodeIdFor } from './recordIdentity.js';
import { readKeysForStage } from './recordScope.js';
import type { ExactRecordRead } from './recordSources.js';
import type { AddRecordGap, PreparedRecordScope, RecordInspection, ResolvedRecordNode } from './recordTypes.js';
import type { Adjacency, GapCode, GraphEdge } from './types.js';
import { writePrefixKey, writePrefixReads, writePrefixesForRead } from '../read-sources/write-prefixes/admit.js';

function evidence(read: ExactRecordRead): string[] {
  return [
    ...(read.commitIdx === undefined ? [] : ['commit:' + read.commitIdx]),
    'read:' + read.occurrence.ordinal,
    // Long canonical attempts remain reachable through the original read ordinal; graph refs have a 512-character ceiling.
    ...(read.occurrence.attemptId && read.occurrence.attemptId.length <= 512 ? [read.occurrence.attemptId] : []),
  ];
}
function append(edges: GraphEdge[], edge: GraphEdge, maximum: number): boolean {
  if (edge.nodeId === 'record:invalid') return false;
  if (edges.length >= maximum) return false;
  edges.push(edge);
  return true;
}

/** Exact sources prove execution reads; opted-in prefixes narrow possible output contributors. */
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
  let reads = (sources.byOwner.get(identity.runtimeStageId) ?? []).filter(
    (read) =>
      read.occurrence.runtimeStageId === identity.runtimeStageId &&
      (identity.key === undefined || keys.includes(read.path) || keys.includes(read.occurrence.key)),
  );
  let prefixEvidence: string | undefined;
  let prefixCount: number | undefined;
  if (identity.key !== undefined && !identity.read && sources.writePrefixes) {
    const selected = bundle.trace.map((row, index) => ({ row, index })).filter(({ row }) => row.path === identity.key);
    const prefix =
      selected.length === 1
        ? sources.writePrefixes.writes.get(writePrefixKey(commitIndex, selected[0].index))
        : undefined;
    if (prefix?.status === 'observed') {
      const subset = writePrefixReads(sources.writePrefixes, prefix, maximum);
      reads = [...subset.reads];
      prefixEvidence = 'write-prefix:' + writePrefixKey(commitIndex, selected[0].index);
      prefixCount = prefix.count;
      if (!subset.complete) coverage.addGap('unavailable');
      if (subset.reads.length >= maximum && prefix.count > maximum) coverage.addGap('edge-limit');
    } else coverage.addGap(prefix ? 'unsupported' : 'not-collected');
  }
  if (!prefixEvidence && keys.some((key) => !reads.some((read) => read.path === key || read.occurrence.key === key)))
    coverage.addGap('unavailable');
  if (identity.key === undefined && !scope.sourceCoveredExecutions?.has(identity.runtimeStageId))
    coverage.addGap('not-collected');
  if (!sources.owners.has(identity.runtimeStageId) && keys.length) coverage.addGap('unavailable');
  if (
    identity.key !== undefined &&
    !identity.read &&
    (prefixCount === undefined ? keys.length || rows.some((row) => row.readKeys === undefined) : prefixCount > 0)
  )
    coverage.addGap('conservative');
  const edges: GraphEdge[] = [];
  for (const read of reads) {
    if (read.commitIdx === undefined) continue;
    if (
      !append(
        edges,
        {
          nodeId: nodeIdFor(scope.address, {
            runtimeStageId: scope.log[read.commitIdx].runtimeStageId,
            commitIdx: read.commitIdx,
            key: read.path,
          }),
          kind: 'data',
          attribution: prefixEvidence
            ? 'per-write'
            : identity.key !== undefined && !identity.read
            ? 'stage'
            : 'recorded-read',
          evidence: [...evidence(read), ...(prefixEvidence ? [prefixEvidence] : [])],
        },
        maximum,
      )
    ) {
      coverage.addGap('edge-limit');
      break;
    }
  }
  const deciderId = scope.control?.get(identity.runtimeStageId)?.deciderId;
  const parentIndex = scope.log.findIndex((entry) => entry.runtimeStageId === deciderId);
  if (
    deciderId &&
    parentIndex >= 0 &&
    parentIndex < first &&
    !append(
      edges,
      {
        nodeId: nodeIdFor(scope.address, { runtimeStageId: deciderId, commitIdx: parentIndex }),
        kind: 'control',
        attribution: 'recorded-control',
        evidence: ['commit:' + parentIndex],
      },
      maximum,
    )
  )
    coverage.addGap('edge-limit');
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
  if (children.truncated) addGap('edge-limit');
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

/** Exact consuming executions plus opted-in possible output contributors; relation meanings stay distinct. */
export function sourceDataChildren(
  scope: PreparedRecordScope,
  node: ResolvedRecordNode,
  maximum: number,
): Adjacency & { readonly possible?: boolean; readonly truncated?: boolean } {
  const keys = writtenKeysForNode(scope.log[node.commitIndex], node.identity),
    edges: GraphEdge[] = [];
  let possible = false;
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
    if (
      !append(
        edges,
        {
          nodeId: nodeIdFor(scope.address, { runtimeStageId: read.occurrence.runtimeStageId, commitIdx }),
          kind: 'data',
          attribution: 'recorded-read',
          evidence: evidence(read),
        },
        maximum,
      )
    )
      return { edges, complete: false, possible, truncated: true };
    const prepared = scope.readSources!.writePrefixes;
    if (prepared) {
      const outputs = writePrefixesForRead(prepared, read, maximum - edges.length + 1);
      for (const prefix of outputs.writes) {
        const row = scope.log[prefix.commitIdx].trace[prefix.rowIdx];
        possible = true;
        if (
          !append(
            edges,
            {
              nodeId: nodeIdFor(scope.address, {
                runtimeStageId: prefix.runtimeStageId,
                commitIdx: prefix.commitIdx,
                key: row.path,
              }),
              kind: 'data',
              attribution: 'per-write',
              evidence: [...evidence(read), 'write-prefix:' + writePrefixKey(prefix.commitIdx, prefix.rowIdx)],
            },
            maximum,
          )
        )
          return { edges, complete: false, possible, truncated: true };
      }
      if (!outputs.complete) return { edges, complete: false, possible, truncated: outputs.truncated };
    }
  }
  return { edges, complete: true, possible };
}
