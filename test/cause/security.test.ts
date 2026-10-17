/** C1 boundary/security witnesses: ordinary stored data is untrusted; host ports are executable code. */
import { describe, expect, it, vi } from 'vitest';

import { attentionList, explain } from '../../src/cause.js';
import type { CauseGraph, Gap, GraphContext } from '../../src/cause.js';
import type { Attention } from '../../src/index.js';

const PRIVATE = 'PRIVATE_PAYMENT_TOKEN_AND_CUSTOMER_VALUE';
const safeMark: Attention = { kind: 'error', reason: 'ERROR_RECORDED', evidence: ['attempt-proof'] };
const codes = (result: { gaps: readonly Gap[] }) => result.gaps.map((gap) => gap.code);
const safeOutput = (value: unknown) => {
  const text = JSON.stringify(value);
  expect(text).not.toContain(PRIVATE);
  expect(text).not.toContain('rawPayload');
  expect(text).not.toContain('stack');
  return text;
};

function graph(): CauseGraph {
  return {
    parents: () => ({ edges: [], complete: true }),
    children: () => ({ edges: [], complete: true }),
    attention: () => [safeMark],
    gaps: () => [],
  };
}

/** A descriptor trap can lie about a writable array length without touching its real entries. */
function arrayWithReportedLength<T>(items: T[], length: number): T[] {
  return new Proxy(items, {
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      return key === 'length' && descriptor ? { ...descriptor, value: length } : descriptor;
    },
  });
}

describe('untrusted graph response admission', () => {
  for (const [label, length] of [
    ['NaN', NaN],
    ['negative', -1],
    ['fractional', 0.5],
  ] as const) {
    it(`rejects a graph edge array with a ${label} reported length instead of inventing complete empty ancestry`, async () => {
      const edges = arrayWithReportedLength(
        [{ nodeId: 'parent', kind: 'data' as const, attribution: 'per-write' as const, evidence: ['link-proof'] }],
        length,
      );
      const port = graph();
      port.parents = (id) => ({ edges: id === 'selected' ? edges : [], complete: true });
      const result = await explain(port, 'selected');
      expect(codes(result)).toContain('invalid-data');
      expect(result.confidence).toBe('incomplete');
      expect(result.rootCause).toBeUndefined();
      safeOutput(result);
    });

    for (const mode of ['explicit', 'host-roots'] as const) {
      it(`rejects ${mode} attention seeds with a ${label} reported length instead of a complete empty list`, async () => {
        const seeds = arrayWithReportedLength(['selected'], length);
        const port = graph();
        if (mode === 'host-roots') port.roots = () => seeds;
        const result = await attentionList(port, mode === 'explicit' ? { nodeIds: seeds } : {});
        expect(codes(result)).toContain('invalid-data');
        expect(result.confidence).toBe('incomplete');
        safeOutput(result);
      });
    }
  }

  const invalidAdjacencies: readonly [string, unknown][] = [
    ['missing edges', { complete: true }],
    ['non-array edges', { edges: {}, complete: true }],
    ['non-boolean completeness', { edges: [], complete: 'yes' }],
    ['sparse edge array', { edges: new Array(1), complete: true }],
    [
      'invalid edge kind',
      { edges: [{ nodeId: 'parent', kind: PRIVATE, attribution: 'per-write', evidence: [] }], complete: true },
    ],
    [
      'invalid edge attribution',
      { edges: [{ nodeId: 'parent', kind: 'data', attribution: PRIVATE, evidence: [] }], complete: true },
    ],
    [
      'invalid edge evidence',
      { edges: [{ nodeId: 'parent', kind: 'data', attribution: 'per-write', evidence: {} }], complete: true },
    ],
    [
      'invalid edge identity',
      {
        edges: [{ nodeId: { rawPayload: PRIVATE }, kind: 'data', attribution: 'per-write', evidence: [] }],
        complete: true,
      },
    ],
    ['inherited fields', Object.create({ edges: [], complete: true })],
  ];
  for (const [name, payload] of invalidAdjacencies) {
    it(`marks ${name} unavailable as fixed invalid-data evidence`, async () => {
      const port = graph();
      port.parents = () => payload as ReturnType<CauseGraph['parents']>;
      const result = await explain(port, 'selected');
      expect(codes(result)).toContain('invalid-data');
      expect(result.confidence).toBe('incomplete');
      expect(result.rootCause).toBeUndefined();
      safeOutput(result);
    });
  }

  it('never invokes an accessor while validating adjacency fields', async () => {
    let reads = 0;
    const payload = { complete: true };
    Object.defineProperty(payload, 'edges', {
      enumerable: true,
      get() {
        reads++;
        throw new Error(PRIVATE);
      },
    });
    const port = graph();
    port.parents = () => payload as ReturnType<CauseGraph['parents']>;
    const result = await explain(port, 'selected');
    expect(reads).toBe(0);
    expect(codes(result)).toContain('invalid-data');
    safeOutput(result);
  });

  it('never invokes accessors on edge records or array elements', async () => {
    let reads = 0;
    const edge = { kind: 'data', attribution: 'per-write', evidence: [] };
    Object.defineProperty(edge, 'nodeId', {
      enumerable: true,
      get() {
        reads++;
        return PRIVATE;
      },
    });
    const entries: unknown[] = [];
    Object.defineProperty(entries, 0, {
      enumerable: true,
      get() {
        reads++;
        return edge;
      },
    });
    entries.length = 1;
    const port = graph();
    port.parents = () => ({ edges: entries, complete: true } as ReturnType<CauseGraph['parents']>);
    const result = await explain(port, 'selected');
    expect(reads).toBe(0);
    expect(codes(result)).toContain('invalid-data');
    safeOutput(result);
    port.parents = () => ({ edges: [edge], complete: true } as unknown as ReturnType<CauseGraph['parents']>);
    const second = await explain(port, 'selected');
    expect(reads).toBe(0);
    expect(codes(second)).toContain('invalid-data');
    safeOutput(second);
  });

  it('does not read an untrusted then accessor on a synchronous data response', async () => {
    let reads = 0;
    const payload = { edges: [], complete: true };
    Object.defineProperty(payload, 'then', {
      get() {
        reads++;
        throw new Error(PRIVATE);
      },
    });
    const port = graph();
    port.parents = () => payload;
    const result = await explain(port, 'selected');
    expect(reads).toBe(0);
    safeOutput(result);
  });

  it('rejects an own Promise constructor accessor without invoking species lookup', async () => {
    let constructorReads = 0;
    const returned = Promise.resolve({ edges: [], complete: true });
    Object.defineProperty(returned, 'constructor', {
      get() {
        constructorReads++;
        throw new Error(PRIVATE);
      },
    });
    const port = graph();
    port.parents = () => returned;
    const result = await explain(port, 'selected');
    expect(constructorReads).toBe(0);
    expect(codes(result)).toContain('invalid-data');
    expect(result.confidence).toBe('incomplete');
    expect(result.rootCause).toBeUndefined();
    safeOutput(result);
  });

  it('continues accepting an ordinary current-realm Promise without wrapper overrides', async () => {
    const port = graph();
    port.parents = () => Promise.resolve({ edges: [], complete: true });
    const result = await explain(port, 'selected');
    expect(result.rootCause).toBe('selected');
    expect(result.confidence).toBe('complete');
    expect(result.gaps).toEqual([]);
  });

  it('rejects an own Promise constructor data field before a custom species getter can run', async () => {
    let speciesReads = 0;
    const constructor = {};
    Object.defineProperty(constructor, Symbol.species, {
      get() {
        speciesReads++;
        throw new Error(PRIVATE);
      },
    });
    const returned = Promise.resolve({ edges: [], complete: true });
    Object.defineProperty(returned, 'constructor', { value: constructor });
    const port = graph();
    port.parents = () => returned;
    const result = await explain(port, 'selected');
    expect(speciesReads).toBe(0);
    expect(codes(result)).toContain('invalid-data');
    expect(result.confidence).toBe('incomplete');
    expect(result.rootCause).toBeUndefined();
    safeOutput(result);
  });

  it('does not copy arbitrary source fields or inspect an unused payload getter', async () => {
    let reads = 0;
    const payload = { ...safeMark, rawPayload: { token: PRIVATE } };
    Object.defineProperty(payload, 'unused', {
      enumerable: true,
      get() {
        reads++;
        throw new Error(PRIVATE);
      },
    });
    const port = graph();
    port.attention = () => [payload];
    const result = await explain(port, 'selected');
    expect(reads).toBe(0);
    safeOutput(result);
    for (const mark of result.attention) expect(Object.keys(mark).sort()).toEqual(['evidence', 'kind', 'reason']);
  });

  it('accepts future attention kinds while retaining only the fixed reason vocabulary', async () => {
    const port = graph();
    port.attention = () => [{ kind: 'inventory-mismatch', reason: 'BUSINESS_RULE_MATCHED', evidence: ['rule-proof'] }];
    const result = await explain(port, 'selected');
    expect(result.attention).toEqual([
      { kind: 'inventory-mismatch', reason: 'BUSINESS_RULE_MATCHED', evidence: ['rule-proof'] },
    ]);
    expect(result.confidence).toBe('complete');
  });

  it('rejects a free-text attention reason without surfacing the text', async () => {
    const port = graph();
    port.attention = () => [{ ...safeMark, reason: PRIVATE }] as unknown as readonly Attention[];
    const result = await explain(port, 'selected');
    expect(codes(result)).toContain('invalid-data');
    expect(result.rootCause).toBeUndefined();
    safeOutput(result);
  });

  it('refuses an error attention mark without any proof reference', async () => {
    const port = graph();
    port.attention = () => [{ kind: 'error', reason: 'ERROR_RECORDED', evidence: [] }];
    const result = await explain(port, 'selected');
    expect(codes(result)).toContain('invalid-data');
    expect(result.rootCause).toBeUndefined();
    expect(result.confidence).toBe('incomplete');
  });

  it('allows empty proof for an explicit not-collected mark while keeping the result unknown', async () => {
    const port = graph();
    port.attention = () => [{ kind: 'not-collected', reason: 'EVIDENCE_NOT_COLLECTED', evidence: [] }];
    const result = await explain(port, 'selected');
    expect(result.attention).toEqual([{ kind: 'not-collected', reason: 'EVIDENCE_NOT_COLLECTED', evidence: [] }]);
    expect(codes(result)).toContain('not-collected');
    expect(codes(result)).not.toContain('invalid-data');
    expect(result.rootCause).toBeUndefined();
    expect(result.confidence).toBe('incomplete');
  });

  it('rejects accessor attention fields without evaluating them', async () => {
    let reads = 0;
    const payload = { kind: 'error', evidence: ['proof'] };
    Object.defineProperty(payload, 'reason', {
      enumerable: true,
      get() {
        reads++;
        return PRIVATE;
      },
    });
    const port = graph();
    port.attention = () => [payload] as unknown as readonly Attention[];
    const result = await explain(port, 'selected');
    expect(reads).toBe(0);
    expect(codes(result)).toContain('invalid-data');
    safeOutput(result);
  });

  it('rejects an arbitrary gap code and strips raw provider errors', async () => {
    const port = graph();
    port.gaps = () => [{ code: PRIVATE, evidence: [], rawPayload: PRIVATE }] as unknown as readonly Gap[];
    const result = await explain(port, 'selected');
    expect(codes(result)).toContain('invalid-data');
    expect(result.rootCause).toBeUndefined();
    safeOutput(result);
  });

  it('returns detached metadata without freezing or retaining caller-owned payloads', async () => {
    const evidence = ['proof'];
    const payload = { kind: 'error' as const, reason: 'ERROR_RECORDED' as const, evidence };
    const port = graph();
    port.attention = () => [payload];
    const result = await explain(port, 'selected');
    expect(Object.isFrozen(payload)).toBe(false);
    expect(Object.isFrozen(evidence)).toBe(false);
    evidence.push(PRIVATE);
    expect(result.attention[0]?.evidence).toEqual(['proof']);
    safeOutput(result);
  });

  it('does not use one graph query’s memoized facts for another host graph', async () => {
    const make = (root: string): CauseGraph => ({
      parents: (id) => ({
        edges:
          id === 'selected' ? [{ nodeId: root, kind: 'data', attribution: 'per-write', evidence: ['link-proof'] }] : [],
        complete: true,
      }),
      children: () => ({ edges: [], complete: true }),
      attention: (id) => (id === root ? [safeMark] : []),
      gaps: () => [],
    });
    const [left, right] = await Promise.all([
      explain(make('first-root'), 'selected'),
      explain(make('second-root'), 'selected'),
    ]);
    expect(left.rootCause).toBe('first-root');
    expect(right.rootCause).toBe('second-root');
    expect(JSON.stringify(left)).not.toContain('second-root');
    expect(JSON.stringify(right)).not.toContain('first-root');
  });
});

describe('host call boundaries, cancellation and strategy admission', () => {
  for (const [problem, output] of [
    ['injection', ['first', 'second', PRIVATE]],
    ['omission', ['first']],
    ['duplication', ['first', 'first']],
  ] as const) {
    it(`rejects impact ${problem} and preserves the complete original descendant references`, async () => {
      const port = graph();
      port.children = (id) => ({
        edges:
          id === 'selected'
            ? ['first', 'second'].map((nodeId) => ({
                nodeId,
                kind: 'data' as const,
                attribution: 'per-write' as const,
                evidence: ['link-proof'],
              }))
            : [],
        complete: true,
      });
      const result = await explain(port, 'selected', { rankImpact: () => output });
      expect(result.impact.nodes).toEqual(['first', 'second']);
      expect(codes(result.impact)).toContain('strategy-failed');
      expect(result.impact.confidence).toBe('incomplete');
      expect(result.rootCause).toBe('selected');
      safeOutput(result);
    });
  }

  it('contains an impact strategy exception and retains the unranked references', async () => {
    const port = graph();
    const result = await explain(port, 'selected', {
      rankImpact: () => {
        throw new Error(PRIVATE);
      },
    });
    expect(result.impact.nodes).toEqual([]);
    expect(codes(result.impact)).toContain('strategy-failed');
    expect(result.impact.confidence).toBe('incomplete');
    safeOutput(result);
  });

  it('bounds a hung impact strategy with the shared query deadline and retains its timeout reason', async () => {
    let observed: AbortSignal | undefined;
    const result = await explain(graph(), 'selected', {
      timeoutMs: 15,
      rankImpact: (_nodes, context) => {
        observed = context.signal;
        return new Promise(() => {});
      },
    });
    expect(observed?.aborted).toBe(true);
    expect(result.impact.gaps).toContainEqual({ code: 'timeout', evidence: [] });
    expect(result.impact.confidence).toBe('incomplete');
    expect(result.rootCause).toBe('selected');
    safeOutput(result);
  }, 2000);

  it('cancels a pending impact strategy without exposing the external abort reason', async () => {
    const controller = new AbortController();
    const result = await explain(graph(), 'selected', {
      signal: controller.signal,
      rankImpact: () => {
        controller.abort(new Error(PRIVATE));
        return new Promise(() => {});
      },
    });
    expect(result.impact.gaps).toContainEqual({ code: 'cancelled', evidence: [] });
    expect(result.impact.confidence).toBe('incomplete');
    safeOutput(result);
  }, 2000);

  for (const limits of [
    { maxNodes: -1 },
    { maxDepth: -1 },
    { maxEdges: 1.5 },
    { maxCalls: Infinity },
    { timeoutMs: NaN },
  ]) {
    it(`refuses an invalid ${Object.keys(limits)[0]} before dispatching graph calls`, async () => {
      let calls = 0;
      const port = graph();
      port.parents = () => {
        calls++;
        return { edges: [], complete: true };
      };
      let caught: unknown;
      try {
        await explain(port, 'selected', limits);
      } catch (error) {
        caught = error;
      }
      expect(caught instanceof TypeError || caught instanceof RangeError).toBe(true);
      expect(calls).toBe(0);
      expect(String(caught)).not.toContain(PRIVATE);
    });
  }

  it('refuses a malformed selected identity without invoking its coercion hooks', async () => {
    let coerced = 0;
    const id = {
      toString() {
        coerced++;
        throw new Error(PRIVATE);
      },
    };
    let caught: unknown;
    try {
      await explain(graph(), id as unknown as string);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(coerced).toBe(0);
    expect(String(caught)).not.toContain(PRIVATE);
  });

  it('contains a synchronous provider exception as a fixed unavailable gap', async () => {
    const port = graph();
    port.parents = () => {
      throw new Error(PRIVATE);
    };
    const result = await explain(port, 'selected');
    expect(codes(result)).toContain('unavailable');
    expect(result.confidence).toBe('incomplete');
    expect(result.rootCause).toBeUndefined();
    safeOutput(result);
  });

  it('contains a rejected asynchronous loader without retaining its raw error', async () => {
    const port = graph();
    port.parents = async () => {
      throw { message: PRIVATE, rawPayload: { token: PRIVATE } };
    };
    const result = await explain(port, 'selected');
    expect(codes(result)).toContain('unavailable');
    expect(result.rootCause).toBeUndefined();
    safeOutput(result);
  });

  it('consumes an ordinary native Promise rejection and reports only a fixed unavailable gap', async () => {
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', observeUnhandled);
    try {
      const port = graph();
      port.parents = () => Promise.reject(new Error(PRIVATE));
      const result = await explain(port, 'selected');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      expect(codes(result)).toContain('unavailable');
      expect(result.confidence).toBe('incomplete');
      expect(result.rootCause).toBeUndefined();
      safeOutput(result);
    } finally {
      process.removeListener('unhandledRejection', observeUnhandled);
    }
  });

  it('times out a loader that never settles and aborts the exact signal handed to it', async () => {
    let observed: AbortSignal | undefined;
    const port = graph();
    port.parents = (_id, context) => {
      observed = context.signal;
      return new Promise(() => {});
    };
    const result = await explain(port, 'selected', { timeoutMs: 15 });
    expect(observed).toBeInstanceOf(AbortSignal);
    expect(observed?.aborted).toBe(true);
    expect(codes(result)).toContain('timeout');
    expect(result.rootCause).toBeUndefined();
    safeOutput(result);
  }, 2000);

  it('checks its monotonic deadline after a synchronous port returns even before the timer gets an event-loop turn', async () => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const port = graph();
      port.parents = () => {
        now += 20;
        return { edges: [], complete: true };
      };
      const result = await explain(port, 'selected', { timeoutMs: 15 });
      expect(codes(result)).toContain('timeout');
      expect(result.rootCause).toBeUndefined();
      expect(result.confidence).toBe('incomplete');
      safeOutput(result);
    } finally {
      clock.mockRestore();
    }
  });

  it('checks an already cancelled request before dispatching any graph call', async () => {
    const controller = new AbortController();
    controller.abort(new Error(PRIVATE));
    let calls = 0;
    const count = () => {
      calls++;
      return { edges: [], complete: true };
    };
    const port: CauseGraph = {
      parents: count,
      children: count,
      attention: () => {
        calls++;
        return [];
      },
      gaps: () => {
        calls++;
        return [];
      },
    };
    const result = await explain(port, 'selected', { signal: controller.signal });
    expect(calls).toBe(0);
    expect(codes(result)).toContain('cancelled');
    expect(result.confidence).toBe('incomplete');
    safeOutput(result);
  });

  it('cancels pending asynchronous work without returning the caller’s private abort reason', async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    const port = graph();
    port.parents = (_id, context) => {
      observed = context.signal;
      controller.abort(new Error(PRIVATE));
      return new Promise(() => {});
    };
    const result = await explain(port, 'selected', { signal: controller.signal, timeoutMs: 100 });
    expect(observed?.aborted).toBe(true);
    expect(codes(result)).toContain('cancelled');
    expect(result.rootCause).toBeUndefined();
    safeOutput(result);
  }, 2000);

  it('passes one owned cancellation signal to all methods and the ranking strategy', async () => {
    const signals = new Set<AbortSignal>();
    const capture = (context: GraphContext) => {
      signals.add(context.signal);
      expect(context.signal.aborted).toBe(false);
    };
    const port: CauseGraph = {
      parents: (_id, context) => {
        capture(context);
        return { edges: [], complete: true };
      },
      children: (_id, context) => {
        capture(context);
        return { edges: [], complete: true };
      },
      attention: (_id, context) => {
        capture(context);
        return [safeMark];
      },
      gaps: (_id, context) => {
        capture(context);
        return [];
      },
    };
    const result = await explain(port, 'selected', {
      rankRoots: (candidates, context) => {
        capture(context);
        return candidates.map((candidate) => candidate.nodeId);
      },
    });
    expect(result.rootCause).toBe('selected');
    expect(signals.size).toBe(1);
  });

  it('does not accept a strategy that invents a root identity outside its recorded candidates', async () => {
    const result = await explain(graph(), 'selected', { rankRoots: () => [PRIVATE] });
    expect(result.rootCause).toBeUndefined();
    expect(codes(result)).toContain('strategy-failed');
    expect(result.confidence).toBe('incomplete');
    safeOutput(result);
  });

  it('contains a throwing ranking strategy as a separate fixed gap', async () => {
    const result = await explain(graph(), 'selected', {
      rankRoots: () => {
        throw new Error(PRIVATE);
      },
    });
    expect(result.rootCause).toBeUndefined();
    expect(codes(result)).toContain('strategy-failed');
    safeOutput(result);
  });

  it('uses the same deadline for a hung strategy and its graph reads', async () => {
    let observed: AbortSignal | undefined;
    const result = await explain(graph(), 'selected', {
      timeoutMs: 15,
      rankRoots: (_candidates, context) => {
        observed = context.signal;
        return new Promise(() => {});
      },
    });
    expect(observed?.aborted).toBe(true);
    expect(codes(result)).toContain('timeout');
    // This is the strategy invocation's own reason, rather than only the later
    // selected-node impact read discovering that its signal was already aborted.
    expect(result.gaps).toContainEqual({ code: 'timeout', evidence: [] });
    expect(result.rootCause).toBeUndefined();
    safeOutput(result);
  }, 2000);

  it('retains cancellation of a strategy as cancellation rather than replacing it with a generic strategy error', async () => {
    const controller = new AbortController();
    const result = await explain(graph(), 'selected', {
      signal: controller.signal,
      rankRoots: () => {
        controller.abort(new Error(PRIVATE));
        return new Promise(() => {});
      },
    });
    expect(result.gaps).toContainEqual({ code: 'cancelled', evidence: [] });
    expect(result.rootCause).toBeUndefined();
    safeOutput(result);
  }, 2000);

  it('validates roots supplied for attention discovery without exposing their malformed contents', async () => {
    let coerced = 0;
    const port = graph();
    port.roots = () =>
      [
        {
          toString() {
            coerced++;
            return PRIVATE;
          },
        },
      ] as unknown as readonly string[];
    const result = await attentionList(port);
    expect(coerced).toBe(0);
    expect(codes(result)).toContain('invalid-data');
    expect(result.confidence).toBe('incomplete');
    safeOutput(result);
  });

  it('bounds attention discovery rather than treating a cut as a complete list', async () => {
    let calls = 0;
    const port = graph();
    port.attention = () => {
      calls++;
      return [safeMark];
    };
    const result = await attentionList(port, { nodeIds: ['one', 'two', 'three'], maxNodes: 2 });
    expect(result.nodes.length).toBeLessThanOrEqual(2);
    expect(calls).toBeLessThanOrEqual(2);
    expect(result.confidence).toBe('incomplete');
    expect(codes(result)).toContain('node-limit');
  });
});
