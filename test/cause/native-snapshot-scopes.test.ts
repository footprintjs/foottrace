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
