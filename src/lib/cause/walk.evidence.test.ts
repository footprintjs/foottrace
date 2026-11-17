import { describe, expect, it } from 'vitest';
import { attentionList, explain, type Adjacency, type CauseGraph, type Gap } from '../../cause.js';
import { Session } from './session.js';
import { walk } from './walk.js';

const empty = (): Adjacency => ({ edges: [], complete: true });
const reason = (ref: string): Gap => ({ code: 'redacted', nodeId: 'selected', evidence: [ref] });
function fixture(parents: Adjacency = empty(), children: Adjacency = empty(), gaps: readonly Gap[] = []) {
  const calls: string[] = [];
  const graph: CauseGraph = {
    parents() {
      calls.push('parents');
      return parents;
    },
    children() {
      calls.push('children');
      return children;
    },
    attention() {
      calls.push('attention');
      return [{ kind: 'error', reason: 'ERROR_RECORDED', evidence: ['proof:selected'] }];
    },
    gaps() {
      calls.push('gaps');
      return gaps;
    },
  };
  return { graph, calls };
}
const page = (gaps: readonly Gap[], complete = false): Adjacency => ({ edges: [], complete, gaps });

describe('page coverage stays in its traversal direction', () => {
  it('retains child-page reasons in the attention discovery walk', async () => {
    const why = reason('proof:discovery');
    const f = fixture(empty(), page([why]));
    const result = await attentionList(f.graph, { nodeIds: ['selected'] });
    expect(result.nodes.map((node) => node.nodeId)).toEqual(['selected']);
    expect(result.confidence).toBe('incomplete');
    expect(result.gaps).toEqual([why]);
    expect(f.calls).toEqual(['attention', 'gaps', 'children']);
  });

  it('does not read parent-only limitations during attention discovery', async () => {
    const f = fixture(page([reason('proof:parents')]));
    const result = await attentionList(f.graph, { nodeIds: ['selected'] });
    expect(result.confidence).toBe('complete');
    expect(result.gaps).toEqual([]);
    expect(f.calls).toEqual(['attention', 'gaps', 'children']);
  });

  it('retains parent references only in backward coverage', async () => {
    const why = reason('proof:parents');
    const result = await explain(fixture(page([why])).graph, 'selected', { includeBackward: true });
    expect(result.backward?.gaps).toEqual([why]);
    expect(result.backward?.confidence).toBe('incomplete');
    expect(result.rootCause).toBeUndefined();
    expect(result.impact.gaps).toEqual([]);
    expect(result.impact.confidence).toBe('complete');
    expect(result.gaps).toEqual([why]);
  });

  it('keeps an independently supported root when only impact is incomplete', async () => {
    const why = reason('proof:children');
    const result = await explain(fixture(empty(), page([why])).graph, 'selected', { includeBackward: true });
    expect(result.rootCause).toBe('selected');
    expect(result.backward?.gaps).toEqual([]);
    expect(result.backward?.confidence).toBe('complete');
    expect(result.impact.gaps).toEqual([why]);
    expect(result.impact.confidence).toBe('incomplete');
    expect(result.confidence).toBe('incomplete');
    expect(result.gaps).toEqual([why]);
  });

  it('retains node-wide coverage in both directions without extra graph calls', async () => {
    const why = reason('proof:node'),
      f = fixture(empty(), empty(), [why]);
    const result = await explain(f.graph, 'selected', { includeBackward: true });
    expect(result.backward?.gaps).toEqual([why]);
    expect(result.impact.gaps).toEqual([why]);
    expect(result.rootCause).toBeUndefined();
    expect(f.calls).toEqual(['attention', 'gaps', 'parents', 'children']);
  });

  for (const legacy of [
    { edges: [], complete: false },
    { edges: [], complete: false, gaps: [] },
  ]) {
    it('keeps the fixed fallback for a missing or empty page reason', async () => {
      const nodeReason = reason('proof:node');
      const result = await explain(fixture(legacy, empty(), [nodeReason]).graph, 'selected', { includeBackward: true });
      expect(result.backward?.gaps).toEqual([nodeReason, { code: 'not-collected', nodeId: 'selected', evidence: [] }]);
      expect(result.rootCause).toBeUndefined();
    });
  }

  it('does not synthesize an additional fallback when an incomplete page explains its gap', async () => {
    const why = reason('proof:page');
    const result = await explain(fixture(page([why])).graph, 'selected', { includeBackward: true });
    expect(result.backward?.gaps).toEqual([why]);
  });

  it('retains explicit reasons even for completely enumerated pages', async () => {
    const parent = reason('proof:parents'),
      child = reason('proof:children');
    const result = await explain(fixture(page([parent], true), page([child], true)).graph, 'selected', {
      includeBackward: true,
    });
    expect(result.backward?.gaps).toEqual([parent]);
    expect(result.impact.gaps).toEqual([child]);
    expect(result.rootCause).toBeUndefined();
  });

  it('leaves the existing omitted-backward result shape intact', async () => {
    const result = await explain(fixture().graph, 'selected');
    expect(Object.hasOwn(result, 'backward')).toBe(false);
    expect(result.rootCause).toBe('selected');
    expect(result.gaps).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('turns hostile page evidence into fixed non-leaking refusal', async () => {
    let reads = 0;
    const raw = Object.defineProperty(empty(), 'gaps', {
      get() {
        reads++;
        throw new Error('PRIVATE');
      },
    });
    const result = await explain(fixture(raw).graph, 'selected', { includeBackward: true });
    expect(result.backward?.gaps).toEqual([{ code: 'invalid-data', nodeId: 'selected', evidence: [] }]);
    expect(result.impact.gaps).toEqual([]);
    expect(result.rootCause).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(reads).toBe(0);
  });

  it('normalizes a throwing page descriptor trap without exposing its message', async () => {
    const raw = new Proxy(empty(), {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'gaps') throw new Error('PRIVATE');
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const result = await explain(fixture(raw).graph, 'selected', { includeBackward: true });
    expect(result.backward?.gaps).toEqual([{ code: 'invalid-data', nodeId: 'selected', evidence: [] }]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
});

describe('joint caller-gap allowance and deterministic directional caching', () => {
  it('admits exactly 31 node reasons plus one page reason', async () => {
    const node = Array.from({ length: 31 }, (_, i) => reason(`proof:node:${i}`)),
      why = reason('proof:page');
    const result = await explain(fixture(page([why]), empty(), node).graph, 'selected', { includeBackward: true });
    expect(result.backward?.gaps).toEqual([...node, why]);
    expect(result.impact.gaps).toEqual(node);
  });

  it('does not count the legacy diagnostic fallback as a supplied slot', async () => {
    const node = Array.from({ length: 32 }, (_, i) => reason(`proof:node:${i}`));
    const result = await explain(fixture(page([]), empty(), node).graph, 'selected', { includeBackward: true });
    expect(result.backward?.gaps).toEqual([...node, { code: 'not-collected', nodeId: 'selected', evidence: [] }]);
    expect(result.backward?.gaps.some((gap) => gap.code === 'invalid-data')).toBe(false);
  });

  it('refuses the overflowing page atomically while retaining node reasons', async () => {
    const node = Array.from({ length: 32 }, (_, i) => reason(`proof:node:${i}`));
    const raw: Adjacency = {
      edges: [{ nodeId: 'unadmitted', kind: 'data', attribution: 'per-write', evidence: ['proof:edge'] }],
      complete: true,
      gaps: [reason('proof:overflow')],
    };
    const result = await explain(fixture(raw, empty(), node).graph, 'selected', { includeBackward: true });
    expect(result.backward?.gaps).toEqual([...node, { code: 'invalid-data', nodeId: 'selected', evidence: [] }]);
    expect(result.backward?.edges).toEqual([]);
    expect(result.backward?.nodes).toEqual(['selected']);
    expect(result.impact.gaps).toEqual(node);
  });

  it('charges duplicate raw entries before final gap de-duplication', async () => {
    const same = reason('proof:same');
    const result = await explain(fixture(page([same]), empty(), Array(32).fill(same)).graph, 'selected', {
      includeBackward: true,
    });
    expect(result.backward?.gaps).toEqual([same, { code: 'invalid-data', nodeId: 'selected', evidence: [] }]);
    expect(result.impact.gaps).toEqual([same]);
  });

  it('does not spend diagnostic node-read refusals as supplied entries', async () => {
    const supplied = Array.from({ length: 32 }, (_, i) => reason(`proof:page:${i}`));
    const f = fixture(page(supplied, true));
    f.graph.gaps = () => {
      throw new Error('PRIVATE');
    };
    const result = await explain(f.graph, 'selected', { includeBackward: true });
    expect(result.backward?.gaps).toEqual([{ code: 'unavailable', nodeId: 'selected', evidence: [] }, ...supplied]);
    expect(result.impact.gaps).toEqual([{ code: 'unavailable', nodeId: 'selected', evidence: [] }]);
    expect(result.rootCause).toBeUndefined();
  });

  for (const first of ['parents', 'children'] as const) {
    it(`keeps joint admission stable when ${first} runs first, including cache reuse`, async () => {
      const node = Array.from({ length: 31 }, (_, i) => reason(`proof:node:${i}`));
      const parent = reason('proof:parents'),
        children = [reason('proof:child:1'), reason('proof:child:2')];
      const f = fixture(page([parent], true), page(children, true), node);
      const session = new Session(f.graph);
      try {
        const second = first === 'parents' ? 'children' : 'parents';
        const a = await walk(
          session,
          session.direction(first === 'parents' ? 'backward' : 'impact'),
          ['selected'],
          first,
        );
        node[0] = reason('proof:host-mutated');
        const b = await walk(
          session,
          session.direction(second === 'parents' ? 'backward' : 'impact'),
          ['selected'],
          second,
        );
        const byDirection = new Map([
          [first, a],
          [second, b],
        ]);
        const expected = Array.from({ length: 31 }, (_, i) => reason(`proof:node:${i}`));
        expect(byDirection.get('parents')?.gaps).toEqual([...expected, parent]);
        expect(byDirection.get('children')?.gaps).toEqual([
          ...expected,
          { code: 'invalid-data', nodeId: 'selected', evidence: [] },
        ]);
        const repeated = await walk(session, session.direction('backward'), ['selected'], 'parents');
        expect(repeated.gaps).toEqual([...expected, parent]);
        expect(f.calls.filter((method) => method === 'gaps')).toHaveLength(1);
        expect(f.calls.filter((method) => method === 'attention')).toHaveLength(1);
        expect(f.calls.filter((method) => method === 'parents')).toHaveLength(1);
        expect(f.calls.filter((method) => method === 'children')).toHaveLength(1);
        expect(Object.isFrozen(repeated.gaps)).toBe(true);
      } finally {
        session.dispose();
      }
    });
  }
});
