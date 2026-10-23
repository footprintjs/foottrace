/** One public writer port, available in both package formats and browsers. No live services. */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
const root = resolve(__dirname, '../..');
const env = { PATH: dirname(process.execPath) };
const proof = `const state = new SharedMemory(undefined, { count: 1 });
  const record = createReadSourceRecord(state, { logRunId: 'consumer', drillPath: [] });
  const result = new RecordFrame(state, record.log).readWithSource([], 'count', { runtimeStageId: 'reader#0' });
  const saved = decodeReadSourceSnapshot(JSON.parse(JSON.stringify(record.snapshot())));
  const proof = { value: result.value, source: saved.occurrences[0].source.kind, status: saved.status };
  record.retire();`;
const names = 'SharedMemory, RecordFrame, createReadSourceRecord, decodeReadSourceSnapshot';
it('compiles strict real CJS and ESM consumers outside coverage instrumentation', () => {
  execFileSync(
    process.execPath,
    ['node_modules/typescript/bin/tsc', '-p', 'test/consumer/read-sources/tsconfig.json'],
    { cwd: root, env, timeout: 5000, stdio: 'pipe' },
  );
});
it.each(['CJS', 'ESM'])('runs the built %s writer port', (format) => {
  const imports =
    format === 'ESM'
      ? `import { ${names} } from 'foottrace/write';`
      : `const { ${names} } = require('foottrace/write');`;
  const result = execFileSync(
    process.execPath,
    [
      ...(format === 'ESM' ? ['--input-type=module'] : []),
      '-e',
      imports + proof + 'console.log(JSON.stringify(proof));',
    ],
    { cwd: root, env, timeout: 5000, encoding: 'utf8' },
  );
  expect(JSON.parse(result)).toEqual({ value: 1, source: 'base', status: 'captured' });
});
it.each(['CJS', 'ESM'])('runs the %s port in a browser without dynamic code generation', async (format) => {
  const imports =
    format === 'ESM'
      ? `import { ${names} } from 'foottrace/write';`
      : `const { ${names} } = require('foottrace/write');`;
  const bundled = await build({
    stdin: { contents: imports + proof + 'globalThis.proof = proof;', resolveDir: root },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  const sandbox: Record<string, unknown> = { structuredClone };
  runInNewContext(bundled.outputFiles[0].text, sandbox, {
    timeout: 1000,
    contextCodeGeneration: { strings: false, wasm: false },
  });
  expect(sandbox.proof).toEqual({ value: 1, source: 'base', status: 'captured' });
  expect(sandbox.process).toBeUndefined();
});
