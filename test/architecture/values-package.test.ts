/** The optional value/canonical doors work through real declarations, Node formats and a Node-free browser VM. */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const witness = `
const table = createValueTable({redact: value => value});
const result = await table.intern('rule', 'exact text');
if (result.status !== 'stored') throw new Error(result.reason);
const envelope = JSON.parse(JSON.stringify(table.record({piece:result.reference})));
const opened = await readValueRecord(envelope);
return JSON.stringify({text: opened.values.resolve(result.reference), entries: opened.values.snapshot.entries.length,
  canonical: canonicalizeJson({'2':2,'10':10}), old: (await readValueRecord(7)).record});
`;
const expected = { text: 'exact text', entries: 1, canonical: '{"10":10,"2":2}', old: 7 };

describe('optional record-value package surfaces', () => {
  it('keeps strict dual-format consumers in the normal package gate', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    expect(pkg.scripts['check:package']).toContain('tsc -p test/consumer/values/tsconfig.json');
    const config = JSON.parse(readFileSync(resolve(root, 'test/consumer/values/tsconfig.json'), 'utf8'));
    expect(config.compilerOptions).toMatchObject({ strict: true, skipLibCheck: false, types: [] });
    expect(config.compilerOptions.paths).toBeUndefined();
    expect(config.include).toEqual(['consumer.cts', 'consumer.mts']);
  });
  it.each(['commonjs', 'module'])('runs actual Node %s public imports', (format) => {
    const imports =
      format === 'module'
        ? 'import {createValueTable,readValueRecord} from "foottrace/values"; import {canonicalizeJson} from "foottrace/canonical-json";'
        : 'const {createValueTable,readValueRecord}=require("foottrace/values"), {canonicalizeJson}=require("foottrace/canonical-json");';
    const result = execFileSync(
      process.execPath,
      ['--input-type=' + format, '-e', imports + '(async()=>{' + witness + '})().then(console.log);'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    expect(JSON.parse(result)).toEqual(expected);
  });
  it.each(['ESM', 'CJS'])('runs %s in a browser VM with real cross-realm WebCrypto buffers', async (format) => {
    const imports =
      format === 'ESM'
        ? 'import {createValueTable,readValueRecord} from "foottrace/values"; import {canonicalizeJson} from "foottrace/canonical-json";'
        : 'const {createValueTable,readValueRecord}=require("foottrace/values"), {canonicalizeJson}=require("foottrace/canonical-json");';
    const result = await build({
      stdin: { contents: imports + 'globalThis.proof=(async()=>{' + witness + '})();', resolveDir: root },
      bundle: true,
      platform: 'browser',
      format: 'iife',
      write: false,
      logLevel: 'silent',
    });
    // The crypto adapter returns an ArrayBuffer from its OWN realm. Do not inject its ArrayBuffer constructor.
    const sandbox: Record<string, unknown> = { crypto: webcrypto, TextEncoder, setTimeout, clearTimeout };
    runInNewContext(result.outputFiles[0].text, sandbox, {
      timeout: 1000,
      contextCodeGeneration: { strings: false, wasm: false },
    });
    expect(JSON.parse((await sandbox.proof) as string)).toEqual(expected);
    expect(sandbox.process).toBeUndefined();
    expect(sandbox.require).toBeUndefined();
    expect(sandbox.module).toBeUndefined();
  });
  it('tree shakes unused optional doors and keeps them out of an unrelated root import', async () => {
    const bundle = (contents: string) =>
      build({
        stdin: { contents, resolveDir: root },
        bundle: true,
        platform: 'browser',
        format: 'esm',
        minify: true,
        write: false,
        metafile: true,
        logLevel: 'silent',
      });
    const base = await bundle('console.log("consumer");');
    const unused = await bundle(
      'import {createValueTable} from "foottrace/values"; import {canonicalizeJson} from "foottrace/canonical-json"; console.log("consumer");',
    );
    expect(unused.outputFiles[0].text).toBe(base.outputFiles[0].text);
    const unrelated = await bundle(
      'import {buildAttemptId} from "foottrace"; console.log(buildAttemptId("node#1",1));',
    );
    expect(
      Object.keys(unrelated.metafile!.inputs).filter((name) => /lib[/\\](values|canonical-json)[/\\]/.test(name)),
    ).toEqual([]);
  });
});
