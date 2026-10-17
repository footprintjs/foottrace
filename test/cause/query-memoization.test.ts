/** Query-local performance contract, observed through public cause queries and canonical reader counters. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { attentionList, createRecordGraph, createStoredRecordGraph, explain } from '../../src/cause.js';
import type { CauseGraph, GraphContext, RecordCauseGraph, RecordScope, StoredRecordScope } from '../../src/cause.js';
import type { Attention, CommitBundle } from '../../src/index.js';
import * as recordIdentity from '../../src/lib/cause/recordIdentity.js';
import * as slices from '../../src/lib/slice/sliceForKey.js';
import * as forwardSlices from '../../src/lib/slice/forwardSliceForKey.js';

const address = { logRunId: 'query-fixture', drillPath: [] as string[] };
const PRIVATE = 'PRIVATE_QUERY_FAILURE_NOT_FOR_OUTPUT';
const attention = (proof = 'proof:seed'): Attention => ({ kind: 'error', reason: 'ERROR_RECORDED', evidence: [proof] });
function scope(proof = 'proof:seed'): RecordScope {
  const bundle: CommitBundle = {
    idx: 0,
    stage: 'seed',
    stageId: 'seed',
    runtimeStageId: 'seed#0',
    trace: [
      { path: 'value', verb: 'set', readKeys: [] },
      { path: 'other', verb: 'set', readKeys: [] },
    ],
    redactedPaths: [],
    overwrite: { value: PRIVATE, other: PRIVATE },
    updates: {},
  };
  return {
    address,
    commitLog: [bundle],
    reads: { 'seed#0': [] },
    controlDeps: {},
    attention: { 'seed#0': [attention(proof)] },
    complete: true,
  };
}
function memory(proof?: string) {
  return createRecordGraph([scope(proof)]);
}
function node(graph: RecordCauseGraph, key = 'value') {
  return graph.nodeId(address, { runtimeStageId: 'seed#0', commitIdx: 0, key });
}
function stored(proof = 'proof:seed'): StoredRecordScope {
  const record = scope(proof);
  return {
    entries: [
      { kind: 'opened', address, at: 0, initialState: {} },
      ...record.commitLog.map((bundle) => ({ kind: 'commit', address, at: 1, bundle })),
      { kind: 'closed', address, at: 2, outcome: 'ok', commits: 1 },
    ],
    reads: record.reads,
    attention: record.attention,
    controlDeps: record.controlDeps,
  };
}
function observed(graph: RecordCauseGraph, contexts = new Set<GraphContext>()): CauseGraph {
  return {
    parents(id, context) {
      contexts.add(context);
      return graph.parents(id, context);
    },
    children(id, context) {
      contexts.add(context);
      return graph.children(id, context);
    },
    attention(id, context) {
      contexts.add(context);
      return graph.attention(id, context);
    },
    gaps(id, context) {
      contexts.add(context);
      return graph.gaps(id, context);
    },
  };
}
function counters() {
  // These two existing functions expose the otherwise invisible duplicate work;
  // no cache fields, cache registry or implementation layout is inspected.
  return { resolve: vi.spyOn(recordIdentity, 'resolveRecordNode'), inspect: vi.spyOn(slices, 'sliceForKey') };
}
const codes = (result: Awaited<ReturnType<typeof explain>>) => result.gaps.map((gap) => gap.code);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('query-local record resolution and canonical inspection', () => {
  it('resolves and inspects a qualified write once across attention, gaps, parents and forward children', async () => {
    const graph = memory(),
      id = node(graph),
      count = counters();
    const contexts = new Set<GraphContext>();
    const result = await explain(observed(graph, contexts), id);
    expect(result.rootCause).toBe(id);
    expect(result.confidence).toBe('complete');
    expect(count.resolve).toHaveBeenCalledTimes(1);
    expect(count.inspect).toHaveBeenCalledTimes(1);
    expect(contexts.size).toBe(1);
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
  });

  it('shares one resolution and inspection in attentionList without requiring a parent-port call', async () => {
    const graph = memory(),
      id = node(graph),
      count = counters();
    const result = await attentionList(graph, { nodeIds: [id] });
    expect(result.nodes).toEqual([{ nodeId: id, attention: [attention()] }]);
    expect(result.confidence).toBe('complete');
    expect(count.resolve).toHaveBeenCalledTimes(1);
    expect(count.inspect).toHaveBeenCalledTimes(1);
  });

  it('keeps attention-only direct reads free of canonical backward or forward scans', async () => {
    const graph = memory(),
      id = node(graph),
      count = counters();
    const forward = vi.spyOn(forwardSlices, 'forwardSliceForKey');
    const result = await graph.attention(id, { signal: new AbortController().signal });
    expect(result).toEqual([attention()]);
    expect(count.resolve).toHaveBeenCalledTimes(1);
    expect(count.inspect).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it('clears derived work on clean completion without aborting the public query signal', async () => {
    const graph = memory(),
      id = node(graph),
      count = counters();
    const contexts = new Set<GraphContext>();
    await explain(observed(graph, contexts), id);
    const context = [...contexts][0];
    expect(context.signal.aborted).toBe(false);
    expect(count.resolve).toHaveBeenCalledTimes(1);
    expect(count.inspect).toHaveBeenCalledTimes(1);
    expect(await graph.parents(id, context)).toEqual({ edges: [], complete: true });
    expect(count.resolve).toHaveBeenCalledTimes(2);
    expect(count.inspect).toHaveBeenCalledTimes(2);
    expect(context.signal.aborted).toBe(false);
  });

  it('does not retain derived work for repeated direct calls with an unmanaged context', async () => {
    const graph = memory(),
      id = node(graph),
      count = counters();
    const context = { signal: new AbortController().signal };
    const first = await graph.parents(id, context);
    const second = await graph.parents(id, context);
    expect(second).toEqual(first);
    expect(count.resolve).toHaveBeenCalledTimes(2);
    expect(count.inspect).toHaveBeenCalledTimes(2);
  });

  it('recomputes independent sequential public queries while preserving identical evidence', async () => {
    const graph = memory(),
      id = node(graph),
      count = counters();
    const first = await explain(graph, id);
    const second = await explain(graph, id);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(count.resolve).toHaveBeenCalledTimes(2);
    expect(count.inspect).toHaveBeenCalledTimes(2);
  });

  it('does not share derived work or context between concurrent public queries', async () => {
    const graph = memory(),
      id = node(graph),
      count = counters();
    const contexts = new Set<GraphContext>();
    const port = observed(graph, contexts);
    const [first, second] = await Promise.all([explain(port, id), explain(port, id)]);
    expect(first.confidence).toBe('complete');
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(contexts.size).toBe(2);
    expect(count.resolve).toHaveBeenCalledTimes(2);
    expect(count.inspect).toHaveBeenCalledTimes(2);
  });

  it('separates adapter owners when a host strategy reads an identical encoded node ID', async () => {
    const graph = memory('proof:A'),
      other = memory('proof:B'),
      id = node(graph),
      count = counters();
    expect(node(other)).toBe(id);
    const result = await explain(graph, id, {
      rankRoots: async (candidates, context) => {
        expect(await other.attention(id, context)).toEqual([attention('proof:B')]);
        expect(await other.attention(id, context)).toEqual([attention('proof:B')]);
        return candidates.map((candidate) => candidate.nodeId);
      },
    });
    expect(result.rootCause).toBe(id);
    expect(result.attention).toEqual([attention('proof:A')]);
    expect(count.resolve).toHaveBeenCalledTimes(2);
    expect(count.inspect).toHaveBeenCalledTimes(1);
  });

  it('falls back to uncached reads after the query quota without dropping facts or inventing a gap', async () => {
    const graph = memory(),
      id = node(graph),
      other = node(graph, 'other'),
      count = counters();
    const result = await explain(graph, id, {
      maxNodes: 1,
      rankRoots: async (candidates, context) => {
        // The visited node has consumed its one resolution and one inspection.
        // Trusted host strategy reads may exceed this optimization quota; they remain correct.
        expect(await graph.attention(other, context)).toEqual([attention()]);
        expect(await graph.attention(other, context)).toEqual([attention()]);
        return candidates.map((candidate) => candidate.nodeId);
      },
    });
    expect(result.rootCause).toBe(id);
    expect(result.confidence).toBe('complete');
    expect(result.gaps).toEqual([]);
    expect(count.resolve).toHaveBeenCalledTimes(3);
    expect(count.inspect).toHaveBeenCalledTimes(1);
  });

  it('retains the public call limit even when the same node has reusable derived work', async () => {
    const graph = memory(),
      id = node(graph),
      count = counters();
    const result = await explain(graph, id, { maxCalls: 2 });
    expect(result.confidence).toBe('incomplete');
    expect(result.rootCause).toBeUndefined();
    expect(codes(result)).toContain('call-limit');
    expect(count.resolve).toHaveBeenCalledTimes(1);
    expect(count.inspect).toHaveBeenCalledTimes(1);
  });

  it('shares the finite memo quota across adapters rather than granting each adapter another quota', async () => {
    const graph = memory('proof:A'),
      other = memory('proof:B'),
      id = node(graph),
      count = counters();
    const result = await explain(graph, id, {
      maxNodes: 1,
      rankRoots: async (candidates, context) => {
        expect(await other.attention(id, context)).toEqual([attention('proof:B')]);
        expect(await other.attention(id, context)).toEqual([attention('proof:B')]);
        return candidates.map((candidate) => candidate.nodeId);
      },
    });
    expect(result.rootCause).toBe(id);
    expect(result.attention).toEqual([attention('proof:A')]);
    expect(result.confidence).toBe('complete');
    expect(count.resolve).toHaveBeenCalledTimes(3);
    expect(count.inspect).toHaveBeenCalledTimes(1);
  });

  it('shares one failed resolution inside a query and retries storage afresh in the next query', async () => {
    let healthy = false;
    const loadLog = vi.fn(() => {
      if (!healthy) throw new Error(PRIVATE);
      return stored();
    });
    const graph = createStoredRecordGraph({ loadLog }),
      id = node(graph),
      count = counters();
    const first = await explain(graph, id);
    expect(first.confidence).toBe('incomplete');
    expect(first.rootCause).toBeUndefined();
    expect(codes(first)).toContain('unavailable');
    expect(JSON.stringify(first)).not.toContain(PRIVATE);
    expect(loadLog).toHaveBeenCalledTimes(1);
    expect(count.resolve).toHaveBeenCalledTimes(1);
    expect(count.inspect).not.toHaveBeenCalled();
    healthy = true;
    const second = await explain(graph, id);
    expect(second.confidence).toBe('complete');
    expect(second.rootCause).toBe(id);
    expect(loadLog).toHaveBeenCalledTimes(2);
    expect(count.resolve).toHaveBeenCalledTimes(2);
    expect(count.inspect).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch derived reads for an already cancelled query', async () => {
    const graph = memory(),
      id = node(graph),
      count = counters();
    const controller = new AbortController();
    controller.abort();
    const result = await explain(graph, id, { signal: controller.signal });
    expect(codes(result)).toContain('cancelled');
    expect(result.rootCause).toBeUndefined();
    expect(count.resolve).not.toHaveBeenCalled();
    expect(count.inspect).not.toHaveBeenCalled();
  });

  it('honors cancellation in raw adapter ports after a managed query has cached a successful resolution', async () => {
    const graph = memory(),
      id = node(graph),
      count = counters();
    const controller = new AbortController();
    const raw = deferred<{
      parents: Awaited<ReturnType<RecordCauseGraph['parents']>>;
      gaps: Awaited<ReturnType<RecordCauseGraph['gaps']>>;
      attention: Awaited<ReturnType<RecordCauseGraph['attention']>>;
    }>();
    const port: CauseGraph = {
      ...observed(graph),
      async attention(nodeId, context) {
        const marks = await graph.attention(nodeId, context);
        // Fill the managed resolution memo, then read all raw ports synchronously
        // after abort, before the public query can run its finally/dispose block.
        controller.abort();
        const parents = graph.parents(nodeId, context);
        const gaps = graph.gaps(nodeId, context);
        const attention = graph.attention(nodeId, context);
        const values = await Promise.all([parents, gaps, attention]);
        raw.resolve({ parents: values[0], gaps: values[1], attention: values[2] });
        return marks;
      },
    };
    const result = await explain(port, id, { signal: controller.signal });
    const inner = await raw.promise;
    expect(codes(result)).toContain('cancelled');
    expect(result.rootCause).toBeUndefined();
    expect(inner.parents).toEqual({ edges: [], complete: false });
    expect(inner.gaps).toEqual([{ code: 'cancelled', evidence: [] }]);
    expect(inner.attention).toEqual([]);
    expect(count.resolve).toHaveBeenCalledTimes(4);
    expect(count.inspect).not.toHaveBeenCalled();
  });

  it('isolates concurrent storage queries and discards the late result of the cancelled query', async () => {
    const firstLoad = deferred<StoredRecordScope>(),
      secondLoad = deferred<StoredRecordScope>();
    const bothStarted = deferred<void>();
    const loadLog = vi.fn((): Promise<StoredRecordScope> => {
      const count = loadLog.mock.calls.length;
      if (count === 2) bothStarted.resolve();
      return count === 1 ? firstLoad.promise : secondLoad.promise;
    });
    const graph = createStoredRecordGraph({ loadLog }),
      id = node(graph),
      count = counters();
    const firstController = new AbortController(),
      secondController = new AbortController();
    const first = explain(graph, id, { signal: firstController.signal });
    const second = explain(graph, id, { signal: secondController.signal });
    await bothStarted.promise;
    firstController.abort();
    secondLoad.resolve(stored('proof:survivor'));
    const [cancelled, survivor] = await Promise.all([first, second]);
    expect(codes(cancelled)).toContain('cancelled');
    expect(cancelled.rootCause).toBeUndefined();
    expect(survivor.confidence).toBe('complete');
    expect(survivor.attention).toEqual([attention('proof:survivor')]);
    expect(secondController.signal.aborted).toBe(false);
    expect(count.resolve).toHaveBeenCalledTimes(2);
    expect(count.inspect).toHaveBeenCalledTimes(1);
    firstLoad.resolve(stored('proof:late-cancelled'));
    // A fresh public query may reuse successfully prepared scope data, but never the cancelled response.
    const fresh = await explain(graph, id);
    expect(fresh.attention).toEqual([attention('proof:survivor')]);
    expect(fresh.confidence).toBe('complete');
    expect(JSON.stringify(fresh)).not.toContain('proof:late-cancelled');
    expect(count.resolve).toHaveBeenCalledTimes(3);
    expect(count.inspect).toHaveBeenCalledTimes(2);
  });

  it('keeps timed-out resolution query-local and ignores a late successful storage response', async () => {
    vi.useFakeTimers();
    const late = deferred<StoredRecordScope>(),
      started = deferred<void>();
    const loadLog = vi.fn(() => {
      if (loadLog.mock.calls.length === 1) {
        started.resolve();
        return late.promise;
      }
      return stored('proof:fresh');
    });
    const graph = createStoredRecordGraph({ loadLog }, { loadTimeoutMs: 5 }),
      id = node(graph),
      count = counters();
    const pending = explain(graph, id, { timeoutMs: 1000 });
    await started.promise;
    await vi.advanceTimersByTimeAsync(5);
    const timedOut = await pending;
    expect(codes(timedOut)).toContain('timeout');
    expect(timedOut.confidence).toBe('incomplete');
    expect(timedOut.rootCause).toBeUndefined();
    expect(loadLog).toHaveBeenCalledTimes(1);
    expect(count.resolve).toHaveBeenCalledTimes(1);
    late.resolve(stored('proof:late-timeout'));
    const fresh = await explain(graph, id);
    expect(fresh.attention).toEqual([attention('proof:fresh')]);
    expect(fresh.confidence).toBe('complete');
    expect(loadLog).toHaveBeenCalledTimes(2);
    expect(count.resolve).toHaveBeenCalledTimes(2);
    expect(count.inspect).toHaveBeenCalledTimes(1);
  });

  it('clears a public-query timeout without cancelling or contaminating a fresh query', async () => {
    vi.useFakeTimers();
    const late = deferred<StoredRecordScope>(),
      started = deferred<void>();
    let oldSignal: AbortSignal | undefined;
    const loadLog = vi.fn((_address, context: GraphContext) => {
      if (loadLog.mock.calls.length === 1) {
        oldSignal = context.signal;
        started.resolve();
        return late.promise;
      }
      return stored('proof:fresh-query');
    });
    const graph = createStoredRecordGraph({ loadLog }, { loadTimeoutMs: 1000 }),
      id = node(graph),
      count = counters();
    const pending = explain(graph, id, { timeoutMs: 5 });
    await started.promise;
    await vi.advanceTimersByTimeAsync(5);
    const timedOut = await pending;
    expect(codes(timedOut)).toContain('timeout');
    expect(timedOut.rootCause).toBeUndefined();
    expect(oldSignal?.aborted).toBe(true);
    expect(loadLog).toHaveBeenCalledTimes(1);
    const fresh = await explain(graph, id);
    expect(fresh.attention).toEqual([attention('proof:fresh-query')]);
    expect(fresh.confidence).toBe('complete');
    late.resolve(stored('proof:late-query-timeout'));
    expect((await explain(graph, id)).attention).toEqual([attention('proof:fresh-query')]);
    expect(loadLog).toHaveBeenCalledTimes(2);
    expect(count.resolve).toHaveBeenCalledTimes(3);
    expect(count.inspect).toHaveBeenCalledTimes(2);
  });
});
