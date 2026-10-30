import { Session } from '../cause/session.js';
import type { CauseGraph, GraphEdge } from '../cause/types.js';
import { walk } from '../cause/walk.js';
import { relation, writerCandidates } from '../memory/keyPaths.js';
import { pathSegments } from '../memory/paths.js';
import { earlier, metadataOf, queryOf } from './admission.js';
import { TraceMetadataError } from './errors.js';
import type {
  TraceMetadata,
  TraceMetadataEdge,
  TraceMetadataEntry,
  TraceMetadataGap,
  TraceMetadataOccurrence,
  TraceMetadataPosition,
  TraceMetadataQuery,
  TraceMetadataResult,
} from './types.js';

/** One logical allowance; it is not a CPU/comparator-count or synchronous wall-time guarantee. */
class Work {
  failure?: TraceMetadataError;
  constructor(private left: number) {}
  take(units = 1): void {
    this.left -= units;
    if (this.left < 0) this.fail('work-limit');
  }
  fail(code: 'work-limit' | 'node-limit' | 'edge-limit'): never {
    this.failure ??= new TraceMetadataError(code);
    throw this.failure;
  }
}
interface Row {
  readonly id: string;
  readonly occurrence: TraceMetadataOccurrence;
  readonly entry: TraceMetadataEntry;
}

/**
 * Read only explicit path occurrences/read anchors. The private adapter supplies no
 * state, inferred read position or value-aware writer; existing walk owns traversal.
 */
export async function traceMetadata(handle: TraceMetadata, raw: TraceMetadataQuery): Promise<TraceMetadataResult> {
  const source = metadataOf(handle),
    query = queryOf(raw, source),
    work = new Work(query.maxWork);
  const nodes = new Map<string, Row>(),
    byPosition = new Map<string, Row>(),
    edgeFacts = new Map<string, TraceMetadataEdge>();
  const metadataGaps: TraceMetadataGap[] = [];
  const gap = (code: TraceMetadataGap['code'], row?: Row, key?: string): void => {
    work.take();
    metadataGaps.push(
      Object.freeze({ code, ...(row ? { at: row.occurrence.address } : {}), ...(key === undefined ? {} : { key }) }),
    );
  };
  const node = (commitIndex: number, traceIndex: number): Row => {
    const position = commitIndex + ':' + traceIndex,
      existing = byPosition.get(position);
    if (existing) return existing;
    work.take();
    const commit = source.commits[commitIndex],
      entry = commit.trace[traceIndex];
    const address = Object.freeze({
      basis: source.addressBasis,
      commitIndex,
      traceIndex,
      ...(source.originalCommitIndices === undefined
        ? {}
        : { originalCommitIndex: source.originalCommitIndices[commitIndex] }),
    });
    const occurrence: TraceMetadataOccurrence = Object.freeze({
      address,
      stage: commit.stage,
      stageId: commit.stageId,
      runtimeStageId: commit.runtimeStageId,
      path: entry.path,
      ...(commit.phase === undefined ? {} : { phase: commit.phase }),
      ...(entry.verb === undefined ? {} : { verb: entry.verb }),
      reads:
        source.readsAvailable === false || entry.reads === undefined
          ? 'unknown'
          : entry.reads.keys.length
          ? 'captured'
          : 'captured-empty',
    });
    // Full public names never enter the graph protocol's smaller ID/reference limits.
    const row = { id: 'm' + nodes.size, occurrence, entry };
    nodes.set(row.id, row);
    byPosition.set(position, row);
    return row;
  };
  const select = (
    key: string,
    before: TraceMetadataPosition,
    limit: number,
    kind: 'node-limit' | 'edge-limit',
    owner?: Row,
  ): Row[] => {
    const n = source.occurrenceCount,
      d = source.maximumPathDepth;
    work.take(source.pathSegmentCount + n * (d + 1) * (Math.ceil(Math.log2(n + 1)) + 1) + 2 * pathSegments(key).length);
    const candidates = writerCandidates(source.index, key);
    work.take(candidates.atOrInside.length + candidates.aroundOnly.length);
    const indices = [...candidates.atOrInside, ...candidates.aroundOnly].sort((a, b) => {
      work.take();
      return a - b;
    });
    const selected: Row[] = [];
    let overlap = false;
    for (const commitIndex of indices) {
      work.take();
      if (commitIndex > before.commitIndex) break;
      const trace = source.commits[commitIndex].trace;
      for (let traceIndex = 0; traceIndex < trace.length; traceIndex++) {
        work.take();
        if (!earlier({ commitIndex, traceIndex }, before)) break;
        const related = relation(trace[traceIndex].path, key);
        if (related === undefined) continue;
        if (selected.length >= limit) work.fail(kind);
        // No exact-path kill barrier: earlier merge/append/unknown contributions remain candidates.
        selected.push(node(commitIndex, traceIndex));
        overlap ||= related !== 'exact';
      }
    }
    if (overlap) gap('overlapping-operation', owner, key);
    if (selected.length === 0) gap('origin-unknown', owner, key);
    return selected;
  };
  gap('state-effect-unknown');
  if (source.scope.invocationId !== null && source.scope.invocationPath === undefined) gap('ancestry-unknown');
  // Even a commit-only mapping does not establish the original trace-row coordinate.
  if (source.addressBasis === 'projection-local') gap('original-address-unknown');
  const selection = select(query.key, query.before, query.maxNodes, 'node-limit');
  const graph: CauseGraph = {
    attention: () => [],
    gaps: () => [],
    children: () => ({ edges: [], complete: false }),
    parents: (id) => {
      const row = nodes.get(id)!;
      if (row.occurrence.reads === 'unknown') {
        gap('reads-unknown', row);
        return { edges: [], complete: false };
      }
      const reads = row.entry.reads!;
      if (reads.kind === 'stage') gap('stage-read-conservative', row);
      const edges: GraphEdge[] = [];
      for (const key of reads.keys) {
        work.take();
        const parents = select(key, reads.before, query.maxEdges, 'edge-limit', row);
        for (const parent of parents) {
          work.take();
          if (edges.length >= query.maxEdges) work.fail('edge-limit');
          const token = 'e' + edgeFacts.size;
          edgeFacts.set(
            token,
            Object.freeze({
              kind: 'candidate-read',
              from: row.occurrence.address,
              to: parent.occurrence.address,
              key,
              before: reads.before,
              coverage: reads.kind,
            }),
          );
          edges.push({ nodeId: parent.id, kind: 'data', attribution: reads.kind, evidence: [token] });
        }
      }
      return { edges, complete: true };
    },
  };
  const session = new Session(graph, { maxNodes: query.maxNodes, maxDepth: query.maxDepth, maxEdges: query.maxEdges });
  try {
    const walked = await walk(
      session,
      session.total,
      selection.map((row) => row.id),
      'parents',
    );
    // Session converts adapter throws into gaps; our own capacity refusals stay atomic.
    if (work.failure) throw work.failure;
    let latestExact: TraceMetadataOccurrence | undefined;
    const selected = selection.map((row) => {
      work.take();
      if (row.entry.path === query.key) latestExact = row.occurrence;
      return row.occurrence;
    });
    const keptNodes = walked.nodes.map((id) => {
      work.take();
      return nodes.get(id)!.occurrence;
    });
    const edges = walked.edges.map((edge) => {
      work.take();
      return edgeFacts.get(edge.evidence[0])!;
    });
    for (const missing of walked.gaps) {
      work.take();
      const at = missing.nodeId === undefined ? undefined : nodes.get(missing.nodeId)?.occurrence.address;
      metadataGaps.push(
        Object.freeze({ code: 'walk-incomplete', reason: missing.code, ...(at === undefined ? {} : { at }) }),
      );
    }
    const seen = new Set<string>(),
      gaps: TraceMetadataGap[] = [];
    for (const item of metadataGaps) {
      work.take();
      const identity = JSON.stringify(item);
      if (!seen.has(identity)) {
        seen.add(identity);
        gaps.push(item);
      }
    }
    work.take(source.startKeys?.length ?? 0);
    return Object.freeze({
      kind: 'metadata',
      scope: source.scope,
      key: query.key,
      before: query.before,
      stateEffect: 'unknown',
      complete: false,
      ...(latestExact === undefined ? {} : { latestExact }),
      selection: Object.freeze(selected),
      startKeyObserved: source.startKeys?.includes(query.key) ?? false,
      nodes: Object.freeze(keptNodes),
      edges: Object.freeze(edges),
      gaps: Object.freeze(gaps),
    });
  } finally {
    session.dispose();
  }
}
