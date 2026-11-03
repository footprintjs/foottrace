import { describe, expect, it, vi } from 'vitest';
import { causalChain, forwardSliceForKey, keyTimeline, sliceForKey } from '../../../src/index.js';
import type { CommitBundle } from '../../../src/index.js';

function logOf(n: number): CommitBundle[] {
  return Array.from({ length: n }, (_, i) => ({
    idx: i,
    stage: `s${i}`,
    stageId: `s${i}`,
    runtimeStageId: `s${i}#${i}`,
    trace: [{ path: 'x', verb: 'set' }],
    overwrite: { x: i },
    updates: {},
    redactedPaths: [],
  }));
}
const log = logOf(4);
const lookup = () => ['x'];

describe('root query hard ceilings and cooperative stops', () => {
  it.each([NaN, Infinity, -1, 0.5, 1001])(
    'refuses invalid maxDepth %s before reading even an empty log',
    (maxDepth) => {
      const reads = vi.fn(lookup);
      expect(() => causalChain([], 'missing', reads, { maxDepth })).toThrow(TypeError);
      expect(() => sliceForKey([], 'x', reads, { maxDepth })).toThrow(TypeError);
      expect(() => forwardSliceForKey([], 'x', reads, { maxDepth })).toThrow(TypeError);
      expect(reads).not.toHaveBeenCalled();
    },
  );
  it.each([0, NaN, Infinity, 0.5, 10001])('refuses invalid maxNodes %s', (maxNodes) => {
    expect(() => causalChain(log, 's3#3', lookup, { maxNodes })).toThrow(TypeError);
    expect(() => forwardSliceForKey(log, 'x', lookup, { maxNodes })).toThrow(TypeError);
  });
  it('honors pre-abort on all doors before callbacks', () => {
    const controller = new AbortController();
    controller.abort();
    const options = { maxDepth: 20, signal: controller.signal };
    const reads = vi.fn(lookup);
    for (const ask of [
      () => causalChain(log, 's3#3', reads, options),
      () => sliceForKey(log, 'x', reads, options),
      () => forwardSliceForKey(log, 'x', reads, options),
      () => keyTimeline(log, 'x', reads, { ...options }),
    ])
      expect(ask).toThrow(/SLICE_CANCELLED/);
    expect(reads).not.toHaveBeenCalled();
  });
  it('bounds timeline output by default and labels the cut', () => {
    const result = keyTimeline(logOf(1001), 'x', () => []);
    expect(result.moments).toHaveLength(1000);
    expect(result).toHaveProperty('truncated.byMoments', true);
    expect(result.notes.some((note) => note.code === 'truncated')).toBe(true);
  });
});

describe('bounded graph, read and timeline output', () => {
  it('caps parallel backward edges even when they share a parent', () => {
    const keys = Array.from({ length: 1001 }, (_, i) => `k${i}`);
    const input = logOf(2);
    input[0].trace = keys.map((path) => ({ path, verb: 'set' }));
    input[0].overwrite = Object.fromEntries(keys.map((key) => [key, 1]));
    const root = causalChain(input, 's1#1', (id) => (id === 's1#1' ? keys : []))!;
    expect(root.parentEdges).toHaveLength(1000);
    expect(root.parents).toHaveLength(1);
    expect(root.truncated).toEqual({ byDepth: false, byNodes: false, byEdges: true });
  });
  it('labels edge cuts in backward projections', async () => {
    const { sliceToJSON, formatSlice } = await import('../../../src/index.js');
    const input = logOf(2);
    input[0].trace.push({ path: 'y', verb: 'set' });
    input[0].overwrite.y = 2;
    const result = sliceForKey(input, 'x', (id) => (id === 's1#1' ? ['x', 'y'] : []), { maxEdges: 1 });
    expect(result.root?.parentEdges).toHaveLength(1);
    expect(sliceToJSON(result).truncated?.byEdges).toBe(true);
    expect(formatSlice(result)).toContain('maxEdges reached');
  });
  it('caps all forward read occurrences independently of nodes', async () => {
    const { forwardSliceToJSON, formatForwardSlice } = await import('../../../src/index.js');
    const input = logOf(3);
    input[1].trace = [];
    input[2].trace = [];
    const result = forwardSliceForKey(input, 'x', lookup, { before: 1, maxReads: 1 });
    expect(result.root?.reads).toHaveLength(1);
    expect(result.root?.truncated?.byReads).toBe(true);
    expect(forwardSliceToJSON(result).truncated?.byReads).toBe(true);
    expect(formatForwardSlice(result)).toContain('maxReads reached');
    const exact = forwardSliceForKey(input.slice(0, 2), 'x', lookup, { before: 1, maxReads: 1 });
    expect(exact.root?.truncated).toBeUndefined();
  });
  it('caps forward edges and preserves the cut in projections', async () => {
    const { forwardSliceToJSON } = await import('../../../src/index.js');
    const input = logOf(3);
    input[1].trace[0].path = 'y';
    input[2].trace[0].path = 'z';
    const result = forwardSliceForKey(input, 'x', lookup, { before: 1, maxEdges: 1 });
    expect(result.root?.fedEdges).toHaveLength(1);
    expect(result.root?.truncated?.byEdges).toBe(true);
    expect(forwardSliceToJSON(result).truncated?.byEdges).toBe(true);
  });
  it('returns a chronological timeline prefix including same-commit read before write', () => {
    const result = keyTimeline(log, 'x', lookup, { maxMoments: 3 });
    expect(result.moments?.map((m) => [m.kind, m.commitIdx])).toEqual([
      ['read', 0],
      ['write', 0],
      ['read', 1],
    ]);
    expect(result.moments?.[2].fromWriteIdx).toBe(0);
    expect(result.truncated).toEqual({ byMoments: true });
    expect(keyTimeline(log.slice(0, 1), 'x', lookup, { maxMoments: 2 }).truncated).toBeUndefined();
  });
  it.each([0, -1, NaN, Infinity, 0.5, 100001])('refuses invalid moment/edge/read limit %s', (limit) => {
    expect(() => keyTimeline([], 'x', lookup, { maxMoments: limit })).toThrow(TypeError);
    expect(() => causalChain([], 's0#0', lookup, { maxEdges: limit })).toThrow(TypeError);
    expect(() => forwardSliceForKey([], 'x', lookup, { maxReads: limit })).toThrow(TypeError);
  });
  it('accepts exact ceilings without clamping', () => {
    expect(
      causalChain([], 's', lookup, {
        maxDepth: 1000,
        maxNodes: 10000,
        maxEdges: 100000,
        timeoutMs: 30000,
        maxWork: 10000000,
      }),
    ).toBeUndefined();
    expect(keyTimeline([], 'x', lookup, { maxMoments: 100000 }).missing).toBe('empty-log');
    expect(forwardSliceForKey([], 'x', lookup, { maxReads: 100000 }).missing).toBe('empty-log');
  });
});

describe('stops across preparation, callbacks and composition', () => {
  const doors = [
    (
      input: CommitBundle[],
      reads: () => string[],
      options: { signal?: AbortSignal; timeoutMs?: number; maxWork?: number },
    ) => causalChain(input, 's3#3', reads, options),
    (
      input: CommitBundle[],
      reads: () => string[],
      options: { signal?: AbortSignal; timeoutMs?: number; maxWork?: number },
    ) => sliceForKey(input, 'x', reads, options),
    (
      input: CommitBundle[],
      reads: () => string[],
      options: { signal?: AbortSignal; timeoutMs?: number; maxWork?: number },
    ) => forwardSliceForKey(input, 'x', reads, options),
    (
      input: CommitBundle[],
      reads: () => string[],
      options: { signal?: AbortSignal; timeoutMs?: number; maxWork?: number },
    ) => keyTimeline(input, 'x', reads, options),
  ];
  it.each(doors)('does not swallow abort from a read callback', (ask) => {
    const controller = new AbortController();
    let called = 0;
    expect(() =>
      ask(
        log,
        () => {
          called++;
          controller.abort();
          return ['x'];
        },
        { signal: controller.signal },
      ),
    ).toThrow(/SLICE_CANCELLED/);
    expect(called).toBe(1);
  });
  it.each(doors)('checks the elapsed deadline after callback return', (ask) => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      expect(() =>
        ask(
          log,
          () => {
            now = 11;
            return ['x'];
          },
          { timeoutMs: 10 },
        ),
      ).toThrow(/SLICE_TIMEOUT/);
    } finally {
      clock.mockRestore();
    }
  });
  it.each(doors)('refuses input admission exhaustion instead of analyzing a prefix', (ask) => {
    const reads = vi.fn(lookup);
    expect(() => ask(log, reads, { maxWork: 1 })).toThrow(/SLICE_WORK_LIMIT/);
    expect(reads).not.toHaveBeenCalled();
  });
  it('shares one allowance across slice anchoring and causal expansion', () => {
    // Three input units plus a callback and a traversal unit exceed one shared allowance.
    expect(() => sliceForKey(log.slice(0, 1), 'x', () => [], { maxWork: 4 })).toThrow(/SLICE_WORK_LIMIT/);
  });
  it('checks weigher abort despite its historical error isolation', () => {
    const controller = new AbortController();
    expect(() =>
      causalChain(log, 's3#3', lookup, {
        signal: controller.signal,
        weigh() {
          controller.abort();
          throw new Error('host');
        },
      }),
    ).toThrow(/SLICE_CANCELLED/);
  });
  it.each([0, -1, NaN, Infinity, 0.5, 30001])('refuses invalid timeout %s', (timeoutMs) => {
    expect(() => keyTimeline([], 'x', lookup, { timeoutMs })).toThrow(TypeError);
  });
  it.each([0, -1, NaN, Infinity, 0.5, 10000001])('refuses invalid work allowance %s', (maxWork) => {
    expect(() => causalChain([], 's', lookup, { maxWork })).toThrow(TypeError);
  });
});

describe('depth cuts describe resolved dependencies', () => {
  it('does not claim omitted ancestors for pre-run reads or unknown controls', () => {
    const result = causalChain(log.slice(0, 1), 's0#0', () => ['preRun'], {
      maxDepth: 0,
      controlDeps: () => ({ deciderId: 'not-in-log' }),
    });
    expect(result?.truncated).toBeUndefined();
    expect(result?.preRunReads).toEqual({ code: 'pre-run-origin', keys: ['preRun'] });
  });
  it('marks a real data edge beyond the depth horizon', () => {
    const result = causalChain(log, 's3#3', lookup, { maxDepth: 0 });
    expect(result?.parentEdges).toEqual([]);
    expect(result?.truncated).toEqual({ byDepth: true, byNodes: false });
  });
  it('marks a real control edge beyond the depth horizon', () => {
    const result = causalChain(log, 's3#3', () => [], {
      maxDepth: 0,
      controlDeps: () => ({ deciderId: 's0#0' }),
    });
    expect(result?.parentEdges).toEqual([]);
    expect(result?.truncated).toEqual({ byDepth: true, byNodes: false });
  });
});

it.each([forwardSliceForKey, keyTimeline])('checks the deadline after unknown-key diagnostic preparation', (ask) => {
  const input = logOf(1);
  input[0].trace = Array.from({ length: 20 }, (_, i) => ({ path: `k${i}`, verb: 'set' }));
  input[0].overwrite = Object.fromEntries(input[0].trace.map((row) => [row.path, 1]));
  let now = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const original = Array.prototype.sort;
  const sorting = vi.spyOn(Array.prototype, 'sort').mockImplementation(function (this: unknown[], compare) {
    if (this.length === 20 && typeof this[0] === 'string') now = 11;
    return original.call(this, compare);
  });
  try {
    expect(() => ask(input, 'missing', () => ['k0'], { timeoutMs: 10 })).toThrow(/SLICE_TIMEOUT/);
  } finally {
    sorting.mockRestore();
    clock.mockRestore();
  }
});
