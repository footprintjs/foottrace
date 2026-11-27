import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { recordScopesFromSnapshot } from '../../src/cause.js';
import type { LogAddress } from '../../src/index.js';

const corpus: Array<{
  name: string;
  snapshot: unknown;
  scopes: Array<{
    address: LogAddress;
    fields: Record<string, string>;
  }>;
}> = JSON.parse(readFileSync(join(__dirname, '../fixtures/native-snapshot/native-scopes.json'), 'utf8'));

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  return Object.fromEntries(
    entries
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, normalize(item)]),
  );
}

it.each(corpus)('matches each projected scope field for $name', ({ snapshot, scopes: expected }) => {
  const { scopes } = recordScopesFromSnapshot(snapshot);
  expect(scopes.map(({ address }) => address)).toEqual(expected.map(({ address }) => address));
  for (const [index, scope] of scopes.entries()) {
    const fields = Object.fromEntries(
      Object.entries(scope)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [
          key,
          createHash('sha256')
            .update(JSON.stringify(normalize(value)))
            .digest('hex'),
        ]),
    );
    expect(fields).toEqual(expected[index].fields);
  }
});

it('keeps the explicit gaps on observed read-source modes', () => {
  const projected = recordScopesFromSnapshot(corpus.find(({ name }) => name === 'on')?.snapshot);
  expect(projected.scopes[0]?.complete).toBe(true);
  expect(projected.gaps).toContainEqual({
    code: 'unavailable',
    address: projected.scopes[0]?.address,
    channel: 'readSources',
  });
});

it('charges parent operands to the payload allowance when validating a child handoff', () => {
  const snapshot = structuredClone(corpus.find(({ name }) => name === 'on')!.snapshot) as {
    commitLog: Array<{ updates: Record<string, unknown> }>;
  };
  snapshot.commitLog[0].updates.samples = Array(52_000).fill(42);
  const { gaps, scopes } = recordScopesFromSnapshot(snapshot, { maxFields: 250_000 });
  expect(gaps.some(({ code }) => code === 'node-limit')).toBe(false);
  expect(scopes[1].complete).toBe(true);
  expect(scopes[0].commitLog[0]).toMatchObject({ updates: { samples: snapshot.commitLog[0].updates.samples } });
  const tighter = recordScopesFromSnapshot(snapshot, { maxFields: 150_000 });
  expect(tighter).toEqual({ scopes: [], gaps: [{ code: 'node-limit' }] });
});

it.each([
  ['an unsupported version', { version: 2 }],
  ['an unrecorded write', { writes: [{ path: 'unrecorded', reads: [] }] }],
])('keeps child coverage incomplete for %s', (_, changes) => {
  const snapshot = structuredClone(corpus.find(({ name }) => name === 'on')!.snapshot) as {
    subflowResults: Record<string, { outputHandoff: object }>;
  };
  const child = recordScopesFromSnapshot(snapshot).scopes[1];
  expect(child.complete).toBe(true);
  Object.assign(snapshot.subflowResults['payment#1'].outputHandoff, changes);

  const { scopes, gaps } = recordScopesFromSnapshot(snapshot);
  expect(scopes[0].complete).toBe(true);
  expect(scopes[1].complete).toBe(false);
  expect(gaps).toContainEqual({ code: 'invalid-data', address: child.address });
});

it.each([1, 2, 3])('preserves each of %i reads of the same writer in live and saved scopes', (count) => {
  const live = structuredClone(corpus.find(({ name }) => name === 'on')!.snapshot) as {
    readSources: { record: { occurrences: { ordinal: number; source: { kind: string; commitIdx: number } }[] } };
  };
  const record = live.readSources.record;
  const first = record.occurrences[0];
  const writer = Object.freeze(first.source);
  record.occurrences = Array.from({ length: count }, (_, i) => ({
    ...structuredClone(first),
    ordinal: i + 1,
    source: writer,
  }));
  const saved = JSON.parse(JSON.stringify(live));
  const fromSaved = recordScopesFromSnapshot(saved);
  const fromLive = recordScopesFromSnapshot(live);
  expect(fromLive).toEqual(fromSaved);
  const rows = fromLive.scopes[0].readSources!.record.occurrences;
  expect(rows.map(({ ordinal, source }) => [ordinal, source])).toEqual(
    Array.from({ length: count }, (_, i) => [i + 1, { kind: 'committed', commitIdx: 1 }]),
  );
  expect(rows[0].source).not.toBe(writer);
  if (count > 1) expect(rows[0].source).not.toBe(rows[1].source);
});
