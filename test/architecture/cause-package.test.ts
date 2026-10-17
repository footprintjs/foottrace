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
    expect(commands).toEqual([['publint'], ['attw', '--pack', '--profile', 'strict']]);
    expect(pkg.scripts['check:package']).not.toMatch(/--(?:ignore|exclude-entrypoints|entrypoints)(?:\s|=)/);
  });

  it('exports typed ESM and CommonJS cause targets using the existing public-door pattern', () => {
    for (const name of ['index', 'write', 'paths', 'cause']) {
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

  it.each(['cts', 'mts'] as const)(
    'resolves public value and shared type imports from a strict .%s consumer',
    (extension) => {
      const filename = resolve(root, '__cause_consumer__.' + extension);
      const source = `import { explain, type CauseGraph, type CauseResult } from 'foottrace/cause';
      import type { Attention } from 'foottrace';
      const mark: Attention = { kind: 'error', reason: 'ERROR_RECORDED', evidence: ['proof:source'] };
      declare const graph: CauseGraph;
      const result: Promise<CauseResult> = explain(graph, 'source');
      void mark; void result;`;
      const options: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: [],
      };
      const host = ts.createCompilerHost(options);
      const readSource = host.getSourceFile.bind(host);
      host.getSourceFile = (name, language, onError, createNew) =>
        name === filename
          ? ts.createSourceFile(name, source, language, true)
          : readSource(name, language, onError, createNew);
      const program = ts.createProgram([filename], options, host);
      expect(
        ts
          .getPreEmitDiagnostics(program)
          .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
      ).toEqual([]);
      const declaration = resolve(root, extension === 'cts' ? 'dist/types/cause.d.ts' : 'dist/esm/cause.d.ts');
      expect(program.getSourceFile(declaration)).toBeDefined();
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
