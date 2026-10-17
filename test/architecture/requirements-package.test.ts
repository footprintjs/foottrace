/** Built public CJS, ESM and browser boundaries, independent of any engine, model or application adapter. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const witness = `
  const input = [{ id: 'result:1', requirementRef: 'policy:connection', findingRef: 'finding:1',
    windowRef: 'window:1', affects: ['claim:1'], state: 'unresolved', reason: 'not-permitted',
    evidenceRefs: [], checks: [], actionRefs: [] }];
  const result = readRequirementResults(input);
  let refusal;
  try { readRequirementResults([{ ...input[0], payload: 'PRIVATE_BODY' }]); }
  catch (error) { refusal = { typed: error instanceof RequirementValidationError, code: error.code, message: error.message }; }
  const proof = { result, frozen: Object.isFrozen(result[0].affects), limit: REQUIREMENT_RESULT_LIMITS.results, refusal };
`;

describe('the public requirement reader', () => {
  it.each(['CJS', 'ESM'] as const)('admits data through the built %s root door', (format) => {
    const imports =
      format === 'ESM'
        ? 'import { readRequirementResults, RequirementValidationError, REQUIREMENT_RESULT_LIMITS } from "foottrace";'
        : 'const { readRequirementResults, RequirementValidationError, REQUIREMENT_RESULT_LIMITS } = require("foottrace");';
    const code = imports + witness + 'console.log(JSON.stringify(proof));';
    const output = JSON.parse(
      execFileSync(process.execPath, [...(format === 'ESM' ? ['--input-type=module'] : []), '-e', code], {
        cwd: root,
        encoding: 'utf8',
      }),
    );
    expect(output).toEqual({
      result: [
        {
          id: 'result:1',
          requirementRef: 'policy:connection',
          findingRef: 'finding:1',
          windowRef: 'window:1',
          affects: ['claim:1'],
          state: 'unresolved',
          reason: 'not-permitted',
          evidenceRefs: [],
          checks: [],
          actionRefs: [],
        },
      ],
      frozen: true,
      limit: 512,
      refusal: { typed: true, code: 'invalid-data', message: 'REQUIREMENT_RESULTS_INVALID' },
    });
    expect(JSON.stringify(output)).not.toContain('PRIVATE_BODY');
  });

  it('runs the public root reader in a browser bundle without loading cause algorithms or Node runtime APIs', async () => {
    const bundled = await build({
      stdin: {
        contents:
          'import { readRequirementResults, RequirementValidationError, REQUIREMENT_RESULT_LIMITS } from "foottrace";' +
          witness +
          'globalThis.requirementProof = proof;',
        resolveDir: root,
        loader: 'js',
        sourcefile: 'requirements-consumer.js',
      },
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    expect(Object.keys(bundled.metafile!.inputs).filter((name) => /lib[/\\]cause[/\\]/.test(name))).toEqual([]);
    const output = execFileSync(
      process.execPath,
      ['-e', bundled.outputFiles[0].text + '\nconsole.log(JSON.stringify(globalThis.requirementProof));'],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );
    expect(JSON.parse(output)).toMatchObject({
      frozen: true,
      limit: 512,
      result: [{ state: 'unresolved', reason: 'not-permitted' }],
    });
  });
});
