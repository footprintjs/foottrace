import { describe, expect, it, vi } from 'vitest';
import { explain } from '../../src/cause.js';
import type { BackwardResult, CauseGraph, GraphContext, GraphEdge } from '../../src/cause.js';
import type { Attention } from '../../src/index.js';

interface Link {
  from: string;
  to: string;
  kind?: GraphEdge['kind'];
  attribution?: GraphEdge['attribution'];
  evidence?: readonly string[];
}
const mark = (id: string): Attention => ({ kind: 'error', reason: 'ERROR_RECORDED', evidence: [`mark:${id}`] });

function fixture(links: readonly Link[], marked: readonly string[] = ['root', 'selected']) {
  const calls: string[] = [];
  const note = (method: string, id: string, _context: GraphContext) => calls.push(`${method}:${id}`);
  const edge = (link: Link, nodeId: string): GraphEdge => ({
    nodeId,
    kind: link.kind ?? 'data',
    attribution: link.attribution ?? (link.kind === 'control' ? 'recorded-control' : 'per-write'),
    evidence: link.evidence ?? [`edge:${link.from}:${link.to}`],
  });
  const graph: CauseGraph = {
    parents(id, context) {
      note('parents', id, context);
      return { complete: true, edges: links.filter((link) => link.to === id).map((link) => edge(link, link.from)) };
    },
    children(id, context) {
      note('children', id, context);
      return { complete: true, edges: links.filter((link) => link.from === id).map((link) => edge(link, link.to)) };
    },
    attention(id, context) {
      note('attention', id, context);
      return marked.includes(id) ? [mark(id)] : [];
    },
    gaps(id, context) {
      note('gaps', id, context);
      return [];
    },
  };
  return { graph, calls };
}

const links: readonly Link[] = [
  { from: 'root', to: 'middle' },
  { from: 'middle', to: 'selected' },
  { from: 'selected', to: 'affected' },
];

describe('optional canonical backward evidence', () => {
  it('returns the existing admitted backward walk in dependent-to-cause order', async () => {
    const f = fixture(links);
    const result = await explain(f.graph, 'selected', { includeBackward: true });
    const backward: BackwardResult | undefined = result.backward;
    expect(backward).toEqual({
      nodes: ['selected', 'middle', 'root'],
      edges: [
        { from: 'selected', to: 'middle', kind: 'data', attribution: 'per-write', evidence: ['edge:middle:selected'] },
        { from: 'middle', to: 'root', kind: 'data', attribution: 'per-write', evidence: ['edge:root:middle'] },
      ],
      confidence: 'complete',
      gaps: [],
    });
    expect(result.rootCause).toBe('root');
    expect(result.impact.edges).toEqual([
      {
        from: 'selected',
        to: 'affected',
        kind: 'data',
        attribution: 'per-write',
        evidence: ['edge:selected:affected'],
      },
    ]);
    expect(backward!.nodes).not.toContain('affected');
  });

  it('preserves default bytes, false-option bytes and graph call order without a second walk', async () => {
    const old = fixture(links),
      off = fixture(links),
      on = fixture(links);
    const baseline = await explain(old.graph, 'selected');
    const disabled = await explain(off.graph, 'selected', { includeBackward: false });
    const included = await explain(on.graph, 'selected', { includeBackward: true });
    expect(Object.hasOwn(baseline, 'backward')).toBe(false);
    expect(Object.hasOwn(disabled, 'backward')).toBe(false);
    expect(JSON.stringify(disabled)).toBe(JSON.stringify(baseline));
    const { backward, ...existing } = included;
    expect(backward).toBeDefined();
    expect(JSON.stringify(existing)).toBe(JSON.stringify(baseline));
    expect(off.calls).toEqual(old.calls);
    expect(on.calls).toEqual(old.calls);
  });

  it('keeps parallel kinds, source evidence and diamond references without inventing a cycle', async () => {
    const f = fixture([
      { from: 'left', to: 'selected', attribution: 'recorded-read', evidence: ['read:1'] },
      { from: 'left', to: 'selected', kind: 'control', evidence: ['decision:1'] },
      { from: 'right', to: 'selected' },
      { from: 'root', to: 'left' },
      { from: 'root', to: 'right' },
    ]);
    const result = await explain(f.graph, 'selected', { includeBackward: true });
    expect(result.backward!.nodes).toEqual(['selected', 'left', 'right', 'root']);
    expect(result.backward!.edges.slice(0, 2)).toEqual([
      { from: 'selected', to: 'left', kind: 'data', attribution: 'recorded-read', evidence: ['read:1'] },
      { from: 'selected', to: 'left', kind: 'control', attribution: 'recorded-control', evidence: ['decision:1'] },
    ]);
    expect(result.backward!.edges).toHaveLength(5);
    expect(result.backward!.confidence).toBe('complete');
    expect(f.calls.filter((call) => call === 'parents:root')).toHaveLength(1);
  });

  it('keeps complete backward evidence and its root when only impact is truncated', async () => {
    const result = await explain(fixture(links).graph, 'selected', { includeBackward: true, impact: { maxDepth: 0 } });
    expect(result.rootCause).toBe('root');
    expect(result.backward!.confidence).toBe('complete');
    expect(result.backward!.gaps).toEqual([]);
    expect(result.impact.confidence).toBe('incomplete');
    expect(result.gaps).toContainEqual(expect.objectContaining({ code: 'depth-limit' }));
  });

  it.each([
    { name: 'nodes', backward: { maxNodes: 1 }, code: 'node-limit' },
    { name: 'depth', backward: { maxDepth: 0 }, code: 'depth-limit' },
    { name: 'edges', backward: { maxEdges: 1 }, code: 'edge-limit' },
    { name: 'calls', backward: { maxCalls: 1 }, code: 'call-limit' },
  ])('retains bounded partial evidence and the $name refusal without confirming a root', async ({ backward, code }) => {
    const f = fixture(links);
    const result = await explain(f.graph, 'selected', { includeBackward: true, backward });
    expect(result.backward!.confidence).toBe('incomplete');
    expect(result.backward!.gaps).toContainEqual(expect.objectContaining({ code }));
    expect(result.rootCause).toBeUndefined();
    for (const edge of result.backward!.edges) {
      expect(result.backward!.nodes).toContain(edge.from);
      expect(result.backward!.nodes).toContain(edge.to);
    }
  });

  it('retains only admitted links when evidence is redacted or a graph page is incomplete', async () => {
    const f = fixture(links);
    f.graph.parents = () => ({ complete: false, edges: [] });
    f.graph.gaps = () => [{ code: 'redacted', evidence: [] }];
    const result = await explain(f.graph, 'selected', { includeBackward: true });
    expect(result.backward).toEqual({
      nodes: ['selected'],
      edges: [],
      confidence: 'incomplete',
      gaps: expect.arrayContaining([
        expect.objectContaining({ code: 'redacted' }),
        expect.objectContaining({ code: 'not-collected' }),
      ]),
    });
    expect(result.rootCause).toBeUndefined();
  });

  it('does not upgrade conservative stage links into exact attribution or a confirmed root', async () => {
    const f = fixture([{ from: 'root', to: 'selected', attribution: 'stage' }]);
    const result = await explain(f.graph, 'selected', { includeBackward: true });
    expect(result.backward!.edges[0].attribution).toBe('stage');
    expect(result.backward!.gaps).toContainEqual(expect.objectContaining({ code: 'conservative' }));
    expect(result.rootCause).toBeUndefined();
  });

  it('reports cancellation in backward coverage without dispatching graph calls', async () => {
    const f = fixture(links),
      controller = new AbortController();
    controller.abort('PRIVATE_REASON');
    const result = await explain(f.graph, 'selected', { includeBackward: true, signal: controller.signal });
    expect(result.backward!.confidence).toBe('incomplete');
    expect(result.backward!.edges).toEqual([]);
    expect(result.backward!.gaps).toContainEqual(expect.objectContaining({ code: 'cancelled' }));
    expect(f.calls).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_REASON');
  });

  it('reports a bounded timeout in backward coverage without retaining a late page', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(links);
      f.graph.parents = () => new Promise(() => {});
      const pending = explain(f.graph, 'selected', { includeBackward: true, timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(50);
      const result = await pending;
      expect(result.backward!.confidence).toBe('incomplete');
      expect(result.backward!.edges).toEqual([]);
      expect(result.backward!.gaps).toContainEqual(expect.objectContaining({ code: 'timeout' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('freezes projected evidence without retaining arbitrary graph fields or source accessors', async () => {
    let accessorReads = 0;
    const f = fixture([]);
    const source = Object.defineProperty(
      { nodeId: 'root', kind: 'data', attribution: 'recorded-read', evidence: ['read:1'], rawValue: 'PRIVATE_VALUE' },
      'unused',
      {
        get() {
          accessorReads++;
          throw new Error('PRIVATE');
        },
      },
    );
    f.graph.parents = (id) => ({ complete: true, edges: id === 'selected' ? [source as GraphEdge] : [] });
    const result = await explain(f.graph, 'selected', { includeBackward: true });
    expect(accessorReads).toBe(0);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    for (const value of [
      result.backward,
      result.backward!.nodes,
      result.backward!.edges,
      result.backward!.edges[0],
      result.backward!.edges[0].evidence,
      result.backward!.gaps,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(Object.hasOwn(result.backward!.edges[0], 'rawValue')).toBe(false);
    expect(Object.isFrozen(source)).toBe(false);
  });

  it.each([null, 1, 'yes', {}, [], () => true])(
    'refuses invalid includeBackward configuration before graph dispatch %#',
    async (value) => {
      const f = fixture(links);
      await expect(explain(f.graph, 'selected', { includeBackward: value } as never)).rejects.toThrow(
        'CAUSE_CONFIGURATION_INVALID',
      );
      expect(f.calls).toEqual([]);
    },
  );

  it('refuses an option getter without invoking it or dispatching graph calls', async () => {
    const f = fixture(links),
      getter = vi.fn(() => true);
    const options = Object.defineProperty({}, 'includeBackward', { get: getter });
    await expect(explain(f.graph, 'selected', options)).rejects.toThrow('CAUSE_CONFIGURATION_INVALID');
    expect(getter).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });
});
