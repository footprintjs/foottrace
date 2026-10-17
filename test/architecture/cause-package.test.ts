/** The new reader door is ESM-only and remains absent from consumers that do not use it. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

describe('the optional cause package door', () => {
  it('scopes the package checker ESM-only policy to cause while discovering every other door strictly', () => {
    const commands = pkg.scripts['check:package'].split('&&').map((command: string) => command.trim().split(/\s+/));
    expect(commands).toEqual([
      ['publint'],
      ['attw', '--pack', '--exclude-entrypoints', 'cause', '--profile', 'strict'],
      ['attw', '--pack', '--entrypoints', 'cause', '--profile', 'esm-only'],
    ]);
    expect(pkg.scripts['check:package']).not.toMatch(/--ignore(?:-resolutions)?(?:\s|=)/);
  });

  it('exports a typed ESM subpath without changing the existing dual-module doors', () => {
    expect(pkg.exports['./cause']).toEqual({
      import: { types: './dist/esm/cause.d.ts', default: './dist/esm/cause.js' },
    });
    for (const name of ['index', 'write', 'paths']) {
      const door = name === 'index' ? '.' : './' + name;
      expect(pkg.exports[door]).toEqual({
        import: { types: './dist/esm/' + name + '.d.ts', default: './dist/esm/' + name + '.js' },
        require: { types: './dist/types/' + name + '.d.ts', default: './dist/' + name + '.js' },
      });
    }
    expect(pkg.sideEffects).toBe(false);
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it('loads the built ESM cause door while preserving existing CJS imports', () => {
    const script = `
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      const cause = await import('foottrace/cause');
      let causeRequireError;
      try { require('foottrace/cause'); } catch (error) { causeRequireError = error.code; }
      console.log(JSON.stringify({
        explain: typeof cause.explain,
        attentionList: typeof cause.attentionList,
        record: typeof cause.createRecordGraph,
        stored: typeof cause.createStoredRecordGraph,
        root: typeof require('foottrace').timeTravel,
        write: typeof require('foottrace/write').SharedMemory,
        paths: typeof require('foottrace/paths').nativeGet,
        causeRequireError,
      }));
    `;
    expect(
      JSON.parse(
        execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
          cwd: root,
          encoding: 'utf8',
        }),
      ),
    ).toEqual({
      explain: 'function',
      attentionList: 'function',
      record: 'function',
      stored: 'function',
      root: 'function',
      write: 'function',
      paths: 'function',
      causeRequireError: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    });
  });

  it('actually removes an unused ESM cause import from the browser bundle', async () => {
    const bundle = (contents: string) =>
      build({
        stdin: { contents, resolveDir: root, sourcefile: 'consumer.mjs', loader: 'js' },
        bundle: true,
        platform: 'browser',
        format: 'esm',
        target: 'es2022',
        treeShaking: true,
        minify: true,
        write: false,
        metafile: true,
        logLevel: 'silent',
      });
    const baseline = await bundle('console.log("consumer");');
    const unused = await bundle('import { explain } from "foottrace/cause"; console.log("consumer");');
    expect(unused.outputFiles[0].text).toBe(baseline.outputFiles[0].text);
    const retained = Object.values(unused.metafile!.outputs).flatMap((output) =>
      Object.entries(output.inputs)
        .filter(([, contribution]) => contribution.bytesInOutput > 0)
        .map(([name]) => name),
    );
    expect(retained.filter((name) => /[/\\]cause(?:[/\\]|\.js$)/.test(name))).toEqual([]);

    const used = await bundle('import { explain } from "foottrace/cause"; globalThis.explain = explain;');
    expect(used.outputFiles[0].text.length).toBeGreaterThan(baseline.outputFiles[0].text.length);
    expect(Object.keys(used.metafile!.inputs).some((name) => /lib[/\\]cause[/\\]/.test(name))).toBe(true);

    const unrelated = await bundle(
      'import { buildAttemptId } from "foottrace"; console.log(buildAttemptId("node#1", 1));',
    );
    expect(Object.keys(unrelated.metafile!.inputs).filter((name) => /lib[/\\]cause[/\\]/.test(name))).toEqual([]);
  });
});
