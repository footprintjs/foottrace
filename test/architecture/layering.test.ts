/** Negative controls prove the closed record fence refuses each kind of escape. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error The standalone build checker is JavaScript, not a public package module.
import { checkLayers } from '../../scripts/check-layering.mjs';

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function probe(files: Record<string, string>, ranks: Record<string, number>) {
  const root = mkdtempSync(join(tmpdir(), 'foottrace-fence-'));
  temporary.push(root);
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        skipLibCheck: true,
        lib: ['ES2022', 'DOM'],
      },
    }),
  );
  for (const [file, content] of Object.entries(files)) {
    const location = join(root, file);
    mkdirSync(dirname(location), { recursive: true });
    writeFileSync(location, content);
  }
  return checkLayers(root, ranks) as { ok: boolean; problems: string[]; files: number };
}

describe('the record fence', () => {
  // This integration check creates a cold TypeScript program for all source files.
  // Coverage on a shared Node 22 runner can exceed the unit-test default (5 s);
  // the fence is a correctness check, not a wall-clock performance assertion.
  it('accepts the real source graph without engine or platform dependencies', () => {
    expect(checkLayers().problems).toEqual([]);
  }, 30_000);

  it('accepts a downward dependency', () => {
    expect(
      probe(
        {
          'src/a.ts': "import { value } from './b.js'; export const result = value;",
          'src/b.ts': 'export const value = 1;',
        },
        { 'src/a.ts': 1, 'src/b.ts': 0 },
      ).problems,
    ).toEqual([]);
  });

  it('rejects unranked files and stale layer entries', () => {
    const result = probe({ 'src/a.ts': 'export const value = 1;' }, { 'src/missing.ts': 0 });
    expect(result.problems).toContain('unranked source: src/a.ts');
    expect(result.problems).toContain('stale layer entry: src/missing.ts');
  });

  it.each([
    ["import value from 'engine'; export { value };", 'external dependency engine'],
    ["import type { Value } from 'engine'; export type Alias = Value;", 'external dependency engine'],
    ["export type Alias = import('engine').Value;", 'external dependency engine'],
    ["export { value } from 'engine';", 'external dependency engine'],
    ["export const load = () => import('engine');", 'external dependency engine'],
    ["const dependency = 'engine'; export const load = () => import(dependency);", 'opaque module load'],
  ])('rejects an external or opaque edge: %s', (source, message) => {
    expect(probe({ 'src/a.ts': source }, { 'src/a.ts': 0 }).problems.join('\n')).toContain(message);
  });

  it('rejects an upward runtime edge and a runtime cycle', () => {
    const result = probe(
      { 'src/a.ts': "import './b.js'; export const a = 1;", 'src/b.ts': "import './a.js'; export const b = 1;" },
      { 'src/a.ts': 0, 'src/b.ts': 1 },
    );
    expect(result.problems).toContain('src/a.ts L0 -> src/b.ts L1');
    expect(result.problems.some((message) => message.startsWith('runtime cycle:'))).toBe(true);
  });

  it('rejects an accidental Node global even without an import', () => {
    expect(
      probe({ 'src/a.ts': 'export const secret = process.env.VALUE;' }, { 'src/a.ts': 0 }).problems.join('\n'),
    ).toContain('process');
  });
});
