import { describe, expect, it } from 'vitest';
import { exportProv } from '../../../src/prov.js';
import { ProvBudget } from '../../../src/lib/prov/budget.js';
import { provOptions } from '../../../src/lib/prov/options.js';
import { ProvOutput } from '../../../src/lib/prov/output.js';

const base = 'urn:test:pressure/';
const step = (runtimeStageId: string, trace: unknown[] = []) => ({ runtimeStageId, trace });
const graph = (result: Awaited<ReturnType<typeof exportProv>>) => result.document['@graph'];
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

describe('bounded export evidence under gap pressure', () => {
  it.each([
    { maxOutputBytes: 65536, base },
    // Default 1 MiB output ceiling; raise work so output, rather than work, is what stops this record.
    { maxOutputBytes: 1048576, maxWork: 2000000, base: base + 'b'.repeat(1024) + '/' },
  ])('retains a graph prefix at the $maxOutputBytes byte ceiling with more than 255 gap reports', async (limits) => {
    const result = await exportProv(
      {
        commitLog: [
          ...Array(260).fill(null),
          ...Array.from({ length: 500 }, (_, i) => step('write#' + i, [{ path: 'x', verb: 'set', readKeys: [] }])),
        ],
      },
      limits,
    );
    expect(graph(result).length).toBeGreaterThan(0);
    expect(result.gaps).toContainEqual({ code: 'truncated', reason: 'export output limit reached' });
    expect(result.gaps.some((gap) => gap.reason === 'export maxWork limit reached')).toBe(false);
    expect(result.gaps.some((gap) => gap.reason === 'additional export gaps withheld')).toBe(true);
    expect(result.gaps.some((gap) => gap.reason === 'export envelope limit reached')).toBe(false);
    expect(size(result)).toBeLessThanOrEqual(limits.maxOutputBytes);
  });

  it('keeps late exceptional execution evidence after hundreds of routine patch and capture observations', async () => {
    const result = await exportProv(
      {
        commitLog: [
          ...Array.from({ length: 140 }, (_, i) => step('append#' + i, [{ path: 'x', verb: 'append' }])),
          step('legacy'),
        ],
      },
      { base },
    );
    expect(result.gaps).toContainEqual({
      code: 'unsupported',
      commitIdx: 140,
      reason: 'native execution identity is unavailable',
    });
    expect(result.gaps).toContainEqual({
      code: 'not-checked',
      reason: 'final value reconstruction is outside stage one',
      count: 140,
    });
    expect(result.gaps.some((gap) => gap.reason === 'additional export gaps withheld')).toBe(false);
  });

  it('counts known read-version limits without pretending that deduplicated source reads are occurrences', async () => {
    const result = await exportProv(
      { commitLog: [step('read#0', [{ path: 'answer', verb: 'set', readKeys: ['a', 'b', 'a', 'c'] }])] },
      { base },
    );
    expect(result.gaps.filter((gap) => gap.reason === 'intra-stage read version was not captured')).toEqual([
      { code: 'ambiguous', reason: 'intra-stage read version was not captured', count: 3 },
    ]);
  });

  it('leaves exceptional records positional and deduplicates only the identical report', () => {
    const budget = new ProvBudget(provOptions({ base }));
    const gap = { code: 'invalid-data', commitIdx: 7, reason: 'unreadable commit bundle' } as const;
    budget.addGap(gap);
    budget.addGap(gap);
    budget.addGap({ ...gap, commitIdx: 8 });
    expect(budget.gaps).toEqual([gap, { ...gap, commitIdx: 8 }]);
  });

  it('reserves space for late gaps and count digit growth before graph admission', () => {
    const limits = provOptions({ base, maxOutputBytes: 2048 });
    const budget = new ProvBudget(limits),
      output = new ProvOutput(budget);
    for (let i = 0; i < 100; i++) if (!output.add({ '@id': base + i, '@type': 'prov:Entity' })) break;
    for (let i = 0; i < 1000; i++)
      budget.addGap({ code: 'invalid-data', commitIdx: i, reason: 'unreadable commit bundle' });
    const result = output.finish();
    expect(graph(result).length).toBeGreaterThan(0);
    expect(size(result)).toBeLessThanOrEqual(2048);
    expect(result.gaps.some((gap) => gap.reason === 'additional export gaps withheld')).toBe(true);
    expect(result.gaps.some((gap) => gap.reason === 'export envelope limit reached')).toBe(false);
  });

  it.each([2048, 4096, 8192, 16384])(
    'bounds multibyte and escaped metadata at %i bytes deterministically',
    async (maximum) => {
      const record = {
        commitLog: Array.from({ length: 100 }, (_, i) =>
          step('éclair#' + i, [{ path: 'emoji-🍃-"-\\-' + i, verb: 'append' }]),
        ),
      };
      const first = await exportProv(record, { base, maxOutputBytes: maximum });
      const second = await exportProv(record, { base, maxOutputBytes: maximum });
      expect(first).toEqual(second);
      expect(size(first)).toBeLessThanOrEqual(maximum);
      expect(graph(first).length).toBeGreaterThan(0);
      expect(first.complete).toBe(false);
    },
  );
});
