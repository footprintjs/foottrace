import { describe, expect, it, vi } from 'vitest';

import {
  explain,
  largestDrop,
  mostAffected,
  pathTo,
  type CauseGraph,
  type CauseResult,
  type Gap,
  type GraphEdge,
  type RootStrategy,
  type RootStrategyWalk,
} from '../../src/cause.js';

const selected = 'selected';
const reason = 'host-policy';
const held = { nodeId: 'y', reason };
const redacted: Gap = { code: 'redacted', nodeId: selected, evidence: ['proof:redaction'] };

function edge(nodeId: string, kind: GraphEdge['kind'] = 'data'): GraphEdge {
  return {
    nodeId,
    kind,
    attribution: kind === 'control' ? 'recorded-control' : 'per-write',
    evidence: ['edge:' + nodeId],
  };
}

function fixture(options: { single?: boolean; solo?: boolean; incomplete?: boolean; control?: boolean } = {}) {
  const calls: string[] = [];
  const graph: CauseGraph = {
    parents(id) {
      calls.push('parents:' + id);
      const edges =
        id === selected && !options.solo
          ? [edge('middle'), ...(options.single ? [] : [edge('y')])]
          : id === 'middle'
          ? [edge('x', options.control ? 'control' : 'data')]
          : [];
      return {
        edges,
        complete: true,
        ...(options.incomplete && id === selected ? { gaps: [redacted] } : {}),
      };
    },
    children(id) {
      calls.push('children:' + id);
      return { edges: [], complete: true };
    },
    attention(id) {
      calls.push('attention:' + id);
      return [{ kind: 'error', reason: 'ERROR_RECORDED', evidence: ['proof:' + id] }];
    },
    gaps(id) {
      calls.push('gaps:' + id);
      return [];
    },
  };
  return { graph, calls };
}

function unsafeReturn(raw: unknown): RootStrategy {
  return () => raw as ReturnType<RootStrategy>;
}

function expectRefusal(result: CauseResult) {
  expect(result.rootCause).toBeUndefined();
  expect(result.alternatives).toEqual(['y', 'x']);
  expect(result).not.toHaveProperty('withheldRoots');
  expect(result.confidence).toBe('incomplete');
  expect(result.gaps).toContainEqual({ code: 'strategy-failed', evidence: [] });
}

describe('root strategy selection and withholding', () => {
  it('keeps the default unique root and path', async () => {
    const result = await explain(fixture({ single: true }).graph, selected);
    expect(result).toMatchObject({
      rootCause: 'x',
      path: [selected, 'middle', 'x'],
      alternatives: [],
      confidence: 'complete',
      gaps: [],
    });
    expect(result).not.toHaveProperty('withheldRoots');
  });

  it('never lists the investigated node as its own alternative on an incomplete walk', async () => {
    const result = await explain(fixture({ solo: true, incomplete: true }).graph, selected);
    expect(result.rootCause).toBeUndefined();
    expect(result.alternatives).toEqual([]);
    expect(result.gaps).toEqual([redacted]);
  });

  it.each([
    { select: [], root: undefined, alternatives: [] },
    { select: ['x'], root: 'x', alternatives: [] },
    { select: ['x', 'y'], root: undefined, alternatives: ['x', 'y'] },
    { select: [selected, 'y'], root: undefined, alternatives: ['y'] },
    { select: [selected], root: selected, alternatives: [] },
  ])('retains legacy selection semantics for $select', async ({ select, root, alternatives }) => {
    const result = await explain(fixture().graph, selected, { rankRoots: () => select });
    expect(result.rootCause).toBe(root);
    expect(result.alternatives).toEqual(alternatives);
    expect(result.confidence).toBe('complete');
    expect(result.gaps).toEqual([]);
    expect(result).not.toHaveProperty('withheldRoots');
  });

  it.each([false, true])(
    'retains the recorded alternatives and coverage when withholding (incomplete %s)',
    async (incomplete) => {
      const result = await explain(fixture({ incomplete }).graph, selected, {
        includeBackward: true,
        rankRoots: () => ({ select: [], withheld: [held] }),
      });
      expect(result.rootCause).toBeUndefined();
      expect(result.path).toEqual([]);
      expect(result.alternatives).toEqual(['y', 'x']);
      expect(result.withheldRoots).toEqual([held]);
      expect(result.confidence).toBe(incomplete ? 'incomplete' : 'complete');
      expect(result.gaps).toEqual(incomplete ? [redacted] : []);
      expect(result.backward?.gaps).toEqual(result.gaps);
    },
  );

  it('can withhold a root after examining the path in a complete walk', async () => {
    const result = await explain(fixture({ single: true, control: true }).graph, selected, {
      rankRoots: (eligible, _, walk) => {
        expect(eligible.map((item) => item.nodeId)).toEqual([selected, 'middle', 'x']);
        expect(walk.candidates.map((item) => item.nodeId)).toEqual(['x']);
        expect(pathTo(walk.edges, selected, 'x')).toEqual([selected, 'middle', 'x']);
        const exactData = walk.edges.filter((link) => link.attribution === 'per-write');
        expect(pathTo(exactData, selected, 'x')).toEqual([]);
        return { select: [], withheld: [{ nodeId: 'x', reason }] };
      },
    });
    expect(result.rootCause).toBeUndefined();
    expect(result.alternatives).toEqual(['x']);
    expect(result.withheldRoots).toEqual([{ nodeId: 'x', reason }]);
    expect(result.confidence).toBe('complete');
    expect(result.gaps).toEqual([]);
    expect(result).not.toHaveProperty('backward');
  });

  it('removes the investigated node even when it is the only withheld frontier candidate', async () => {
    const result = await explain(fixture({ solo: true }).graph, selected, {
      rankRoots: () => ({ select: [], withheld: [{ nodeId: selected, reason }] }),
    });
    expect(result.rootCause).toBeUndefined();
    expect(result.alternatives).toEqual([]);
    expect(result.withheldRoots).toEqual([{ nodeId: selected, reason }]);
    expect(result.gaps).toEqual([]);
  });

  it('omits the field when the strategy returns no withheld entries', async () => {
    const f = fixture();
    const result = await explain(f.graph, selected, {
      rankRoots: () => ({ select: [], withheld: [] }),
    });
    expect(result.alternatives).toEqual([]);
    expect(result).not.toHaveProperty('withheldRoots');
    expect(result.gaps).toEqual([]);
  });

  it.each([largestDrop, mostAffected])('keeps built-in ranking output byte-for-byte', async (rank) => {
    const scores = new Map([
      [selected, 0],
      ['middle', 1],
      ['y', 2],
      ['x', 2],
    ]);
    const before = await explain(fixture().graph, selected, { includeBackward: true });
    const after = await explain(fixture().graph, selected, { includeBackward: true, rankRoots: rank(scores) });
    expect(before.alternatives).toEqual(['y', 'x']);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });
});

describe('root strategy walk ownership', () => {
  it('hands the strategy and the result the same frozen walk with the same graph calls', async () => {
    const baseline = fixture();
    const ranked = fixture();
    let observed: RootStrategyWalk | undefined;
    const before = await explain(baseline.graph, selected, { includeBackward: true });
    const after = await explain(ranked.graph, selected, {
      includeBackward: true,
      rankRoots: (eligible, context, walk) => {
        observed = walk;
        expect(context.signal.aborted).toBe(false);
        expect(eligible.map((item) => item.nodeId)).toEqual([selected, 'middle', 'y', 'x']);
        expect(Object.keys(walk).sort()).toEqual(['candidates', 'edges', 'nodeId', 'nodes']);
        expect(walk.nodeId).toBe(selected);
        expect(walk.nodes).toEqual([selected, 'middle', 'y', 'x']);
        expect(walk.candidates.map((item) => item.nodeId)).toEqual(['y', 'x']);
        for (const value of [
          eligible,
          walk,
          walk.nodes,
          walk.edges,
          walk.edges[0],
          walk.edges[0].evidence,
          walk.candidates,
          walk.candidates[0],
          walk.candidates[0].attention,
          walk.candidates[0].attention[0],
          walk.candidates[0].attention[0].evidence,
        ])
          expect(Object.isFrozen(value)).toBe(true);
        expect(() => Array.prototype.push.call(walk.edges, walk.edges[0])).toThrow(TypeError);
        expect(Reflect.set(walk.edges[0], 'to', 'invented')).toBe(false);
        expect(Reflect.deleteProperty(walk, 'nodes')).toBe(false);
        return walk.candidates.map((item) => item.nodeId);
      },
    });
    expect(after).toEqual(before);
    expect(observed?.nodes).toBe(after.backward?.nodes);
    expect(observed?.edges).toBe(after.backward?.edges);
    expect(observed?.edges[0]).toBe(after.backward?.edges[0]);
    expect(ranked.calls).toEqual(baseline.calls);
    expect(ranked.calls).toHaveLength(13);
  });

  it('owns the validated selection and withheld entries before impact calls can change host data', async () => {
    const { graph } = fixture();
    const raw = { select: ['x'], withheld: [{ ...held }] };
    const children = graph.children;
    graph.children = (id, context) => {
      raw.select[0] = 'foreign';
      raw.withheld[0].nodeId = 'foreign';
      raw.withheld[0].reason = 'rewritten';
      return children(id, context);
    };
    const result = await explain(graph, selected, { rankRoots: () => Promise.resolve(raw) });
    expect(result.rootCause).toBe('x');
    expect(result.path).toEqual([selected, 'middle', 'x']);
    expect(result.alternatives).toEqual([]);
    expect(result.withheldRoots).toEqual([held]);
    expect(Object.isFrozen(result.withheldRoots)).toBe(true);
    expect(Object.isFrozen(result.withheldRoots?.[0])).toBe(true);
    expect(result.gaps).toEqual([]);
  });
});

describe('root strategy result admission', () => {
  it.each([
    ['foreign withheld node', { select: ['x'], withheld: [held, { nodeId: 'foreign', reason }] }],
    ['duplicate withheld node', { select: ['x'], withheld: [held, held] }],
    ['selected and withheld node', { select: ['x'], withheld: [{ nodeId: 'x', reason }] }],
    ['foreign selected node', { select: ['x', 'foreign'], withheld: [held] }],
    ['duplicate selected node', { select: ['x', 'x'], withheld: [held] }],
    ['missing selection', { withheld: [held] }],
    ['extra result field', { select: ['x'], withheld: [held], unexpected: true }],
    ['extra entry field', { select: ['x'], withheld: [{ ...held, unexpected: true }] }],
    ['extra symbol', { select: ['x'], withheld: [held], [Symbol('extra')]: true }],
  ])('refuses %s without admitting a valid prefix', async (_, raw) => {
    expectRefusal(await explain(fixture().graph, selected, { rankRoots: unsafeReturn(raw) }));
  });

  it.each(['', 'x'.repeat(65), 'host\u001fpolicy', 'host\u007fpolicy', 7])(
    'refuses an invalid reason %j',
    async (raw) => {
      const rankRoots = unsafeReturn({ select: ['x'], withheld: [{ nodeId: 'y', reason: raw }] });
      expectRefusal(await explain(fixture().graph, selected, { rankRoots }));
    },
  );

  it('admits a reason at the 64-character boundary', async () => {
    const atLimit = 'x'.repeat(64);
    const result = await explain(fixture().graph, selected, {
      rankRoots: () => ({ select: ['x'], withheld: [{ nodeId: 'y', reason: atLimit }] }),
    });
    expect(result.rootCause).toBe('x');
    expect(result.withheldRoots).toEqual([{ nodeId: 'y', reason: atLimit }]);
  });

  it.each(['select', 'withheld', 'nodeId', 'reason', 'select slot', 'withheld slot'])(
    'refuses an accessor on %s without invoking it',
    async (field) => {
      const get = vi.fn(() => 'unrecorded');
      const raw = { select: ['x'], withheld: [{ ...held }] };
      if (field === 'select slot') Object.defineProperty(raw.select, '0', { get });
      else if (field === 'withheld slot') Object.defineProperty(raw.withheld, '0', { get });
      else if (field === 'nodeId' || field === 'reason') Object.defineProperty(raw.withheld[0], field, { get });
      else Object.defineProperty(raw, field, { get });
      expectRefusal(await explain(fixture().graph, selected, { rankRoots: unsafeReturn(raw) }));
      expect(get).not.toHaveBeenCalled();
    },
  );

  it('copies accepted Proxy descriptors once and performs no property gets', async () => {
    const descriptors = { result: new Map(), select: new Map(), withheld: new Map(), entry: new Map() };
    const get = vi.fn(() => {
      throw new Error('ordinary get touched the result');
    });
    function watch<T extends object>(label: keyof typeof descriptors, source: T): T {
      return new Proxy(source, {
        get,
        getOwnPropertyDescriptor(target, key) {
          const count = descriptors[label].get(key) ?? 0;
          descriptors[label].set(key, count + 1);
          if (count > 0) throw new Error('strategy result reread');
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
    }
    const raw = watch('result', {
      select: watch('select', ['x']),
      withheld: watch('withheld', [watch('entry', { ...held })]),
    });
    const result = await explain(fixture().graph, selected, { rankRoots: () => raw });
    expect(result.rootCause).toBe('x');
    expect(result.withheldRoots).toEqual([held]);
    expect(result.gaps).toEqual([]);
    expect(get).not.toHaveBeenCalled();
    expect(descriptors).toEqual({
      result: new Map([
        ['select', 1],
        ['withheld', 1],
      ]),
      select: new Map([
        ['length', 1],
        ['0', 1],
      ]),
      withheld: new Map([
        ['length', 1],
        ['0', 1],
      ]),
      entry: new Map([
        ['nodeId', 1],
        ['reason', 1],
      ]),
    });
  });

  it.each(['result', 'entry', 'list'])('contains a throwing or revoked Proxy on a %s', async (at) => {
    const secret = 'private trap message';
    const trap = vi.fn(() => {
      throw new Error(secret);
    });
    const revoked = Proxy.revocable([held], {});
    revoked.revoke();
    const raw =
      at === 'result'
        ? new Proxy({ select: ['x'], withheld: [held] }, { ownKeys: trap, getOwnPropertyDescriptor: trap })
        : at === 'entry'
        ? { select: ['x'], withheld: [new Proxy(held, { getOwnPropertyDescriptor: trap })] }
        : { select: ['x'], withheld: revoked.proxy };
    const result = await explain(fixture().graph, selected, { rankRoots: unsafeReturn(raw) });
    expectRefusal(result);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each(['bare', 'select', 'withheld'])('bounds the %s list before touching any entry', async (at) => {
    const indexes = vi.fn(() => {
      throw new Error('oversize list element touched');
    });
    const list = new Array<unknown>(2 ** 32 - 1);
    const bounded = new Proxy(list, {
      getOwnPropertyDescriptor: (target, key) =>
        key === 'length' ? Reflect.getOwnPropertyDescriptor(target, key) : indexes(),
      get: (target, key, receiver) => (key === 'length' ? Reflect.get(target, key, receiver) : indexes()),
      has: (target, key) => (key === 'length' ? Reflect.has(target, key) : indexes()),
    });
    const raw = at === 'bare' ? bounded : at === 'select' ? { select: bounded } : { select: ['x'], withheld: bounded };
    const result = await explain(fixture().graph, selected, { maxNodes: 4, rankRoots: unsafeReturn(raw) });
    expectRefusal(result);
    expect(indexes).not.toHaveBeenCalled();
  });
});

describe('root strategy cancellation and failures', () => {
  it('retains the same fixed output for throwing and rejecting strategies with different messages', async () => {
    const thrown = await explain(fixture().graph, selected, {
      rankRoots: () => {
        throw new Error('private synchronous message');
      },
    });
    const rejected = await explain(fixture().graph, selected, {
      rankRoots: () => Promise.reject(new Error('private asynchronous message')),
    });
    expectRefusal(thrown);
    expect(thrown.gaps).toEqual([
      { code: 'unavailable', evidence: [] },
      { code: 'strategy-failed', evidence: [] },
    ]);
    expect(JSON.stringify(rejected)).toBe(JSON.stringify(thrown));
    expect(JSON.stringify(thrown)).not.toContain('private');
  });

  it('times out a pending strategy on the existing session deadline', async () => {
    vi.useFakeTimers();
    try {
      const ranks = vi.fn<RootStrategy>(() => new Promise(() => {}));
      const pending = explain(fixture().graph, selected, { timeoutMs: 50, rankRoots: ranks });
      await vi.advanceTimersByTimeAsync(51);
      const result = await pending;
      expect(ranks).toHaveBeenCalledTimes(1);
      expect(ranks.mock.calls[0][1].signal.aborted).toBe(true);
      expect(result.rootCause).toBeUndefined();
      expect(result).not.toHaveProperty('withheldRoots');
      expect(result.gaps).toContainEqual({ code: 'timeout', evidence: [] });
      expect(result.gaps).toContainEqual({ code: 'strategy-failed', evidence: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains caller cancellation even when the strategy returns usable evidence', async () => {
    const controller = new AbortController();
    const result = await explain(fixture().graph, selected, {
      signal: controller.signal,
      rankRoots: () => {
        controller.abort('private cancellation reason');
        return { select: ['x'], withheld: [held] };
      },
    });
    expect(result.rootCause).toBeUndefined();
    expect(result).not.toHaveProperty('withheldRoots');
    expect(result.gaps).toContainEqual({ code: 'cancelled', evidence: [] });
    expect(result.gaps).toContainEqual({ code: 'strategy-failed', evidence: [] });
    expect(JSON.stringify(result)).not.toContain('private');
  });
});
