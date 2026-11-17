import { describe, expect, it, vi } from 'vitest';
import { attentionList, explain } from '../../cause.js';
import type { Attention, CauseGraph, ExplainOptions, Gap } from './types.js';

const mark = (ref: string): Attention => ({ kind: 'error', reason: 'ERROR_RECORDED', evidence: [ref] });
const bad = { kind: 'error', reason: 'PRIVATE_UNKNOWN_REASON', evidence: ['PRIVATE_INVALID_REF'] };
const retain = { attentionAdmission: 'retain-valid' as const, timeoutMs: 2000 };
const codes = (value: { gaps: readonly Gap[] }) => value.gaps.map((item) => item.code);
function fixture(raw: unknown, child?: unknown) {
  const calls: string[] = [];
  const graph: CauseGraph = {
    parents: () => ({ edges: [], complete: true }),
    children: (id) => ({
      edges:
        child !== undefined && id === 'selected'
          ? [{ nodeId: 'child', kind: 'data', attribution: 'per-write', evidence: ['edge'] }]
          : [],
      complete: true,
    }),
    attention(id) {
      calls.push(id);
      return (id === 'selected' ? raw : child) as readonly Attention[];
    },
    gaps: () => [],
  };
  return { graph, calls };
}

describe('opt-in generic attention admission', () => {
  it('retains valid neighbors but cannot turn a ranked survivor into a root', async () => {
    const f = fixture([mark('first'), bad, mark('last')]);
    const result = await explain(f.graph, 'selected', {
      ...retain,
      includeBackward: true,
      rankRoots: () => ['selected'],
    });
    expect(result.attention).toEqual([mark('first'), mark('last')]);
    expect(result.rootCause).toBeUndefined();
    expect(result.path).toEqual([]);
    expect(result.backward?.confidence).toBe('incomplete');
    expect(result.backward?.gaps).toContainEqual({ code: 'invalid-data', nodeId: 'selected', evidence: [] });
    expect(f.calls).toEqual(['selected']);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  });

  it('lists partially marked nodes with their explicit incomplete coverage', async () => {
    const result = await attentionList(fixture([mark('first'), bad, mark('last')]).graph, {
      ...retain,
      nodeIds: ['selected'],
    });
    expect(result.nodes).toEqual([{ nodeId: 'selected', attention: [mark('first'), mark('last')] }]);
    expect(result.confidence).toBe('incomplete');
    expect(codes(result)).toContain('invalid-data');
  });

  it('keeps omitted and explicit atomic behavior identical in both queries', async () => {
    const f = fixture([mark('first'), bad, mark('last')]);
    const implicit = await explain(f.graph, 'selected');
    const explicit = await explain(f.graph, 'selected', { attentionAdmission: 'atomic', timeoutMs: 2000 });
    expect(explicit).toEqual(implicit);
    expect(explicit.attention).toEqual([]);
    expect(codes(explicit)).toEqual(['invalid-data']);
    const list = await attentionList(f.graph, { nodeIds: ['selected'] });
    expect(list.nodes).toEqual([]);
    expect(codes(list)).toEqual(['invalid-data']);
  });

  it.each([{ raw: [] }, { raw: [bad] }, { raw: [bad, bad] }])(
    'keeps empty and rejected-only lists distinct: %j',
    async ({ raw }) => {
      const result = await attentionList(fixture(raw).graph, { ...retain, nodeIds: ['selected'] });
      expect(result.nodes).toEqual([]);
      expect(result.confidence).toBe(raw.length ? 'incomplete' : 'complete');
      expect(codes(result)).toEqual(raw.length ? ['invalid-data'] : []);
    },
  );

  for (const kind of ['hole', 'accessor'] as const) {
    it(`rejects a ${kind} slot without executing a getter or dropping valid neighbors`, async () => {
      let gets = 0;
      const raw = [mark('first'), bad, mark('last')];
      if (kind === 'hole') delete raw[1];
      else Object.defineProperty(raw, '1', { get: () => (++gets, bad) });
      const result = await explain(fixture(raw).graph, 'selected', retain);
      expect(result.attention).toEqual([mark('first'), mark('last')]);
      expect(codes(result)).toContain('invalid-data');
      expect(gets).toBe(0);
    });
  }

  it('refuses an oversized raw list before reading even its first payload slot', async () => {
    let gets = 0;
    const raw = Array.from({ length: 33 }, () => mark('duplicate'));
    Object.defineProperty(raw, '0', { get: () => (++gets, mark('first')) });
    const result = await explain(fixture(raw).graph, 'selected', retain);
    expect(result.attention).toEqual([]);
    expect(codes(result)).toContain('invalid-data');
    expect(gets).toBe(0);
  });

  it('retains all 32 raw duplicates without deduplication', async () => {
    const raw = Array.from({ length: 32 }, () => mark('duplicate'));
    const result = await explain(fixture(raw).graph, 'selected', retain);
    expect(result.attention).toEqual(raw);
    expect(result.attention).toHaveLength(32);
    expect(result.rootCause).toBe('selected');
  });

  it.each([{ raw: null }, { raw: {} }, { raw: Object.setPrototypeOf([], null) }])(
    'keeps outer shape refusal atomic: %j',
    async ({ raw }) => {
      const result = await explain(fixture(raw).graph, 'selected', retain);
      expect(result.attention).toEqual([]);
      expect(codes(result)).toContain('invalid-data');
    },
  );

  it('rejects only the mark with invalid reference caps or reference accessors', async () => {
    let gets = 0;
    const refs = ['first'];
    Object.defineProperty(refs, '0', { get: () => (++gets, 'secret') });
    const raw = [
      mark('valid'),
      { ...mark('too-many'), evidence: Array.from({ length: 17 }, () => 'ref') },
      mark('x'.repeat(513)),
      { ...mark('accessor'), evidence: refs },
      mark('x'.repeat(512)),
    ];
    const result = await explain(fixture(raw).graph, 'selected', retain);
    expect(result.attention).toEqual([mark('valid'), mark('x'.repeat(512))]);
    expect(codes(result)).toContain('invalid-data');
    expect(gets).toBe(0);
  });

  it('copies and deeply freezes admitted marks while keeping duplicate order', async () => {
    const first = mark('first');
    const raw = [first, bad, first, mark('last')];
    const result = await explain(fixture(raw).graph, 'selected', retain);
    expect(result.attention).toEqual([first, first, mark('last')]);
    expect(Object.isFrozen(result.attention)).toBe(true);
    for (const item of result.attention) {
      expect(Object.isFrozen(item)).toBe(true);
      expect(Object.isFrozen(item.evidence)).toBe(true);
    }
    expect(Object.isFrozen(raw)).toBe(false);
    expect(Object.isFrozen(first)).toBe(false);
    expect(result.attention[0]).not.toBe(first);
    (first.evidence as string[]).push('later');
    expect(result.attention[0].evidence).toEqual(['first']);
  });

  it('retains not-collected and invalid-data as separate actual obligations', async () => {
    const missing: Attention = { kind: 'not-collected', reason: 'EVIDENCE_NOT_COLLECTED', evidence: [] };
    const result = await explain(fixture([missing, bad]).graph, 'selected', retain);
    expect(result.attention).toEqual([missing]);
    expect(codes(result)).toEqual(expect.arrayContaining(['not-collected', 'invalid-data']));
    expect(result.rootCause).toBeUndefined();
  });

  it('preserves an independently supported root when only a forward child has rejected marks', async () => {
    const f = fixture([mark('root')], [mark('child'), bad]);
    const result = await explain(f.graph, 'selected', { ...retain, includeBackward: true });
    expect(result.rootCause).toBe('selected');
    expect(result.backward?.confidence).toBe('complete');
    expect(result.backward?.gaps).toEqual([]);
    expect(result.impact.confidence).toBe('incomplete');
    expect(result.impact.gaps).toContainEqual({ code: 'invalid-data', nodeId: 'child', evidence: [] });
    expect(f.calls).toEqual(['selected', 'child']);
  });

  it('captures one strategy per query and never leaks its cached projection into another query', async () => {
    const options = { attentionAdmission: 'retain-valid' as 'atomic' | 'retain-valid', timeoutMs: 2000 };
    const f = fixture([mark('first'), bad]);
    const read = f.graph.attention;
    f.graph.attention = (id, context) => {
      options.attentionAdmission = 'atomic';
      return read(id, context);
    };
    const first = await explain(f.graph, 'selected', options);
    expect(first.attention).toEqual([mark('first')]);
    expect(f.calls).toEqual(['selected']);
    const second = await explain(f.graph, 'selected', options);
    expect(second.attention).toEqual([]);
    expect(f.calls).toEqual(['selected', 'selected']);
  });

  it.each(['unknown', null, true, 1])('refuses an invalid runtime strategy before graph dispatch: %j', async (mode) => {
    const f = fixture([mark('first')]);
    await expect(
      explain(f.graph, 'selected', { attentionAdmission: mode } as unknown as ExplainOptions),
    ).rejects.toThrow('CAUSE_CONFIGURATION_INVALID');
    await expect(attentionList(f.graph, { attentionAdmission: mode } as unknown as ExplainOptions)).rejects.toThrow(
      'CAUSE_CONFIGURATION_INVALID',
    );
    expect(f.calls).toEqual([]);
  });

  it('does not inspect a thrown foreign value while retaining other slots', async () => {
    const inspections: string[] = [];
    const foreign = new Proxy(
      {},
      {
        get: () => (inspections.push('get'), undefined),
        getPrototypeOf: () => (inspections.push('prototype'), null),
        getOwnPropertyDescriptor: () => (inspections.push('descriptor'), undefined),
      },
    );
    const broken = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw foreign;
        },
      },
    );
    const result = await explain(fixture([mark('first'), broken, mark('last')]).graph, 'selected', retain);
    expect(result.attention).toEqual([mark('first'), mark('last')]);
    expect(codes(result)).toContain('invalid-data');
    expect(inspections).toEqual([]);
  });

  it('refuses an option accessor without invoking it', async () => {
    let gets = 0;
    const options = Object.defineProperty({}, 'attentionAdmission', { get: () => (++gets, 'retain-valid') });
    const f = fixture([mark('first')]);
    await expect(explain(f.graph, 'selected', options)).rejects.toThrow('CAUSE_CONFIGURATION_INVALID');
    expect(gets).toBe(0);
    expect(f.calls).toEqual([]);
  });

  it('does not admit a partial result after cancellation during reflection', async () => {
    const controller = new AbortController();
    const interrupted = new Proxy({}, { getPrototypeOf: () => (controller.abort(), Object.prototype) });
    const result = await explain(fixture([mark('first'), interrupted, bad]).graph, 'selected', {
      ...retain,
      signal: controller.signal,
    });
    expect(result.attention).toEqual([]);
    expect(codes(result)).toContain('cancelled');
    expect(codes(result)).not.toContain('invalid-data');
    expect(result.rootCause).toBeUndefined();
  });

  it('excludes late salvage when the synchronous projector consumes the deadline', async () => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const late = new Proxy({}, { getPrototypeOf: () => ((now = 10), Object.prototype) });
      const result = await explain(fixture([mark('first'), late, bad]).graph, 'selected', {
        ...retain,
        timeoutMs: 5,
      });
      expect(result.attention).toEqual([]);
      expect(codes(result)).toContain('timeout');
      expect(codes(result)).not.toContain('invalid-data');
    } finally {
      clock.mockRestore();
    }
  });
});
