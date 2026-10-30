/** All reader doors support the package's dual module formats without adding unused browser code. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import { build } from 'esbuild';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
// Child consumers receive command lookup only, without ambient startup hooks or credentials.
const childEnv: NodeJS.ProcessEnv = {
  PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
};
// One dependency proof exercises both runtime formats and the browser build, without engine/provider calls.
const witness = `
  const links = [['source', 'symptom'], ['symptom', 'later']];
  const edge = (nodeId) => ({ nodeId, kind: 'data', attribution: 'per-write', evidence: ['proof:edge'] });
  const graph = {
    parents: (id) => ({ edges: links.filter((link) => link[1] === id).map((link) => edge(link[0])), complete: true }),
    children: (id) => ({ edges: links.filter((link) => link[0] === id).map((link) => edge(link[1])), complete: true }),
    attention: (id) => id === 'source' ? [{ kind: 'error', reason: 'ERROR_RECORDED', evidence: ['proof:source'] }] : [],
    gaps: () => [],
  };
  const finding = await explain(graph, 'symptom');
  const marked = await attentionList(graph, { nodeIds: ['source', 'symptom'] });
  const limited = await explain(graph, 'symptom', { maxDepth: 0 });
  const controller = new AbortController();
  controller.abort();
  const cancelled = await explain(graph, 'symptom', { signal: controller.signal });
  const proof = { root: finding.rootCause, path: finding.path, impact: finding.impact.nodes,
    confidence: finding.confidence, gaps: finding.gaps, marked: marked.nodes.map((node) => node.nodeId),
    limited: limited.confidence === 'incomplete' && !limited.rootCause && limited.gaps.some((gap) => gap.code === 'depth-limit'),
    cancelled: cancelled.confidence === 'incomplete' && !cancelled.rootCause && cancelled.gaps.some((gap) => gap.code === 'cancelled') };
`;
const expected = {
  root: 'source',
  path: ['symptom', 'source'],
  impact: ['later'],
  confidence: 'complete',
  gaps: [],
  marked: ['source'],
  limited: true,
  cancelled: true,
};

describe('the optional cause package door', () => {
  it('checks every public door with one strict package profile and no resolution exceptions', () => {
    const commands = pkg.scripts['check:package'].split('&&').map((command: string) => command.trim().split(/\s+/));
    expect(commands).toEqual([
      ['publint'],
      ['attw', '--pack', '--profile', 'strict'],
      ['tsc', '-p', 'test/consumer/cause/tsconfig.json'],
      ['tsc', '-p', 'test/consumer/prov/tsconfig.json'],
      ['tsc', '-p', 'test/consumer/metadata/tsconfig.json'],
    ]);
    expect(pkg.scripts['check:package']).not.toMatch(/--(?:ignore|exclude-entrypoints|entrypoints)(?:\s|=)/);
  });

  it('exports typed ESM and CommonJS cause targets using the existing public-door pattern', () => {
    for (const name of ['index', 'write', 'paths', 'cause', 'prov', 'metadata']) {
      const door = name === 'index' ? '.' : './' + name;
      expect(pkg.exports[door]).toEqual({
        import: { types: './dist/esm/' + name + '.d.ts', default: './dist/esm/' + name + '.js' },
        require: { types: './dist/types/' + name + '.d.ts', default: './dist/' + name + '.js' },
      });
      if (name !== 'index') expect(pkg.typesVersions['*'][name]).toEqual(['dist/types/' + name + '.d.ts']);
    }
    expect(pkg.sideEffects).toBe(false);
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it.each(['CJS', 'ESM'] as const)('executes bounded public cause queries through the built %s door', (format) => {
    const imports =
      format === 'ESM'
        ? 'import { explain, attentionList } from "foottrace/cause";'
        : 'const { explain, attentionList } = require("foottrace/cause");';
    const code = imports + '(async () => {' + witness + 'console.log(JSON.stringify(proof)); })();';
    const output = execFileSync(process.execPath, [...(format === 'ESM' ? ['--input-type=module'] : []), '-e', code], {
      cwd: root,
      env: childEnv,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 16384,
    });
    expect(JSON.parse(output)).toEqual(expected);
  });

  it('requires strict public consumers for both formats in the package gate', () => {
    const directory = resolve(root, 'test/consumer/cause');
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

  it.each(['cts', 'mts'] as const)(
    'resolves the actual public .%s declaration without compiling standard libraries',
    (extension) => {
      const filename = resolve(root, 'test/consumer/cause/consumer.' + extension);
      const options: ts.CompilerOptions = {
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
      };
      const mode = extension === 'cts' ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext;
      const resolved = ts.resolveModuleName('foottrace/cause', filename, options, ts.sys, undefined, undefined, mode);
      const declaration = resolve(root, extension === 'cts' ? 'dist/types/cause.d.ts' : 'dist/esm/cause.d.ts');
      expect(resolved.resolvedModule?.resolvedFileName).toBe(declaration);
    },
  );

  it.each(['CJS', 'ESM'] as const)(
    'runs the %s cause import in a browser bundle without Node loader globals',
    async (format) => {
      const imports =
        format === 'ESM'
          ? 'import { explain, attentionList } from "foottrace/cause";'
          : 'const { explain, attentionList } = require("foottrace/cause");';
      const bundled = await build({
        stdin: {
          contents: imports + 'globalThis.proof = (async () => {' + witness + 'return proof; })();',
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
      const sandbox: Record<string, unknown> = { AbortController, AbortSignal, performance, setTimeout, clearTimeout };
      runInNewContext(bundled.outputFiles[0].text, sandbox, {
        timeout: 1000,
        contextCodeGeneration: { strings: false, wasm: false },
      });
      expect(await sandbox.proof).toEqual(expected);
      expect(sandbox.process).toBeUndefined();
      expect(sandbox.require).toBeUndefined();
      expect(sandbox.module).toBeUndefined();
    },
  );

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
