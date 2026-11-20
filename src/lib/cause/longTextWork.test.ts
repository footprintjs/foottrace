import { expect, it } from 'vitest';
import { bundle, context, reader, scopeFor } from '../../../test/fixtures/source-links/recordHarness.js';
import type { CommitBundle } from '../memory/types.js';
import { rowsUnderRoot } from '../memory/commitLogUtils.js';
import { foldKey } from '../memory/verbs.js';

const size = 1024 * 1024;
function text() {
  // Build independently allocated equal ASCII strings without interning a single repeated literal.
  return new TextDecoder().decode(new Uint8Array(size).fill(120));
}

it.each([1, 50])(
  'opens a record containing %i one-MiB text values',
  async (count) => {
    const log = Array.from({ length: count }, (_, i) => bundle(i, `tool#${i}`, { toolResult: text() }));
    const node = { key: 'answer', runtimeStageId: 'door', commitIdx: count };
    log.push(bundle(count, 'door', { answer: 'summary' }, [{ path: 'answer', verb: 'set', readKeys: ['toolResult'] }]));
    const scope = { ...scopeFor({}, log, []), sourceLinks: undefined };
    for (const adapter of ['memory', 'stored'] as const) {
      const graph = reader(adapter, [scope], {});
      const start = performance.now();
      const page = await graph.parents(graph.nodeId(scope.address, node), context());
      expect(page.gaps).toBeUndefined();
      expect(page.edges).toHaveLength(1);
      console.log(
        `${adapter}, ${count} MiB: ${(performance.now() - start).toFixed(2)} ms, peak RSS ${
          process.resourceUsage().maxRSS
        } KiB`,
      );
    }
  },
  15_000,
);

it('admits one 64 MiB value when the query selects a different key', async () => {
  const size = 64 * 1024 * 1024;
  const log = [
    bundle(0, 'tool', { toolResult: 'x'.repeat(size), key: 'selected' }),
    bundle(1, 'door', { answer: 'summary' }, [{ path: 'answer', verb: 'set', readKeys: ['key'] }]),
  ];
  const scope = { ...scopeFor({}, log, []), sourceLinks: undefined };
  for (const adapter of ['memory', 'stored'] as const) {
    const graph = reader(adapter, [scope], { maxFields: 1_000 });
    const node = graph.nodeId(scope.address, { runtimeStageId: 'door', commitIdx: 1, key: 'answer' });
    expect((await graph.parents(node, context())).edges).toHaveLength(1);
  }
});

it('retains union semantics and reports work for reused and independent long strings', async () => {
  const base = text();
  for (const copies of [false, true]) {
    for (const rows of [8, 32, 64]) {
      const log: CommitBundle[] = [bundle(0, 'seed', { profile: { members: [base], chosen: 'fixed' } })];
      for (let i = 0; i < rows; i++) {
        log.push(
          bundle(i + 1, `update#${i}`, {}, [{ path: 'profile', verb: 'merge' }], {
            profile: { members: [copies ? text() : base, i] },
          }),
        );
      }
      const scope = { ...scopeFor({}, log, []), sourceLinks: undefined };
      const graph = reader('memory', [scope], { loadTimeoutMs: 30_000 });
      const node = graph.nodeId(scope.address, { runtimeStageId: 'seed', commitIdx: 0, key: 'profile\u001fchosen' });
      const start = performance.now();
      const page = await graph.children(node, context());
      expect(page.gaps).toBeUndefined();
      expect(page.edges).toEqual([]);
      console.log(
        `V8 ${process.versions.v8}, ${rows} rows, ${copies ? 'independent equal text' : 'reused text'}: ${(
          performance.now() - start
        ).toFixed(2)} ms`,
      );
    }
  }
}, 20_000);

it('still detaches a Date through the default fold', () => {
  const original = new Date('2026-11-20T00:00:00Z');
  const log = [bundle(0, 'date', { value: original })];
  const copy = foldKey(rowsUnderRoot(log, 'value', 0), ['value']);
  expect(copy).toEqual(original);
  expect(copy).not.toBe(original);
});
