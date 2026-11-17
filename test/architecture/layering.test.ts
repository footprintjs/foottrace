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

  it('keeps colocated tests outside the runtime graph and type program', () => {
    expect(
      probe(
        {
          'src/a.ts': 'export const value = 1;',
          'src/a.test.ts': "import { it } from 'vitest'; it('adjacent', () => undefined);",
        },
        { 'src/a.ts': 0 },
      ).problems,
    ).toEqual([]);
  });

  it.each([
    "import { value } from './a.test.js'; export { value };",
    "export { value } from './a.test.js';",
    "export type Alias = import('./a.test.js').Value;",
    "export const load = () => import('./a.test.js');",
  ])('refuses production importing a colocated test: %s', (source) => {
    expect(
      probe(
        {
          'src/a.ts': source,
          'src/a.test.ts': 'export const value = 1; export interface Value { value: number; }',
        },
        { 'src/a.ts': 0 },
      ).problems,
    ).toContain('src/a.ts: unresolved or non-source import ./a.test.js');
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

describe('the optional cause reader uses the same closed fence', () => {
  it('accepts type-only record contracts without a runtime upward edge', () => {
    expect(
      probe(
        {
          'src/lib/cause/types.ts': 'export interface Attention { kind: string; }',
          'src/lib/memory/types.ts':
            "import type { Attention } from '../cause/types.js'; export interface Tree { attention?: readonly Attention[]; }",
        },
        { 'src/lib/cause/types.ts': 0, 'src/lib/memory/types.ts': 0 },
      ).problems,
    ).toEqual([]);
  });

  it('refuses an engine import in a cause adapter and a facade dependency in a guard', () => {
    const result = probe(
      {
        'src/lib/cause/validation.ts': "import { value } from './explain.js'; export { value };",
        'src/lib/cause/explain.ts': 'export const value = 1;',
        'src/lib/cause/recordAdapter.ts': "export const load = () => import('footprintjs');",
      },
      { 'src/lib/cause/validation.ts': 0, 'src/lib/cause/explain.ts': 3, 'src/lib/cause/recordAdapter.ts': 3 },
    );
    expect(result.problems).toContain('src/lib/cause/validation.ts L0 -> src/lib/cause/explain.ts L3');
    expect(result.problems).toContain('src/lib/cause/recordAdapter.ts: external dependency footprintjs');
  });
});

describe('the refusal identity fence', () => {
  const fixtures = {
    'src/lib/evidence/admission.ts': 'export class EvidenceRefusal extends Error {}',
    'src/lib/cause/recordValidation.ts':
      "import { EvidenceRefusal } from '../evidence/admission.js'; export class RecordRefusal extends EvidenceRefusal {}",
    'src/lib/cause/validation.ts':
      "import { EvidenceRefusal } from '../evidence/admission.js'; export class AdmissionError extends EvidenceRefusal {}",
    'src/lib/prov/budget.ts':
      "import { EvidenceRefusal } from '../evidence/admission.js'; export class ProvDataRefusal extends EvidenceRefusal {}",
  };
  const check = (source: string, extra: Record<string, string> = {}) => {
    const files = { ...fixtures, ...extra, 'src/probe.ts': source };
    return probe(files, Object.fromEntries(Object.keys(files).map((name) => [name, 0])));
  };

  it.each([
    ["import { EvidenceRefusal } from './lib/evidence/admission.js';", 'EvidenceRefusal'],
    ["import { RecordRefusal } from './lib/cause/recordValidation.js';", 'RecordRefusal'],
    ["import { AdmissionError } from './lib/cause/validation.js';", 'AdmissionError'],
    ["import { ProvDataRefusal } from './lib/prov/budget.js';", 'ProvDataRefusal'],
    ["import { RecordRefusal as Renamed } from './lib/cause/recordValidation.js';", 'Renamed'],
    ["import * as record from './lib/cause/recordValidation.js';", 'record.RecordRefusal'],
    ["import { RecordRefusal } from './lib/cause/recordValidation.js'; const Refusal = RecordRefusal;", 'Refusal'],
    ["import { RecordRefusal } from './lib/cause/recordValidation.js';", '(RecordRefusal as typeof RecordRefusal)'],
    [
      "import { RecordRefusal } from './lib/cause/recordValidation.js'; class SpecificRefusal extends RecordRefusal {}",
      'SpecificRefusal',
    ],
  ])('refuses dynamic classification through %s %s', (imports, constructor) => {
    const result = check(`${imports} export const classify = (value: unknown) => value instanceof ${constructor};`);
    expect(result.problems).toEqual([
      'src/probe.ts: dynamic EvidenceRefusal classification; use the family identity reader',
    ]);
  });

  it('refuses a re-exported family constructor', () => {
    const result = check(
      "import { Refusal } from './bridge.js'; export const classify = (value: unknown) => value instanceof Refusal;",
      {
        'src/bridge.ts': "export { RecordRefusal as Refusal } from './lib/cause/recordValidation.js';",
      },
    );
    expect(result.problems).toEqual([
      'src/probe.ts: dynamic EvidenceRefusal classification; use the family identity reader',
    ]);
  });

  it('accepts normal construction, subclasses, comments and string content', () => {
    expect(
      check(`
        import { RecordRefusal } from './lib/cause/recordValidation.js';
        export class SpecificRefusal extends RecordRefusal {}
        export const make = () => new SpecificRefusal();
        export const fail = () => { throw new RecordRefusal(); };
        // value instanceof RecordRefusal is not executable here.
        export const text = 'value instanceof RecordRefusal';
        export const template = \`value instanceof RecordRefusal\`;
      `).problems,
    ).toEqual([]);
  });

  it('accepts unrelated classes, including the same names and ordinary Error checks', () => {
    expect(
      check(`
        class EvidenceRefusal extends Error {}
        class RecordRefusal extends EvidenceRefusal {}
        class AdmissionError extends Error {}
        class ProvDataRefusal extends Error {}
        export const classify = (value: unknown) =>
          value instanceof EvidenceRefusal || value instanceof RecordRefusal ||
          value instanceof AdmissionError || value instanceof ProvDataRefusal || value instanceof Error;
      `).problems,
    ).toEqual([]);
  });
});
