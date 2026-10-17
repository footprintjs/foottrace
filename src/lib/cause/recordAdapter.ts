import { causalChain, type ControlDependency } from '../memory/backtrack.js';
import { findLastWriter } from '../memory/commitLogUtils.js';
import type { LogAddress } from '../memory/eventPosition.js';
import type { CommitBundle } from '../memory/types.js';
import { relation } from '../memory/keyPaths.js';
import { sliceForKey } from '../slice/sliceForKey.js';
import { forwardSliceForKey } from '../slice/forwardSliceForKey.js';
import { gaps as admitGaps } from './validation.js';
import type { Adjacency, Attention, CauseGraph, Gap, GraphContext, GraphEdge, NodeId } from './types.js';
import {
  addressKey,
  addressOf,
  bundleOf,
  list,
  mapOf,
  marksOf,
  name,
  names,
  own,
  projectLoaded,
  RecordRefusal,
  spend,
} from './recordValidation.js';
/** Explicit complete maps record absence too; an omitted map means it was not collected. */
export interface RecordScope {
  readonly address: LogAddress;
  readonly commitLog: readonly unknown[];
  readonly reads?: Readonly<Record<string, readonly string[]>>;
  readonly controlDeps?: Readonly<Record<string, { readonly deciderId: string }>>;
  readonly attention?: Readonly<Record<string, readonly Attention[]>>;
  readonly complete?: boolean;
}
export interface RecordNode {
  readonly runtimeStageId: string;
  readonly commitIdx?: number;
  readonly key?: string;
}
export interface RecordGraphOptions {
  readonly maxCommits?: number;
  readonly maxFields?: number;
  readonly maxEdges?: number;
  readonly maxScopes?: number;
  readonly loadTimeoutMs?: number;
}
export interface RecordCauseGraph extends CauseGraph {
  nodeId(address: LogAddress, node: RecordNode): NodeId;
  /** Rejects with fixed message/code on discovery failure; never reports an unavailable scope as empty. */
  openScope(address: LogAddress, context: GraphContext): Promise<readonly NodeId[]>;
}
interface Identity extends RecordNode {
  readonly address: LogAddress;
  readonly read?: true;
}
interface Prepared {
  address: LogAddress;
  log: CommitBundle[];
  reads?: Map<string, string[]>;
  control?: Map<string, ControlDependency>;
  marks?: Map<string, readonly Attention[]>;
  complete: boolean;
}
interface Failed {
  failure: Gap['code'];
}
type Loaded = Prepared | Failed;
export interface RecordLoaderResult {
  readonly scope: RecordScope;
  readonly gaps?: readonly Gap['code'][];
}
const bounded = (n: unknown, d: number, max: number): number => {
  const v = n ?? d;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > max)
    throw new TypeError('cause: invalid record configuration');
  return v;
};
export function recordOptions(options: RecordGraphOptions): Required<RecordGraphOptions> {
  try {
    const p = Object.getPrototypeOf(options);
    if (p !== Object.prototype && p !== null) throw new TypeError();
    return Object.freeze({
      maxCommits: bounded(own(options, 'maxCommits'), 256, 4096),
      maxFields: bounded(own(options, 'maxFields'), 20000, 1000000),
      maxEdges: bounded(own(options, 'maxEdges'), 64, 256),
      maxScopes: bounded(own(options, 'maxScopes'), 32, 256),
      loadTimeoutMs: bounded(own(options, 'loadTimeoutMs'), 1000, 30000),
    });
  } catch {
    throw new TypeError('cause: invalid record configuration');
  }
}
function identity(id: string): Identity {
  if (typeof id !== 'string' || id.length > 2048 || !id.startsWith('record:')) throw new RecordRefusal();
  let a: unknown;
  try {
    a = JSON.parse(id.slice(7));
  } catch {
    throw new RecordRefusal();
  }
  const address = addressOf(own(a, 'address')),
    runtimeStageId = name(own(a, 'runtimeStageId')),
    commitIdx = own(a, 'commitIdx'),
    key = own(a, 'key'),
    read = own(a, 'read');
  if (commitIdx !== undefined && (!Number.isSafeInteger(commitIdx) || (commitIdx as number) < 0))
    throw new RecordRefusal();
  if ((read !== undefined && read !== true) || (read === true && key === undefined)) throw new RecordRefusal();
  return {
    address,
    runtimeStageId,
    ...(commitIdx === undefined ? {} : { commitIdx: commitIdx as number }),
    ...(key === undefined ? {} : { key: name(key, true) }),
    ...(read === true ? { read: true as const } : {}),
  };
}
function issue(a: LogAddress, n: RecordNode, read?: true): NodeId {
  try {
    const address = addressOf(a),
      runtimeStageId = name(own(n, 'runtimeStageId')),
      commitIdx = own(n, 'commitIdx'),
      key = own(n, 'key');
    if (commitIdx !== undefined && (!Number.isSafeInteger(commitIdx) || (commitIdx as number) < 0))
      throw new RecordRefusal();
    const out =
      'record:' +
      JSON.stringify({
        address,
        runtimeStageId,
        ...(commitIdx === undefined ? {} : { commitIdx }),
        ...(key === undefined ? {} : { key: name(key, true) }),
        ...(read ? { read: true } : {}),
      });
    return out.length <= 2048 ? out : 'record:invalid';
  } catch {
    return 'record:invalid';
  }
}
function prepare(value: RecordScope, address: LogAddress, maxCommits: number, maxFields: number): Prepared {
  if (addressKey(addressOf(own(value, 'address'))) !== addressKey(address)) throw new RecordRefusal();
  const raw = list(own(value, 'commitLog'), maxCommits),
    budget = { left: maxFields };
  const log = raw.map((_, i) => bundleOf(own(raw, String(i)), i, budget));
  const reads = mapOf(
    own(value, 'reads'),
    maxCommits,
    (v) => {
      const rows = names(v, 128, true);
      spend(budget, rows.length);
      return rows;
    },
    budget,
  );
  const control = mapOf(
    own(value, 'controlDeps'),
    maxCommits,
    (v) => ({ deciderId: name(own(v, 'deciderId')) }),
    budget,
  );
  const marks = mapOf(
    own(value, 'attention'),
    maxCommits,
    (v) => {
      const rows = marksOf(v);
      spend(budget, rows.length + rows.reduce((n, r) => n + r.evidence.length, 0));
      return rows;
    },
    budget,
  );
  return { address, log, reads, control, marks, complete: own(value, 'complete') === true };
}
function keysOf(s: Prepared, id: string): string[] {
  return [
    ...new Set([
      ...(s.reads?.get(id) ?? []),
      ...s.log.filter((b) => b.runtimeStageId === id).flatMap((b) => b.trace.flatMap((t) => t.readKeys ?? [])),
    ]),
  ];
}
/** Common engine for memory and one-scope-at-a-time host storage. Loader functions are trusted executable code. */
export function createLazyRecordGraph(
  load: (address: LogAddress, context: GraphContext) => RecordLoaderResult | Promise<RecordLoaderResult>,
  options: RecordGraphOptions = {},
): RecordCauseGraph {
  const { maxCommits, maxFields, maxEdges, maxScopes, loadTimeoutMs: timeout } = recordOptions(options);
  let activeLoads = 0;
  const cache = new Map<string, Prepared>(),
    extras = new WeakMap<Prepared, readonly Gap['code'][]>();
  async function scope(address: LogAddress, context: GraphContext): Promise<Loaded> {
    if (context.signal.aborted) return { failure: 'cancelled' };
    const key = addressKey(address);
    const cached = cache.get(key);
    if (cached) return cached;
    if (cache.size + activeLoads >= maxScopes) return { failure: 'node-limit' };
    activeLoads++;
    const until = performance.now() + timeout;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finish: ((value: Failed) => void) | undefined;
    const interrupted = new Promise<Failed>((resolve) => {
      finish = resolve;
    });
    const cancel = () => {
      controller.abort();
      finish?.({ failure: 'cancelled' });
    };
    context.signal.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      finish?.({ failure: 'timeout' });
    }, timeout);
    try {
      const work = projectLoaded(
        () => {
          if (controller.signal.aborted) throw new RecordRefusal(context.signal.aborted ? 'cancelled' : 'timeout');
          return load(address, { signal: controller.signal });
        },
        (result) => {
          if (controller.signal.aborted || performance.now() >= until) {
            controller.abort();
            return { failure: context.signal.aborted ? 'cancelled' : 'timeout' } as Failed;
          }
          let prepared: Prepared;
          try {
            prepared = prepare(own(result, 'scope') as RecordScope, address, maxCommits, maxFields);
            const extra = list(own(result, 'gaps') ?? [], 32);
            extras.set(
              prepared,
              admitGaps(extra.map((code) => ({ code, evidence: [] }))).map((g) => g.code),
            );
          } catch (error) {
            throw error instanceof RecordRefusal ? error : new RecordRefusal();
          }
          if (performance.now() >= until) {
            controller.abort();
            return { failure: 'timeout' } as Failed;
          }
          if (cache.size >= maxScopes && !cache.has(key)) return { failure: 'node-limit' } as Failed;
          cache.set(key, prepared);
          return prepared;
        },
      ).catch((error) => {
        if (context.signal.aborted) return { failure: 'cancelled' } as Failed;
        if (performance.now() >= until) {
          controller.abort();
          return { failure: 'timeout' } as Failed;
        }
        return { failure: error instanceof RecordRefusal ? error.code : 'unavailable' } as Failed;
      });
      // A timed-out host operation retains its slot until it settles; repeated timeouts cannot grow an unbounded I/O pool.
      void work.then(
        () => {
          activeLoads--;
        },
        () => {
          activeLoads--;
        },
      );
      return await Promise.race([work, interrupted]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      context.signal.removeEventListener('abort', cancel);
    }
  }
  const gaps = (code: Gap['code']): readonly Gap[] => [{ code, evidence: [] }];
  async function resolved(id: NodeId, c: GraphContext): Promise<{ s: Prepared; n: Identity; idx: number } | Failed> {
    try {
      const n = identity(id),
        s = await scope(n.address, c);
      if ('failure' in s) return s;
      const idx = n.commitIdx ?? s.log.findIndex((b) => b.runtimeStageId === n.runtimeStageId);
      if (idx < 0 || idx >= s.log.length || s.log[idx].runtimeStageId !== n.runtimeStageId) throw new RecordRefusal();
      // A qualified read is a captured fact, never a caller-supplied request to invent a dependency.
      if (n.read && (n.key === undefined || !keysOf(s, n.runtimeStageId).includes(n.key))) throw new RecordRefusal();
      return { s, n, idx };
    } catch (error) {
      return { failure: error instanceof RecordRefusal ? error.code : 'invalid-data' };
    }
  }
  function inspect(s: Prepared, n: Identity, idx: number): { adj: Adjacency; gaps: readonly Gap[] } {
    const bundle = s.log[idx],
      first = s.log.findIndex((b) => b.runtimeStageId === n.runtimeStageId),
      out: GraphEdge[] = [],
      missing: Gap[] = [];
    const add = (code: Gap['code']) => {
      if (!missing.some((g) => g.code === code)) missing.push({ code, evidence: [] });
    };
    for (const code of extras.get(s) ?? []) add(code);
    if (!s.complete || s.control === undefined || s.marks === undefined) add('not-collected');
    if (bundle.untrackedSources?.length) add('untracked-input');
    if (bundle.redactedPaths.length) add('redacted');
    const lookup = (id: string): string[] => keysOf(s, id);
    // Preparation and adjacency caps are graph coverage, including immediate forward edges.
    {
      const neighbors = new Set<string>();
      for (const key of n.read ? [] : n.key === undefined ? [...new Set(bundle.trace.map((t) => t.path))] : [n.key]) {
        const f = forwardSliceForKey(s.log, key, lookup, { before: idx + 1, maxDepth: 1, maxNodes: maxEdges + 1 });
        if (f.root?.truncated?.byNodes) add('edge-limit');
        for (const e of f.root?.fedEdges ?? []) neighbors.add(JSON.stringify(['data', e.child.commitIdx, e.child.key]));
        for (const read of f.root?.reads ?? [])
          if (!s.log[read.commitIdx]?.trace.length) neighbors.add(JSON.stringify(['read', read.commitIdx, key]));
      }
      if (n.key === undefined || n.read)
        for (const [child, dep] of s.control ?? [])
          if (dep.deciderId === n.runtimeStageId) {
            const childIdx = s.log.findIndex((bundle) => bundle.runtimeStageId === child);
            if (childIdx < 0) add('scope-boundary');
            else if (childIdx <= first) add('invalid-data');
            else neighbors.add(JSON.stringify(['control', child]));
          }
      if (neighbors.size > maxEdges) add('edge-limit');
    }
    const relevant =
      n.key === undefined ? bundle.trace : bundle.trace.filter((t) => relation(t.path, n.key!) !== undefined);
    const precise =
      n.read === true
        ? n.key !== undefined && lookup(n.runtimeStageId).includes(n.key)
        : n.key !== undefined && relevant.length > 0 && relevant.every((t) => t.readKeys !== undefined);
    if (!precise && (n.key !== undefined || lookup(n.runtimeStageId).length > 0)) add('conservative');
    if (!s.reads?.has(n.runtimeStageId) && !precise) add('not-collected');
    const recordedControl = s.control?.get(n.runtimeStageId);
    if (recordedControl) {
      const parent = s.log.findIndex((b) => b.runtimeStageId === recordedControl.deciderId);
      if (parent < 0) add('scope-boundary');
      else if (parent >= first) add('invalid-data');
    }
    const control =
      s.control === undefined
        ? undefined
        : (id: string) => {
            const dep = s.control!.get(id);
            if (!dep) return undefined;
            const parent = s.log.findIndex((b) => b.runtimeStageId === dep.deciderId),
              child = s.log.findIndex((b) => b.runtimeStageId === id);
            return parent >= 0 && parent < child ? dep : undefined;
          };
    const slice =
      n.key === undefined || n.read
        ? undefined
        : sliceForKey(s.log, n.key, lookup, {
            before: idx + 1,
            maxDepth: 1,
            maxNodes: maxEdges + 1,
            controlDeps: control,
          });
    if (n.key !== undefined && !n.read && (!slice?.writer || s.log.indexOf(slice.writer) !== idx)) {
      add('invalid-data');
      return { adj: { edges: [], complete: false }, gaps: missing };
    }
    const root =
      n.read && n.key !== undefined
        ? causalChain(s.log, n.runtimeStageId, (id) => (id === n.runtimeStageId ? [n.key!] : lookup(id)), {
            maxDepth: 1,
            maxNodes: maxEdges + 1,
            controlDeps: control,
          })
        : slice?.root ??
          (n.key === undefined
            ? causalChain(s.log, n.runtimeStageId, lookup, {
                maxDepth: 1,
                maxNodes: maxEdges + 1,
                controlDeps: control,
              })
            : undefined);
    if (root?.preRunReads?.keys.length) add('untracked-input');
    if (root?.truncated?.byNodes) add('edge-limit');
    for (const note of slice?.notes ?? [])
      if (note.code === 'redacted') add('redacted');
      else if (note.code === 'nested-rows' || note.code === 'from-initial-state') add('conservative');
    for (const edge of root?.parentEdges ?? []) {
      if (out.length >= maxEdges) {
        add('edge-limit');
        break;
      }
      const writer =
        edge.kind === 'data' && edge.key
          ? findLastWriter(s.log, edge.key, first)
          : s.log.find((b) => b.runtimeStageId === edge.parent.runtimeStageId);
      if (!writer) {
        add('untracked-input');
        continue;
      }
      const wi = s.log.indexOf(writer);
      out.push({
        nodeId: issue(s.address, {
          runtimeStageId: writer.runtimeStageId,
          commitIdx: wi,
          ...(edge.kind === 'data' && edge.key ? { key: edge.key } : {}),
        }),
        kind: edge.kind,
        attribution: edge.kind === 'control' ? 'recorded-control' : precise ? 'per-write' : 'stage',
        evidence: ['commit:' + wi],
      });
      if (edge.basis) add('conservative');
    }
    return { adj: { edges: out, complete: missing.length === 0 }, gaps: missing };
  }
  const graph: RecordCauseGraph = {
    nodeId: (a, n) => issue(a, n),
    async openScope(a, c) {
      let address: LogAddress;
      try {
        address = addressOf(a);
      } catch {
        throw new RecordRefusal();
      }
      const s = await scope(address, c);
      if ('failure' in s) throw new RecordRefusal(s.failure);
      if (
        !s.log.length &&
        (!s.complete || s.control === undefined || s.marks === undefined || (extras.get(s)?.length ?? 0) > 0)
      )
        throw new RecordRefusal('not-collected');
      return s.log.map((b, commitIdx) => issue(address, { runtimeStageId: b.runtimeStageId, commitIdx }));
    },
    async parents(id, c) {
      const r = await resolved(id, c);
      return 'failure' in r ? { edges: [], complete: false } : inspect(r.s, r.n, r.idx).adj;
    },
    async gaps(id, c) {
      const r = await resolved(id, c);
      return 'failure' in r ? gaps(r.failure) : inspect(r.s, r.n, r.idx).gaps;
    },
    async attention(id, c) {
      const r = await resolved(id, c);
      return 'failure' in r ? [] : r.s.marks?.get(r.n.runtimeStageId) ?? [];
    },
    async children(id, c) {
      const r = await resolved(id, c);
      if ('failure' in r) return { edges: [], complete: false };
      const { s, n, idx } = r;
      const base = inspect(s, n, idx),
        out: GraphEdge[] = [];
      let complete = base.gaps.length === 0;
      if (
        s.log.some(
          (b) =>
            !s.reads?.has(b.runtimeStageId) && (b.trace.length === 0 || b.trace.some((t) => t.readKeys === undefined)),
        )
      )
        complete = false;
      const lookup = (id: string) => keysOf(s, id);
      for (const key of n.read
        ? []
        : n.key === undefined
        ? [...new Set(s.log[idx].trace.map((t) => t.path))]
        : [n.key]) {
        const forward = forwardSliceForKey(s.log, key, lookup, {
          before: idx + 1,
          maxDepth: 1,
          maxNodes: maxEdges + 1,
        });
        if (forward.root?.truncated?.byNodes) complete = false;
        if (forward.root?.commitIdx !== idx) {
          complete = false;
          continue;
        }
        for (const edge of forward.root.fedEdges) {
          const child = edge.child;
          if (child.commitIdx === undefined || !child.runtimeStageId) {
            complete = false;
            continue;
          }
          if (out.length >= maxEdges) {
            complete = false;
            break;
          }
          const nodeId = issue(s.address, {
            runtimeStageId: child.runtimeStageId,
            commitIdx: child.commitIdx,
            key: child.key,
          });
          if (!out.some((e) => e.nodeId === nodeId))
            out.push({ nodeId, kind: 'data', attribution: edge.basis, evidence: ['commit:' + child.commitIdx] });
          if (edge.basis === 'stage') complete = false;
        }
        for (const read of forward.root.reads) {
          if (s.log[read.commitIdx]?.trace.length) continue;
          if (out.length >= maxEdges) {
            complete = false;
            break;
          }
          const nodeId = issue(
            s.address,
            { runtimeStageId: read.runtimeStageId, commitIdx: read.commitIdx, key },
            true,
          );
          if (!out.some((e) => e.nodeId === nodeId))
            out.push({ nodeId, kind: 'data', attribution: 'per-write', evidence: ['commit:' + read.commitIdx] });
        }
      }
      for (const [child, dep] of n.key === undefined || n.read ? s.control ?? [] : []) {
        if (dep.deciderId !== n.runtimeStageId) continue;
        const ci = s.log.findIndex((b) => b.runtimeStageId === child);
        if (ci <= idx) {
          complete = false;
          continue;
        }
        if (out.length >= maxEdges) {
          complete = false;
          break;
        }
        out.push({
          nodeId: issue(s.address, { runtimeStageId: child, commitIdx: ci }),
          kind: 'control',
          attribution: 'recorded-control',
          evidence: ['commit:' + ci],
        });
      }
      return { edges: out, complete };
    },
  };
  return Object.freeze(graph);
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
