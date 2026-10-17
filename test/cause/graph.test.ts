/** C1 facade: scenario, boundary and strategy witnesses over recorded dependency edges. */
import { describe, expect, it } from 'vitest';

import { attentionList, explain, largestDrop, mostAffected } from '../../src/cause.js';
import type { CauseGraph, Gap, GraphContext, GraphEdge, NodeId } from '../../src/cause.js';
import type { Attention } from '../../src/index.js';

type Link = { from: NodeId; to: NodeId; kind?: GraphEdge['kind'] };
type Read = { method: string; id: string; signal: AbortSignal };
const mark = (id: string): Attention => ({ kind: 'error', reason: 'ERROR_RECORDED', evidence: [`proof-${id}`] });

function fixture(
  links: readonly Link[],
  marks: Readonly<Record<string, readonly Attention[]>> = {},
  gaps: Readonly<Record<string, readonly Gap[]>> = {},
) {
  const reads: Read[] = [];
  const record = (method: string, id: string, context: GraphContext) =>
    reads.push({ method, id, signal: context.signal });
  const edge = (link: Link, id: string): GraphEdge => ({
    nodeId: id,
    kind: link.kind ?? 'data',
    attribution: link.kind === 'control' ? 'recorded-control' : 'per-write',
    evidence: [`edge-${link.from}-${link.to}`],
  });
  const graph: CauseGraph = {
    parents(id, context) {
      record('parents', id, context);
      return { edges: links.filter((link) => link.to === id).map((link) => edge(link, link.from)), complete: true };
    },
    children(id, context) {
      record('children', id, context);
      return { edges: links.filter((link) => link.from === id).map((link) => edge(link, link.to)), complete: true };
    },
    attention(id, context) {
      record('attention', id, context);
      return marks[id] ?? [];
    },
    gaps(id, context) {
      record('gaps', id, context);
      return gaps[id] ?? [];
    },
  };
  return { graph, reads };
}

const codes = (result: { gaps: readonly Gap[] }) => result.gaps.map((gap) => gap.code);

describe('cause facade over actual dependency edges', () => {
  it('finds the earliest marked dependency, keeps its proof, and does not open unrelated nodes', async () => {
    const f = fixture(
      [
        { from: 'source', to: 'middle' },
        { from: 'middle', to: 'symptom' },
        { from: 'unrelated', to: 'elsewhere' },
      ],
      { source: [mark('source')], symptom: [mark('symptom')], unrelated: [mark('unrelated')] },
    );
    const result = await explain(f.graph, 'symptom');
    expect(result.rootCause).toBe('source');
    expect(result.path).toEqual(['symptom', 'middle', 'source']);
    expect(result.attention).toEqual([mark('symptom')]);
    expect(result.confidence).toBe('complete');
    expect(result.gaps).toEqual([]);
    expect(result.alternatives).toEqual([]);
    expect(f.reads.some((read) => ['unrelated', 'elsewhere'].includes(read.id))).toBe(false);
  });

  it('can identify the selected marked node when there is no earlier marked dependency', async () => {
    const f = fixture([{ from: 'healthy', to: 'symptom' }], { symptom: [mark('symptom')] });
    const result = await explain(f.graph, 'symptom');
    expect(result.rootCause).toBe('symptom');
    expect(result.path).toEqual(['symptom']);
    expect(result.confidence).toBe('complete');
  });

  it('does not invent an abnormal root in a wholly unmarked graph', async () => {
    const result = await explain(fixture([{ from: 'healthy', to: 'normal' }]).graph, 'normal');
    expect(result.rootCause).toBeUndefined();
    expect(result.alternatives).toEqual([]);
    expect(result.attention).toEqual([]);
    expect(result.confidence).toBe('complete');
  });

  it('keeps independent ancestors tied even when their execution indices differ', async () => {
    const f = fixture(
      [
        { from: 'left#0', to: 'symptom#10' },
        { from: 'right#9', to: 'symptom#10' },
      ],
      { 'left#0': [mark('left')], 'right#9': [mark('right')], 'symptom#10': [mark('symptom')] },
    );
    const result = await explain(f.graph, 'symptom#10');
    expect(result.rootCause).toBeUndefined();
    expect(new Set(result.alternatives)).toEqual(new Set(['left#0', 'right#9']));
    expect(result.confidence).toBe('complete');
  });

  it('ranks by causal ancestry rather than nearest distance or display order', async () => {
    const f = fixture(
      [
        { from: 'z-earliest', to: 'a-nearer' },
        { from: 'a-nearer', to: 'symptom' },
      ],
      { 'z-earliest': [mark('earliest')], 'a-nearer': [mark('nearer')], symptom: [mark('symptom')] },
    );
    const result = await explain(f.graph, 'symptom');
    expect(result.rootCause).toBe('z-earliest');
    expect(result.path).toEqual(['symptom', 'a-nearer', 'z-earliest']);
  });

  it('retains the earliest mark independently on each converging branch', async () => {
    const f = fixture(
      [
        { from: 'upstream', to: 'left' },
        { from: 'left', to: 'join' },
        { from: 'right', to: 'join' },
      ],
      { upstream: [mark('upstream')], left: [mark('left')], right: [mark('right')], join: [mark('join')] },
    );
    const result = await explain(f.graph, 'join');
    expect(result.rootCause).toBeUndefined();
    expect(new Set(result.alternatives)).toEqual(new Set(['upstream', 'right']));
  });

  it('walks recorded control dependencies and then the decider’s recorded data dependencies', async () => {
    const f = fixture(
      [
        { from: 'input', to: 'decide' },
        { from: 'decide', to: 'branch', kind: 'control' },
        { from: 'branch', to: 'result' },
      ],
      { input: [mark('input')], result: [mark('result')] },
    );
    const result = await explain(f.graph, 'result');
    expect(result.rootCause).toBe('input');
    expect(result.path).toEqual(['result', 'branch', 'decide', 'input']);
    const impact = await explain(f.graph, 'decide');
    expect(impact.impact.edges).toContainEqual(
      expect.objectContaining({
        from: 'decide',
        to: 'branch',
        kind: 'control',
        attribution: 'recorded-control',
        evidence: ['edge-decide-branch'],
      }),
    );
  });

  it('reports impact from the selected node, excluding its ancestors and unrelated components', async () => {
    const f = fixture(
      [
        { from: 'upstream', to: 'selected' },
        { from: 'selected', to: 'left' },
        { from: 'selected', to: 'right' },
        { from: 'left', to: 'join' },
        { from: 'right', to: 'join' },
        { from: 'elsewhere', to: 'unrelated' },
      ],
      { upstream: [mark('upstream')] },
    );
    const result = await explain(f.graph, 'selected');
    expect(new Set(result.impact.nodes)).toEqual(new Set(['left', 'right', 'join']));
    expect(new Set(result.impact.edges.map((edge) => `${edge.from}:${edge.to}`))).toEqual(
      new Set(['selected:left', 'selected:right', 'left:join', 'right:join']),
    );
    expect(result.impact.confidence).toBe('complete');
    expect(f.reads.some((read) => ['elsewhere', 'unrelated'].includes(read.id))).toBe(false);
  });

  it('memoizes shared-node facts without confusing a diamond with a cycle', async () => {
    const f = fixture(
      [
        { from: 'root', to: 'left' },
        { from: 'root', to: 'right' },
        { from: 'left', to: 'selected' },
        { from: 'right', to: 'selected' },
      ],
      { root: [mark('root')] },
    );
    const result = await explain(f.graph, 'selected');
    expect(result.rootCause).toBe('root');
    expect(result.confidence).toBe('complete');
    expect(codes(result)).not.toContain('cycle');
    for (const method of ['parents', 'attention', 'gaps']) {
      expect(f.reads.filter((read) => read.id === 'root' && read.method === method)).toHaveLength(1);
    }
  });

  it('preserves loop execution identities without treating a repeated stage name as a cycle', async () => {
    const f = fixture(
      [
        { from: 'attempt#1', to: 'route#2' },
        { from: 'route#2', to: 'attempt#3' },
        { from: 'attempt#3', to: 'done#4' },
      ],
      { 'attempt#1': [mark('attempt-first')], 'done#4': [mark('done')] },
    );
    const result = await explain(f.graph, 'done#4');
    expect(result.rootCause).toBe('attempt#1');
    expect(result.path).toEqual(['done#4', 'attempt#3', 'route#2', 'attempt#1']);
    expect(codes(result)).not.toContain('cycle');
  });

  it('keeps key-qualified writes separate when they belong to the same execution', async () => {
    const f = fixture(
      [
        { from: 'a', to: 'stage-write-x' },
        { from: 'b', to: 'stage-write-y' },
        { from: 'stage-write-x', to: 'consumer' },
      ],
      { a: [mark('a')], b: [mark('b')], consumer: [mark('consumer')] },
    );
    const result = await explain(f.graph, 'consumer');
    expect(result.rootCause).toBe('a');
    expect(f.reads.some((read) => ['b', 'stage-write-y'].includes(read.id))).toBe(false);
  });

  it('accepts synchronous and asynchronous graph ports with the same results', async () => {
    const make = () => fixture([{ from: 'source', to: 'selected' }], { source: [mark('source')] }).graph;
    const synchronous = make();
    const base = make();
    const asynchronous: CauseGraph = {
      parents: async (id, context) => base.parents(id, context),
      children: async (id, context) => base.children(id, context),
      attention: async (id, context) => base.attention(id, context),
      gaps: async (id, context) => base.gaps(id, context),
    };
    expect(await explain(asynchronous, 'selected')).toEqual(await explain(synchronous, 'selected'));
  });
});

describe('bounded coverage', () => {
  it('withholds a root when the reverse adjacency says its evidence is incomplete', async () => {
    const f = fixture([], { selected: [mark('selected')] });
    f.graph.parents = () => ({ edges: [], complete: false });
    const result = await explain(f.graph, 'selected');
    expect(result.confidence).toBe('incomplete');
    expect(result.rootCause).toBeUndefined();
    expect(result.gaps.length).toBeGreaterThan(0);
  });

  it('preserves a recorded gap rather than reporting a healthy empty dependency set', async () => {
    const result = await explain(
      fixture(
        [],
        { selected: [mark('selected')] },
        { selected: [{ code: 'untracked-input', nodeId: 'selected', evidence: ['read-coverage'] }] },
      ).graph,
      'selected',
    );
    expect(result.confidence).toBe('incomplete');
    expect(result.rootCause).toBeUndefined();
    expect(codes(result)).toContain('untracked-input');
  });

  it('detects a real dependency cycle, terminates and withholds a root', async () => {
    const f = fixture(
      [
        { from: 'left', to: 'right' },
        { from: 'right', to: 'left' },
      ],
      { left: [mark('left')] },
    );
    const result = await explain(f.graph, 'left');
    expect(codes(result)).toContain('cycle');
    expect(result.confidence).toBe('incomplete');
    expect(result.rootCause).toBeUndefined();
    expect(f.reads.length).toBeLessThan(30);
  });

  it('reports a depth cut when an unexplored dependency remains', async () => {
    const result = await explain(
      fixture(
        [
          { from: 'source', to: 'middle' },
          { from: 'middle', to: 'selected' },
        ],
        { source: [mark('source')] },
      ).graph,
      'selected',
      { maxDepth: 1 },
    );
    expect(codes(result)).toContain('depth-limit');
    expect(result.confidence).toBe('incomplete');
    expect(result.rootCause).toBeUndefined();
  });

  it('does not mark a genuine leaf incomplete simply because it lies at the depth limit', async () => {
    const result = await explain(
      fixture([{ from: 'source', to: 'selected' }], { source: [mark('source')] }).graph,
      'selected',
      { maxDepth: 1 },
    );
    expect(result.rootCause).toBe('source');
    expect(codes(result)).not.toContain('depth-limit');
    expect(result.confidence).toBe('complete');
  });

  it('bounds unique nodes and reports a node cut', async () => {
    const f = fixture(
      [
        { from: 'source', to: 'middle' },
        { from: 'middle', to: 'selected' },
      ],
      { source: [mark('source')] },
    );
    const result = await explain(f.graph, 'selected', { maxNodes: 2 });
    expect(codes(result)).toContain('node-limit');
    expect(result.rootCause).toBeUndefined();
    expect(new Set(f.reads.map((read) => read.id)).size).toBeLessThanOrEqual(2);
  });

  it('reports an edge cut on a high-fan-out dependency set', async () => {
    const f = fixture(
      [
        { from: 'left', to: 'selected' },
        { from: 'right', to: 'selected' },
      ],
      { left: [mark('left')], right: [mark('right')] },
    );
    const result = await explain(f.graph, 'selected', { maxEdges: 1 });
    expect(codes(result)).toContain('edge-limit');
    expect(result.confidence).toBe('incomplete');
    expect(result.rootCause).toBeUndefined();
  });

  it('never dispatches more graph calls than its total call budget', async () => {
    const f = fixture([{ from: 'source', to: 'selected' }], { source: [mark('source')] });
    const result = await explain(f.graph, 'selected', { maxCalls: 2 });
    expect(codes(result)).toContain('call-limit');
    expect(f.reads.length).toBeLessThanOrEqual(2);
    expect(result.confidence).toBe('incomplete');
  });

  it('shares the node budget between reverse discovery and forward impact', async () => {
    const f = fixture(
      [
        { from: 'upstream', to: 'selected' },
        { from: 'selected', to: 'one' },
        { from: 'one', to: 'two' },
      ],
      { upstream: [mark('upstream')] },
    );
    const result = await explain(f.graph, 'selected', { maxNodes: 3 });
    expect(result.impact.confidence).toBe('incomplete');
    expect([...codes(result), ...codes(result.impact)]).toContain('node-limit');
    expect(new Set(f.reads.map((read) => read.id)).size).toBeLessThanOrEqual(3);
  });
});

describe('bounded attention discovery and ranking strategies', () => {
  it('accepts an impact permutation over validated descendant references while preserving dependency proof', async () => {
    const f = fixture(
      [
        { from: 'selected', to: 'first' },
        { from: 'selected', to: 'second' },
        { from: 'first', to: 'third' },
      ],
      { selected: [mark('selected')] },
    );
    let calls = 0;
    const result = await explain(f.graph, 'selected', {
      rankImpact: (nodes, context) => {
        calls++;
        expect(nodes).toEqual(['first', 'second', 'third']);
        expect(context.signal).toBeInstanceOf(AbortSignal);
        expect(context.signal.aborted).toBe(false);
        return ['third', 'second', 'first'];
      },
    });
    expect(calls).toBe(1);
    expect(result.impact.nodes).toEqual(['third', 'second', 'first']);
    expect(new Set(result.impact.edges.map((edge) => `${edge.from}:${edge.to}`))).toEqual(
      new Set(['selected:first', 'selected:second', 'first:third']),
    );
    expect(result.rootCause).toBe('selected');
    expect(result.impact.confidence).toBe('complete');
  });

  it('charges impact ranking to the same call budget as graph expansion', async () => {
    const make = () => fixture([{ from: 'selected', to: 'child' }], { selected: [mark('selected')] });
    const baseline = make();
    await explain(baseline.graph, 'selected');
    const f = make();
    let calls = 0;
    const result = await explain(f.graph, 'selected', {
      maxCalls: baseline.reads.length,
      rankImpact: (nodes) => {
        calls++;
        return nodes;
      },
    });
    expect(calls).toBe(0);
    expect(codes(result.impact)).toContain('call-limit');
    expect(result.impact.nodes).toEqual(['child']);
    expect(result.impact.confidence).toBe('incomplete');
    expect(f.reads.length).toBeLessThanOrEqual(baseline.reads.length);
  });

  it('lists explicit marked nodes without asking an optional global roots port', async () => {
    const f = fixture([], { one: [mark('one')], two: [mark('two')] });
    let rootsCalls = 0;
    f.graph.roots = () => {
      rootsCalls++;
      return ['private-unrequested'];
    };
    const result = await attentionList(f.graph, { nodeIds: ['one', 'two'] });
    expect(result.nodes).toEqual([
      { nodeId: 'one', attention: [mark('one')] },
      { nodeId: 'two', attention: [mark('two')] },
    ]);
    expect(rootsCalls).toBe(0);
    expect(result.confidence).toBe('complete');
  });

  it('uses optional host roots and recorded children for lazy attention discovery', async () => {
    const f = fixture([{ from: 'root', to: 'child' }], { child: [mark('child')] });
    let rootsCalls = 0;
    f.graph.roots = () => {
      rootsCalls++;
      return ['root'];
    };
    const result = await attentionList(f.graph);
    expect(rootsCalls).toBe(1);
    expect(result.nodes).toEqual([{ nodeId: 'child', attention: [mark('child')] }]);
    expect(result.confidence).toBe('complete');
  });

  it('reports missing discovery evidence rather than pretending an arbitrary graph has no marks', async () => {
    const result = await attentionList(fixture([]).graph);
    expect(result.nodes).toEqual([]);
    expect(result.confidence).toBe('incomplete');
    expect(result.gaps.length).toBeGreaterThan(0);
  });

  for (const [name, strategy] of [
    ['largestDrop', largestDrop],
    ['mostAffected', mostAffected],
  ] as const) {
    it(`${name} selects the maximum supplied score without changing dependency evidence`, async () => {
      const f = fixture(
        [
          { from: 'left', to: 'selected' },
          { from: 'right', to: 'selected' },
        ],
        { left: [mark('left')], right: [mark('right')] },
      );
      const result = await explain(f.graph, 'selected', {
        rankRoots: strategy(
          new Map([
            ['left', 0.2],
            ['right', 0.8],
          ]),
        ),
      });
      expect(result.rootCause).toBe('right');
      expect(result.path).toEqual(['selected', 'right']);
    });

    it(`${name} preserves a tied maximum as alternatives`, async () => {
      const f = fixture(
        [
          { from: 'left', to: 'selected' },
          { from: 'right', to: 'selected' },
        ],
        { left: [mark('left')], right: [mark('right')] },
      );
      const result = await explain(f.graph, 'selected', {
        rankRoots: strategy(
          new Map([
            ['left', 2],
            ['right', 2],
          ]),
        ),
      });
      expect(result.rootCause).toBeUndefined();
      expect(new Set(result.alternatives)).toEqual(new Set(['left', 'right']));
    });

    for (const [problem, scores] of [
      ['missing score', new Map<string, number>([['left', 1]])],
      [
        'NaN score',
        new Map<string, number>([
          ['left', 1],
          ['right', NaN],
        ]),
      ],
      [
        'infinite score',
        new Map<string, number>([
          ['left', 1],
          ['right', Infinity],
        ]),
      ],
    ] as const) {
      it(`${name} reports a ${problem} instead of fabricating a complete tied tier`, async () => {
        const f = fixture(
          [
            { from: 'left', to: 'selected' },
            { from: 'right', to: 'selected' },
          ],
          { left: [mark('left')], right: [mark('right')] },
        );
        const result = await explain(f.graph, 'selected', { rankRoots: strategy(scores) });
        expect(result.rootCause).toBeUndefined();
        expect(result.confidence).toBe('incomplete');
        expect(codes(result)).toContain('strategy-failed');
      });
    }
  }
});
