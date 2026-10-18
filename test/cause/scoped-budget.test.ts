import { describe, expect, it } from 'vitest';
import { QueryBudget } from '../../src/lib/cause/queryBudget.js';
import { Session } from '../../src/lib/cause/session.js';
import { walk } from '../../src/lib/cause/walk.js';
import type { CauseGraph, Gap, GraphContext } from '../../src/cause.js';

const noEdges = { edges: [], complete: true };
function fixture() {
  const reads: Array<{ name: string; id: string; signal: AbortSignal }> = [];
  const record = (name: string, id: string, context: GraphContext) => reads.push({ name, id, signal: context.signal });
  const graph: CauseGraph = {
    parents(id, context) {
      record('parents', id, context);
      return noEdges;
    },
    children(id, context) {
      record('children', id, context);
      return noEdges;
    },
    attention(id, context) {
      record('attention', id, context);
      return [];
    },
    gaps(id, context) {
      record('gaps', id, context);
      return [];
    },
  };
  return { graph, reads };
}
const codes = (value: { gaps: readonly Gap[] }) => value.gaps.map((gap) => gap.code);

describe('direction allowances are values rather than a mutable query mode', () => {
  it('binds extracted frozen methods to their own allowance despite interleaved access', () => {
    const budget = new QueryBudget({ maxCalls: 4, backward: { maxCalls: 1, maxDepth: 0 }, impact: { maxCalls: 3 } });
    const backward = budget.direction('backward'),
      impact = budget.direction('impact');
    expect(Object.isFrozen(backward)).toBe(true);
    expect(Object.isFrozen(impact)).toBe(true);
    const { takeCall: backCall } = backward,
      { takeCall: impactCall } = impact;
    expect(backward.maxDepth).toBe(0);
    expect(impact.maxDepth).toBe(20);
    expect(backCall()).toBeUndefined();
    expect(impactCall()).toBeUndefined();
    expect(backCall()?.code).toBe('call-limit');
    expect(impactCall()).toBeUndefined();
    expect(impactCall()).toBeUndefined();
    expect(budget.total.takeCall()?.code).toBe('call-limit');
    expect('enterDirection' in budget).toBe(false);
    expect('current' in budget).toBe(false);
  });

  it('reuses stable views without replenishing node, edge or call capacity', () => {
    const budget = new QueryBudget({ backward: { maxNodes: 1, maxEdges: 1, maxCalls: 1 } });
    const view = budget.direction('backward');
    expect(view.admit('one')).toBeUndefined();
    expect(view.takeEdge('one')).toBeUndefined();
    expect(view.takeCall('one')).toBeUndefined();
    budget.direction('impact').takeCall();
    expect(budget.direction('backward')).toBe(view);
    expect(budget.direction('backward').admit('two')?.code).toBe('node-limit');
    expect(budget.direction('backward').takeEdge('one')?.code).toBe('edge-limit');
    expect(budget.direction('backward').takeCall('one')?.code).toBe('call-limit');
    expect(budget.total).toBe(budget.total);
    expect(Object.isFrozen(budget.total)).toBe(true);
  });

  it('shares total ceilings but keeps each direction distinct when identities overlap', () => {
    const budget = new QueryBudget({ maxNodes: 2, maxEdges: 2, backward: { maxNodes: 1 }, impact: { maxNodes: 1 } });
    const back = budget.direction('backward'),
      impact = budget.direction('impact');
    expect(back.admit('shared')).toBeUndefined();
    expect(impact.admit('shared')).toBeUndefined();
    expect(back.admit('back-only')?.code).toBe('node-limit');
    expect(impact.admit('impact-only')?.code).toBe('node-limit');
    expect(budget.total.admit('remaining')).toBeUndefined();
    expect(budget.total.admit('extra')?.code).toBe('node-limit');
    expect(back.takeEdge('shared')).toBeUndefined();
    expect(impact.takeEdge('shared')).toBeUndefined();
    expect(back.takeEdge('shared')?.code).toBe('edge-limit');
  });

  it('does not spend global capacity on a local refusal when views are interleaved', () => {
    const budget = new QueryBudget({ maxCalls: 3, backward: { maxCalls: 1 } });
    const back = budget.direction('backward'),
      impact = budget.direction('impact');
    expect(back.takeCall()).toBeUndefined();
    for (let i = 0; i < 5; i++) expect(back.takeCall()?.code).toBe('call-limit');
    expect(impact.takeCall()).toBeUndefined();
    expect(impact.takeCall()).toBeUndefined();
    expect(impact.takeCall()?.code).toBe('call-limit');
  });

  it('attributes deferred dispatches and ranking calls to their explicit view', async () => {
    const f = fixture();
    const session = new Session(f.graph, { maxCalls: 4, backward: { maxCalls: 1 }, impact: { maxCalls: 3 } });
    try {
      const back = session.direction('backward'),
        impact = session.direction('impact');
      let release!: (value: string) => void;
      const pending = session.invoke(
        back,
        'selected',
        () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
        String,
      );
      const firstImpact = await session.invoke(impact, 'selected', () => 'impact', String);
      expect(firstImpact.value).toBe('impact');
      release('back');
      expect((await pending).value).toBe('back');
      let wrongCalls = 0;
      const refused = await session.invoke(
        back,
        'selected',
        () => {
          wrongCalls++;
          return 'wrong';
        },
        String,
      );
      expect(refused.gap?.code).toBe('call-limit');
      expect(wrongCalls).toBe(0);
      expect((await session.invoke(impact, undefined, () => 'rank-impact', String)).value).toBe('rank-impact');
      expect((await session.invoke(impact, undefined, () => 'last', String)).value).toBe('last');
      expect((await session.invoke(session.total, undefined, () => 'over', String)).gap?.code).toBe('call-limit');
    } finally {
      session.dispose();
    }
  });

  it('allows interleaved walks with separate quotas and a single cache and signal', async () => {
    const f = fixture();
    let release!: () => void;
    let parentDispatched!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      parentDispatched = resolve;
    });
    f.graph.parents = (id, context) => {
      f.reads.push({ name: 'parents', id, signal: context.signal });
      return new Promise((resolve) => {
        release = () => resolve(noEdges);
        parentDispatched();
      });
    };
    const session = new Session(f.graph, { maxCalls: 4, backward: { maxCalls: 3 }, impact: { maxCalls: 1 } });
    try {
      const pending = walk(session, session.direction('backward'), ['selected'], 'parents');
      // Let the backward walk dispatch its deferred parent read before the impact walk.
      await dispatched;
      expect(release).toBeTypeOf('function');
      const impact = await walk(session, session.direction('impact'), ['selected'], 'children');
      release();
      const backward = await pending;
      expect(backward.gaps).toEqual([]);
      expect(impact.gaps).toEqual([]);
      expect(f.reads.map((row) => row.name)).toEqual(['attention', 'gaps', 'parents', 'children']);
      expect(new Set(f.reads.map((row) => row.signal)).size).toBe(1);
    } finally {
      session.dispose();
    }
  });

  it('does not cache a view-local refusal as evidence for another view', async () => {
    const f = fixture(),
      session = new Session(f.graph, { maxCalls: 3, backward: { maxCalls: 1 } });
    try {
      const back = session.direction('backward'),
        impact = session.direction('impact');
      await session.invoke(back, undefined, () => 'rank', String);
      const refused = await session.read(back, 'gaps', 'selected', (value) => value);
      expect(refused.gap?.code).toBe('call-limit');
      const actual = await session.read(impact, 'gaps', 'selected', (value) => value);
      expect(actual.value).toEqual([]);
      expect(f.reads.map((row) => row.name)).toEqual(['gaps']);
    } finally {
      session.dispose();
    }
  });

  it('keeps cancellation and the deadline shared across all views', async () => {
    const f = fixture(),
      session = new Session(f.graph, { timeoutMs: 10, backward: { maxCalls: 1 }, impact: { maxCalls: 1 } });
    try {
      const pending = session.invoke(session.direction('backward'), undefined, () => new Promise(() => {}), String);
      expect((await pending).gap?.code).toBe('timeout');
      const impact = await walk(session, session.direction('impact'), ['selected'], 'children');
      expect(codes(impact)).toContain('timeout');
      expect(f.reads).toEqual([]);
    } finally {
      session.dispose();
    }
  });
});
