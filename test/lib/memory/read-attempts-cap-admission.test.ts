import { expect, it } from 'vitest';
import { buildAttemptId } from '../../../src/index.js';
import { createRecordGraph, explain, type CauseGraph } from '../../../src/cause.js';
import { exportProv } from '../../../src/prov.js';
import { bundleOf } from '../../../src/lib/cause/recordValidation.js';
import { recordRun } from '../../helpers/recordRun.js';

const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => buildAttemptId('fetch#1', 1, { ordinal: i + 1, attempt: 1 }));
function fixture(attempts: readonly string[] | undefined, count: unknown, present = true) {
  const run = recordRun({}, { writeProvenance: 'reads-prefix' });
  run.step('write', (s) => s.set('result', 1));
  // Native rows are frozen. Damage an independent untrusted-input fixture.
  const snapshot = structuredClone(run.snapshot());
  const bundle = snapshot.commitLog[0];
  const row = bundle.trace[0] as unknown as Record<string, unknown>;
  if (attempts !== undefined) row.readAttempts = attempts;
  if (present) row.readAttemptsOmitted = count;
  return { bundle, row, snapshot };
}

it.each([undefined, null, '1', -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'refuses a present malformed counter %s without coercion',
  async (count) => {
    const { bundle, snapshot } = fixture(ids(1), count);
    expect(() => bundleOf(bundle, 0, { left: 10000 })).toThrow();
    const projected = await exportProv(snapshot, { base: 'urn:example:cap/' });
    expect(projected.gaps.some((g) => g.code === 'invalid-data')).toBe(true);
  },
);

it.each([undefined, [], ids(33)])('refuses positive omissions without 1..32 retained IDs', async (attempts) => {
  const { bundle, snapshot } = fixture(attempts, 1);
  expect(() => bundleOf(bundle, 0, { left: 10000 })).toThrow();
  expect((await exportProv(snapshot, { base: 'urn:example:cap/' })).gaps.some((g) => g.code === 'invalid-data')).toBe(
    true,
  );
});

it('normalizes an own encoded zero away without changing saved bytes or legacy budgets', () => {
  const { bundle } = fixture(ids(33), 0);
  const before = JSON.stringify(bundle);
  const admitted = bundleOf(bundle, 0, { left: 10000 });
  expect(admitted.trace[0].readAttempts).toHaveLength(33);
  expect(Object.hasOwn(admitted.trace[0], 'readAttemptsOmitted')).toBe(false);
  expect(JSON.stringify(bundle)).toBe(before);
  const legacy = fixture(ids(100), undefined, false);
  expect(bundleOf(legacy.bundle, 0, { left: 10000 }).trace[0].readAttempts).toHaveLength(100);
});

it('refuses inherited and accessor counters without invoking a getter', async () => {
  for (const inherited of [true, false]) {
    const f = fixture(ids(1), undefined, false);
    let calls = 0;
    if (inherited) Object.setPrototypeOf(f.row, { readAttemptsOmitted: 1 });
    else
      Object.defineProperty(f.row, 'readAttemptsOmitted', {
        get() {
          calls++;
          return 1;
        },
      });
    expect(() => bundleOf(f.bundle, 0, { left: 10000 })).toThrow();
    expect(
      (await exportProv(f.snapshot, { base: 'urn:example:cap/' })).gaps.some((g) => g.code === 'invalid-data'),
    ).toBe(true);
    expect(calls).toBe(0);
  }
});

it.each([1, Number.MAX_SAFE_INTEGER])(
  'preserves valid omissions %s and discloses truncated ancestry',
  async (count) => {
    const f = fixture(ids(32), count);
    const admitted = bundleOf(f.bundle, 0, { left: 10000 });
    expect((admitted.trace[0] as unknown as { readAttemptsOmitted: number }).readAttemptsOmitted).toBe(count);
    const address = { logRunId: 'cap', drillPath: [] };
    const graph = createRecordGraph([
      { address, ...f.snapshot, reads: {}, controlDeps: {}, attention: {}, complete: true },
    ]);
    const result = await explain(graph, graph.nodeId(address, { runtimeStageId: 'write#0', key: 'result' }));
    expect(result.confidence).toBe('incomplete');
    expect(result.gaps.map((g) => g.code)).toEqual(
      expect.arrayContaining(['truncated', 'conservative', 'not-collected']),
    );
    const projected = await exportProv(f.snapshot, { base: 'urn:example:cap/' });
    expect(projected.complete).toBe(false);
    expect(projected.gaps.map((g) => g.code)).toEqual(
      expect.arrayContaining(['truncated', 'conservative', 'not-collected']),
    );
  },
);

it('keeps an omission gap even when a host projects every retained source', async () => {
  const f = fixture(ids(32), 2);
  const address = { logRunId: 'cap', drillPath: [] };
  const native = createRecordGraph([
    { address, ...f.snapshot, reads: {}, controlDeps: {}, attention: {}, complete: true },
  ]);
  const writer = native.nodeId(address, { runtimeStageId: 'write#0', key: 'result' });
  const host: CauseGraph = {
    async parents(id: string) {
      return {
        edges:
          id === writer
            ? ids(32).map((nodeId) => ({
                nodeId,
                kind: 'data' as const,
                attribution: 'per-write' as const,
                evidence: ['synthetic-host'],
              }))
            : [],
        complete: true,
      };
    },
    async children() {
      return { edges: [], complete: true };
    },
    async attention() {
      return [];
    },
    async gaps(id, context) {
      return id === writer ? native.gaps(writer, context) : [];
    },
  };
  const result = await explain(host, writer, { includeBackward: true });
  expect(result.confidence).toBe('incomplete');
  expect(result.gaps.map((g) => g.code)).toContain('truncated');
});
