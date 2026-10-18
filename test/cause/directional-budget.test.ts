import { describe, expect, it, vi } from 'vitest';
import { explain } from '../../src/cause.js';
import type { CauseGraph, ExplainOptions, Gap, GraphContext, GraphEdge } from '../../src/cause.js';
import type { Attention } from '../../src/index.js';

const mark: Attention = { kind: 'error', reason: 'ERROR_RECORDED', evidence: ['proof:selected'] };
const codes = (value: { gaps: readonly Gap[] }) => value.gaps.map((item) => item.code);
function fixture(links: readonly [string, string][] = []) {
  const reads: Array<{ method: string; id: string; signal: AbortSignal }> = [];
  const edge = (id: string): GraphEdge => ({
    nodeId: id,
    kind: 'data',
    attribution: 'per-write',
    evidence: ['proof:edge'],
  });
  const record = (method: string, id: string, context: GraphContext) =>
    reads.push({ method, id, signal: context.signal });
  const graph: CauseGraph = {
    parents(id, context) {
      record('parents', id, context);
      return { complete: true, edges: links.filter((row) => row[1] === id).map((row) => edge(row[0])) };
    },
    children(id, context) {
      record('children', id, context);
      return { complete: true, edges: links.filter((row) => row[0] === id).map((row) => edge(row[1])) };
    },
    attention(id, context) {
      record('attention', id, context);
      return id === 'selected' ? [mark] : [];
    },
    gaps(id, context) {
      record('gaps', id, context);
      return [];
    },
  };
  return { graph, reads };
}
const ancestors: [string, string][] = Array.from({ length: 10 }, (_, i) => [`a${i}`, i ? `a${i - 1}` : 'selected']);

describe('optional directional allowances within one query budget', () => {
  it('leaves capacity for a small complete impact after a large capped backward walk', async () => {
    const links: [string, string][] = [...ancestors, ['selected', 'child'], ['child', 'grandchild']];
    const original = await explain(fixture(links).graph, 'selected', { maxNodes: 6 });
    expect(original.impact.confidence).toBe('incomplete');
    const f = fixture(links);
    const result = await explain(f.graph, 'selected', {
      maxNodes: 6,
      backward: { maxNodes: 3 },
      impact: { maxNodes: 3 },
    });
    expect(result.rootCause).toBeUndefined();
    expect(codes(result)).toContain('node-limit');
    expect(result.impact.nodes).toEqual(['child', 'grandchild']);
    expect(result.impact.confidence).toBe('complete');
    expect(result.impact.gaps).toEqual([]);
    expect(f.reads.some((row) => row.id === 'a2')).toBe(false);
    expect(new Set(f.reads.map((row) => row.signal)).size).toBe(1);
  });

  it('does not spend global calls or cache refusals when backward calls run out', async () => {
    const f = fixture([['selected', 'child']]);
    const result = await explain(f.graph, 'selected', { maxCalls: 8, backward: { maxCalls: 1 } });
    expect(codes(result)).toContain('call-limit');
    expect(result.rootCause).toBeUndefined();
    expect(result.impact.nodes).toEqual(['child']);
    expect(result.impact.confidence).toBe('complete');
    expect(f.reads.filter((row) => row.id === 'selected' && row.method === 'attention')).toHaveLength(1);
    expect(f.reads.filter((row) => row.id === 'selected' && row.method === 'gaps')).toHaveLength(1);
    expect(f.reads).toHaveLength(6);
  });

  it('shares the hard call ceiling across both directions and rejects a guessed root', async () => {
    const f = fixture([
      ['parent', 'selected'],
      ['selected', 'child'],
    ]);
    const result = await explain(f.graph, 'selected', {
      maxCalls: 4,
      backward: { maxCalls: 3 },
      impact: { maxCalls: 4 },
    });
    expect(f.reads).toHaveLength(4);
    expect(result.rootCause).toBeUndefined();
    expect(codes(result)).toContain('call-limit');
    expect(result.impact.confidence).toBe('incomplete');
  });

  it('does not globally admit a node refused by the backward allowance', async () => {
    const result = await explain(
      fixture([
        ['parent', 'selected'],
        ['selected', 'child'],
      ]).graph,
      'selected',
      {
        maxNodes: 2,
        backward: { maxNodes: 1 },
        impact: { maxNodes: 2 },
      },
    );
    expect(result.rootCause).toBeUndefined();
    expect(result.impact.nodes).toEqual(['child']);
    expect(result.impact.confidence).toBe('complete');
  });

  it('counts globally cached identities again against the impact node allowance', async () => {
    const result = await explain(
      fixture([
        ['parent', 'selected'],
        ['selected', 'parent'],
      ]).graph,
      'selected',
      {
        maxNodes: 3,
        backward: { maxNodes: 2 },
        impact: { maxNodes: 1 },
      },
    );
    expect(result.impact.nodes).toEqual([]);
    expect(codes(result.impact)).toContain('node-limit');
  });

  it('shares the hard distinct-node ceiling even when each direction permits more', async () => {
    const f = fixture([
      ['parent', 'selected'],
      ['selected', 'child'],
    ]);
    const result = await explain(f.graph, 'selected', {
      maxNodes: 2,
      backward: { maxNodes: 2 },
      impact: { maxNodes: 2 },
    });
    expect(result.rootCause).toBe('selected');
    expect(codes(result.impact)).toContain('node-limit');
    expect(new Set(f.reads.map((row) => row.id)).size).toBeLessThanOrEqual(2);
  });

  it('caps backward edges without spending the impact edge allowance', async () => {
    const result = await explain(fixture([...ancestors, ['selected', 'child']]).graph, 'selected', {
      maxEdges: 3,
      backward: { maxEdges: 1 },
      impact: { maxEdges: 1 },
    });
    expect(codes(result)).toContain('edge-limit');
    expect(result.rootCause).toBeUndefined();
    expect(result.impact.nodes).toEqual(['child']);
    expect(result.impact.confidence).toBe('complete');
  });

  it('keeps the hard edge ceiling and a validated root when only impact runs out', async () => {
    const result = await explain(
      fixture([
        ['parent', 'selected'],
        ['selected', 'child'],
      ]).graph,
      'selected',
      {
        maxEdges: 1,
        backward: { maxEdges: 1 },
        impact: { maxEdges: 1 },
      },
    );
    expect(result.rootCause).toBe('selected');
    expect(result.impact.edges).toEqual([]);
    expect(codes(result.impact)).toContain('edge-limit');
  });

  it('uses independent depth bounds without declaring a depth-limited root', async () => {
    const result = await explain(
      fixture([
        ['parent', 'selected'],
        ['selected', 'child'],
      ]).graph,
      'selected',
      {
        backward: { maxDepth: 0 },
        impact: { maxDepth: 1 },
      },
    );
    expect(result.rootCause).toBeUndefined();
    expect(codes(result)).toContain('depth-limit');
    expect(result.impact.nodes).toEqual(['child']);
    expect(result.impact.confidence).toBe('complete');
    const leaf = await explain(fixture().graph, 'selected', {
      backward: { maxDepth: 0 },
      impact: { maxDepth: 0 },
    });
    expect(leaf.rootCause).toBe('selected');
    expect(leaf.confidence).toBe('complete');
  });

  it('charges root ranking to backward and impact ranking to impact', async () => {
    const rootRank = vi.fn(() => ['selected']),
      impactRank = vi.fn(() => []);
    const result = await explain(fixture().graph, 'selected', {
      backward: { maxCalls: 3 },
      impact: { maxCalls: 1 },
      rankRoots: rootRank,
      rankImpact: impactRank,
    });
    expect(rootRank).not.toHaveBeenCalled();
    expect(impactRank).not.toHaveBeenCalled();
    expect(result.rootCause).toBeUndefined();
    expect(codes(result)).toContain('strategy-failed');
    expect(codes(result.impact)).toContain('call-limit');
  });

  it('charges both rankings against the same global call limit', async () => {
    const rootRank = vi.fn(() => ['selected']),
      impactRank = vi.fn(() => []),
      f = fixture();
    const result = await explain(f.graph, 'selected', {
      maxCalls: 5,
      backward: { maxCalls: 4 },
      impact: { maxCalls: 2 },
      rankRoots: rootRank,
      rankImpact: impactRank,
    });
    expect(f.reads.length + rootRank.mock.calls.length + impactRank.mock.calls.length).toBe(5);
    expect(result.rootCause).toBe('selected');
    expect(impactRank).not.toHaveBeenCalled();
    expect(codes(result.impact)).toContain('call-limit');
  });

  it('uses one deadline even when a backward provider never finishes', async () => {
    const f = fixture(),
      signals: AbortSignal[] = [];
    f.graph.parents = (_id, context) => {
      signals.push(context.signal);
      return new Promise(() => {});
    };
    const result = await explain(f.graph, 'selected', {
      timeoutMs: 15,
      backward: { maxCalls: 3 },
      impact: { maxCalls: 3 },
    });
    expect(result.rootCause).toBeUndefined();
    expect(codes(result)).toContain('timeout');
    expect(codes(result.impact)).toContain('timeout');
    expect(signals[0].aborted).toBe(true);
    expect(f.reads.some((row) => row.method === 'children')).toBe(false);
  });

  it('does not let cached evidence bypass cancellation between directions', async () => {
    const controller = new AbortController(),
      f = fixture();
    const result = await explain(f.graph, 'selected', {
      signal: controller.signal,
      backward: { maxCalls: 4 },
      impact: { maxCalls: 2 },
      rankRoots() {
        controller.abort();
        return ['selected'];
      },
    });
    expect(result.rootCause).toBeUndefined();
    expect(codes(result.impact)).toContain('cancelled');
    expect(f.reads.some((row) => row.method === 'children')).toBe(false);
  });
});

describe('directional option boundary admission before dispatch', () => {
  for (const name of ['backward', 'impact'] as const) {
    for (const value of [
      null,
      [],
      5,
      { maxCalls: 0 },
      { maxNodes: -1 },
      { maxEdges: NaN },
      { maxDepth: 0.5 },
      { timeoutMs: 5 },
      { maxNodes: 101 },
    ]) {
      it(`rejects invalid ${name} ${JSON.stringify(value)} with a fixed error`, async () => {
        const f = fixture();
        await expect(explain(f.graph, 'selected', { [name]: value } as ExplainOptions)).rejects.toThrow(
          'CAUSE_CONFIGURATION_INVALID',
        );
        expect(f.reads).toEqual([]);
      });
    }
    it(`refuses ${name} accessors without reading them`, async () => {
      let reads = 0;
      const limits = Object.defineProperty({}, 'maxCalls', {
        get() {
          reads++;
          throw new Error('PRIVATE');
        },
      });
      await expect(explain(fixture().graph, 'selected', { [name]: limits } as ExplainOptions)).rejects.toThrow(
        'CAUSE_CONFIGURATION_INVALID',
      );
      expect(reads).toBe(0);
    });
  }
});
