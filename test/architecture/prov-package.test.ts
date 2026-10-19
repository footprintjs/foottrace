/** The optional PROV door preserves the dual-format, strict-type and browser package boundaries. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
// Do not inherit startup hooks, credentials or node configuration into public consumers.
const childEnv: NodeJS.ProcessEnv = {
  PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
};
const witness = `
  const source = { initialState: {}, commitLog: [{
    runtimeStageId: 'write#0', trace: [{ path: 'answer', verb: 'set', readKeys: [] }],
    overwrite: { answer: 'PRIVATE_VALUE_MUST_NOT_EXPORT' },
  }] };
  const result = await exportProv(source, { base: 'urn:example:package/', values: 'none' });
  const prov = 'http://www.w3.org/ns/prov#';
  const context = result.document['@context'];
  const graph = result.document['@graph'];
  const proof = {
    asyncResult: true,
    context: context.prov === prov,
    graph: Array.isArray(graph) && graph.length > 0,
    incomplete: result.complete === false && result.gaps.some((gap) => gap.code === 'not-collected'),
    privateValuesAbsent: !JSON.stringify(result).includes('PRIVATE_VALUE_MUST_NOT_EXPORT'),
  };
`;
const expected = { asyncResult: true, context: true, graph: true, incomplete: true, privateValuesAbsent: true };

describe('the optional PROV package door', () => {
  it('adds a typed ESM and CommonJS door without a runtime dependency or root re-export', () => {
    expect(pkg.exports['./prov']).toEqual({
      import: { types: './dist/esm/prov.d.ts', default: './dist/esm/prov.js' },
      require: { types: './dist/types/prov.d.ts', default: './dist/prov.js' },
    });
    expect(pkg.typesVersions['*'].prov).toEqual(['dist/types/prov.d.ts']);
    expect(pkg.sideEffects).toBe(false);
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.devDependencies.jsonld).toBe('9.0.0');
    expect(pkg.scripts['check:package']).toContain('tsc -p test/consumer/prov/tsconfig.json');
  });

  it.each(['CJS', 'ESM'] as const)('executes the built %s public door', (format) => {
    const imports =
      format === 'ESM'
        ? 'import { exportProv } from "foottrace/prov";'
        : 'const { exportProv } = require("foottrace/prov");';
    const output = execFileSync(
      process.execPath,
      [
        ...(format === 'ESM' ? ['--input-type=module'] : []),
        '-e',
        imports + '(async () => {' + witness + 'console.log(JSON.stringify(proof)); })();',
      ],
      { cwd: root, env: childEnv, encoding: 'utf8', timeout: 5000, maxBuffer: 16384 },
    );
    expect(JSON.parse(output)).toEqual(expected);
  });

  it('requires strict actual public consumers without source aliases or skipped library checks', () => {
    const directory = resolve(root, 'test/consumer/prov');
    const input = ts.readConfigFile(resolve(directory, 'tsconfig.json'), ts.sys.readFile);
    expect(input.error).toBeUndefined();
    const config = ts.parseJsonConfigFileContent(input.config, ts.sys, directory);
    expect(config.errors).toEqual([]);
    expect(config.fileNames.sort()).toEqual(['consumer.cts', 'consumer.mts'].map((name) => resolve(directory, name)));
    expect(config.options).toMatchObject({
      strict: true,
      skipLibCheck: false,
      noEmit: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });
    expect(config.options.paths).toBeUndefined();
    expect(config.options.types).toEqual([]);
  });

  it.each(['cts', 'mts'] as const)('resolves the real public .%s declaration', (extension) => {
    const mode = extension === 'cts' ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext;
    const resolved = ts.resolveModuleName(
      'foottrace/prov',
      resolve(root, 'test/consumer/prov/consumer.' + extension),
      { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext },
      ts.sys,
      undefined,
      undefined,
      mode,
    );
    expect(resolved.resolvedModule?.resolvedFileName).toBe(
      resolve(root, extension === 'cts' ? 'dist/types/prov.d.ts' : 'dist/esm/prov.d.ts'),
    );
  });

  it.each(['CJS', 'ESM'] as const)(
    'executes the %s door in a browser without Node globals or string evaluation',
    async (format) => {
      const imports =
        format === 'ESM'
          ? 'import { exportProv } from "foottrace/prov";'
          : 'const { exportProv } = require("foottrace/prov");';
      const bundled = await build({
        stdin: {
          contents: imports + 'globalThis.provProof = (async () => {' + witness + 'return proof; })();',
          resolveDir: root,
          loader: 'js',
        },
        bundle: true,
        platform: 'browser',
        format: 'iife',
        target: 'es2022',
        write: false,
        metafile: true,
        logLevel: 'silent',
      });
      const sandbox: Record<string, unknown> = { TextEncoder, TextDecoder };
      runInNewContext(bundled.outputFiles[0].text, sandbox, {
        timeout: 1000,
        contextCodeGeneration: { strings: false, wasm: false },
      });
      expect(await sandbox.provProof).toEqual(expected);
      for (const name of ['require', 'process', 'module', 'fetch']) expect(sandbox[name]).toBeUndefined();
      expect(Object.keys(bundled.metafile!.inputs).some((name) => /node_modules[/\\]jsonld[/\\]/.test(name))).toBe(
        false,
      );
    },
  );

  it('tree-shakes an unused export and keeps the optional exporter out of root-only consumers', async () => {
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
    const unused = await bundle('import { exportProv } from "foottrace/prov"; console.log("consumer");');
    expect(unused.outputFiles[0].text).toBe(baseline.outputFiles[0].text);
    const rootOnly = await bundle(
      'import { buildAttemptId } from "foottrace"; console.log(buildAttemptId("step#0", 1));',
    );
    expect(Object.keys(rootOnly.metafile!.inputs).filter((name) => /lib[/\\]prov[/\\]/.test(name))).toEqual([]);
    const used = await bundle('import { exportProv } from "foottrace/prov"; globalThis.exportProv = exportProv;');
    expect(Object.keys(used.metafile!.inputs).some((name) => /lib[/\\]prov[/\\]/.test(name))).toBe(true);
  });
});
