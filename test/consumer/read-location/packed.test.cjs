const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

// Build first through the normal gate. This test never builds, installs or relabels a package.
test('the actual offline pack supports located reads in both public module formats', { timeout: 150000 }, () => {
  const root = path.resolve(__dirname, '../../..');
  const source = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(source.name, 'foottrace');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'foottrace-read-location-'));
  const childEnv = {
    PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  const run = (command, args, cwd, timeout) => execFileSync(command, args, {
    cwd, env: childEnv, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, stdio: 'pipe',
  });
  try {
    const userConfig = path.join(temporary, 'user.npmrc');
    const globalConfig = path.join(temporary, 'global.npmrc');
    fs.writeFileSync(userConfig, '');
    fs.writeFileSync(globalConfig, '');
    const packArgs = ['pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', temporary,
      '--userconfig', userConfig, '--globalconfig', globalConfig, '--cache', path.join(temporary, 'npm-cache')];
    // npm lifecycle supplies its CLI; a direct node --test invocation uses the same Node's command lookup.
    const npmCli = process.env.npm_execpath;
    const packed = JSON.parse(npmCli
      ? run(process.execPath, [npmCli, ...packArgs], root, 30000)
      : run(process.platform === 'win32' ? 'npm.cmd' : 'npm', packArgs, root, 30000));
    assert.equal(packed.length, 1);
    const metadata = packed[0];
    assert.equal(metadata.name, source.name);
    assert.equal(metadata.version, source.version);
    assert.equal(path.basename(metadata.filename), metadata.filename);
    const archive = path.join(temporary, metadata.filename);
    assert.equal(fs.lstatSync(archive).isFile(), true);
    const bytes = fs.readFileSync(archive);
    const sha1 = createHash('sha1').update(bytes).digest('hex');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
    assert.equal(sha1, metadata.shasum);
    assert.equal(integrity, metadata.integrity);
    const entries = run('tar', ['-tzf', archive], root, 10000).trim().split('\n');
    assert.ok(entries.length > 0);
    assert.ok(entries.every(name => name.startsWith('package/') && !name.includes('\\') &&
      !name.split('/').includes('..') && !name.startsWith('/')));
    run('tar', ['-xzf', archive, '-C', temporary], root, 10000);
    const consumer = path.join(temporary, 'consumer');
    const installed = path.join(consumer, 'node_modules', 'foottrace');
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.renameSync(path.join(temporary, 'package'), installed);
    assert.equal(fs.lstatSync(installed).isSymbolicLink(), false);
    const unpacked = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
    assert.equal(unpacked.name, source.name);
    assert.equal(unpacked.version, source.version);
    assert.deepEqual(unpacked.exports, source.exports);
    fs.writeFileSync(path.join(consumer, 'package.json'), '{"private":true,"type":"module"}');

    // Exercise the legacy and opt-in root declarations in the same unpacked package.
    const causalEdgeDeclarations = `
      import { causalChain, causalChainWithUnchangedWrites, formatCausalChain, type CausalChainOptions,
        type CausalEdge, type CommitBundle, type UnchangedWriteRecording, type UntrackedSource } from 'foottrace';

      const formatters: Record<CausalEdge['kind'], string> = { data: 'value', control: 'decider' };
      const formatEdge = ({ kind }: CausalEdge): string => formatters[kind];
      function checkCausalEdgeTypes(log: CommitBundle[], recording: UnchangedWriteRecording) {
        const lookup = (): string[] => [];
        const options: CausalChainOptions = { maxDepth: 3 };
        causalChain(log, 'decide#2', lookup)?.parentEdges.map(formatEdge);
        causalChain(log, 'decide#2', lookup, options)?.parentEdges.map(formatEdge);
        // @ts-expect-error Legacy options do not enable the wider graph.
        causalChain(log, 'decide#2', lookup, { unchangedWrites: recording });

        const optedIn = causalChainWithUnchangedWrites(log, 'decide#2', lookup, recording, { maxDepth: 3 });
        type OptInEdge = NonNullable<typeof optedIn>['parentEdges'][number];
        const allFormatters: Record<OptInEdge['kind'], string> = {
          ...formatters,
          'unchanged-write': 'tracked write',
        };
        optedIn?.parents[0]?.parentEdges.map(({ kind }) => allFormatters[kind]);
        if (optedIn) void formatCausalChain(optedIn);
        // @ts-expect-error An exhaustive legacy formatter cannot handle an opt-in edge.
        optedIn?.parentEdges.map(formatEdge);
      }
      void checkCausalEdgeTypes;

      const legacySources: Record<UntrackedSource, string> = {
        args: 'run input', env: 'environment', silent: 'silent read',
      };
      function formatSource(source: UntrackedSource): string {
        return legacySources[source];
      }
      function checkOutsideInputTypes(bundle: CommitBundle) {
        bundle.untrackedSources?.map(formatSource);
        bundle.outsideInputs = { declared: ['clock'], call: { targets: ['quote-service'], incomplete: true } };
        // @ts-expect-error Declared names do not widen the legacy source union.
        formatSource('clock');
      }
      void checkOutsideInputTypes;
    `;
    for (const name of ['consumer.cts', 'consumer.mts', 'tsconfig.json']) {
      const target = path.join(consumer, name);
      fs.copyFileSync(path.join(__dirname, name), target);
      if (name !== 'tsconfig.json') fs.appendFileSync(target, causalEdgeDeclarations);
    }
    const typescript = require.resolve('typescript', { paths: [root] });
    const compiler = require.resolve('typescript/bin/tsc', { paths: [root] });
    const ts = require(typescript);
    const configFile = path.join(consumer, 'tsconfig.json');
    const parsed = ts.getParsedCommandLineOfConfigFile(configFile, {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')); },
    });
    assert.ok(parsed);
    assert.equal(parsed.errors.length, 0);
    assert.equal(parsed.options.strict, true);
    assert.equal(parsed.options.skipLibCheck, false);
    assert.equal(parsed.options.exactOptionalPropertyTypes, true);
    assert.deepEqual(parsed.options.types, []);
    assert.equal(parsed.options.paths, undefined);
    assert.equal(parsed.options.baseUrl, undefined);
    const declarationTargets = {};
    for (const [extension, condition, mode] of [['cts', 'require', ts.ModuleKind.CommonJS], ['mts', 'import', ts.ModuleKind.ESNext]]) {
      const filename = path.join(consumer, 'consumer.' + extension);
      const resolved = ts.resolveModuleName('foottrace/write', filename, parsed.options, ts.sys, undefined, undefined, mode).resolvedModule;
      assert.ok(resolved);
      const expected = path.join(installed, unpacked.exports['./write'][condition].types);
      assert.equal(fs.realpathSync(resolved.resolvedFileName), fs.realpathSync(expected));
      declarationTargets[extension] = path.relative(installed, expected);
    }
    run(process.execPath, [compiler, '-p', configFile, '--noUncheckedIndexedAccess'], consumer, 30000);

    const assertions = String.raw`
      const { RecordFrame, SharedMemory, createReadSourceRecord } = write;
      const privateNames = ['beginLocatedRead', 'resetLocationCandidate', 'noteLocationSegment',
        'completeLocationCandidate', 'takeLocation', 'endLocatedRead', 'readSource', 'trackedRead', 'absolutePath'];
      for (const name of privateNames) {
        assert.equal(Object.hasOwn(write, name), false, name);
        assert.equal(Object.hasOwn(rootDoor, name), false, name);
      }
      assert.equal(Object.hasOwn(write, 'LocatedRead'), false);
      assert.equal(Object.hasOwn(rootDoor, 'LocatedRead'), false);
      const parent = 'cfg.part/inner\u001f';
      const key = 'a.b/\u001f';
      const namespace = ['runs', 'item'];
      const state = new SharedMemory(undefined, {
        [parent]: { [key]: { n: 42 } }, cfg: { fee: 5 }, runs: { item: { cfg: { amount: 30 } } },
      });
      const frame = new RecordFrame(state, undefined, namespace);
      const keys = Reflect.ownKeys(frame);
      const borrowed = state.getState()[parent][key];
      const input = [parent];
      const result = frame.readWithLocation(input, key);
      assert.equal(result.value, borrowed);
      assert.deepEqual(result.location, [parent, key]);
      assert.equal(Object.isFrozen(result), true);
      assert.equal(Object.isFrozen(result.location), true);
      assert.equal(Object.isFrozen(borrowed), false);
      assert.equal(Object.isFrozen(state.getState()), false);
      assert.equal(Object.isFrozen(input), false);
      input[0] = 'changed';
      assert.deepEqual(result.location, [parent, key]);
      assert.deepEqual(frame.readWithLocation(['cfg'], 'amount').location, ['runs', 'item', 'cfg', 'amount']);
      const fallback = frame.readWithLocation(['cfg'], 'fee');
      assert.equal(fallback.value, 5);
      assert.deepEqual(fallback.location, ['cfg', 'fee']);
      assert.equal(frame.readTracked([parent], key), borrowed);
      const oldSource = frame.readWithSource([parent], key, { runtimeStageId: 'reader#0' });
      assert.equal(oldSource.value, borrowed);
      assert.equal(Object.hasOwn(oldSource, 'location'), false);
      let privacy = 0;
      const visible = frame.readWithLocation(['cfg'], 'fee', { runtimeStageId: 'reader#0' }, (...args) => {
        assert.deepEqual(args, []); privacy++; return 'visible';
      });
      assert.equal(visible.value, 5);
      assert.deepEqual(visible.location, ['cfg', 'fee']);
      assert.equal(privacy, 1);
      const redacted = frame.readWithLocation(['cfg'], 'fee', { runtimeStageId: 'reader#0' }, () => {
        privacy++; return 'redacted';
      });
      assert.equal(redacted.value, 5);
      assert.equal(Object.hasOwn(redacted, 'location'), false);
      assert.equal(privacy, 2);
      assert.deepEqual(Reflect.ownKeys(frame), keys);
      const capturedState = new SharedMemory(undefined, { count: 1 });
      const record = createReadSourceRecord(capturedState, { logRunId: 'packed-located-read', drillPath: [] });
      try {
        const capturedFrame = new RecordFrame(capturedState, record.log);
        const capturedKeys = Reflect.ownKeys(capturedFrame);
        const native = capturedFrame.readWithLocation([], 'count', { runtimeStageId: 'reader#0' });
        assert.equal(native.value, 1);
        assert.deepEqual(native.location, ['count']);
        assert.deepEqual(native.occurrence.source, { kind: 'base', base: 1 });
        let calls = 0;
        const hidden = capturedFrame.readWithLocation([], 'count', { runtimeStageId: 'reader#0' }, () => {
          calls++; return 'redacted';
        });
        assert.equal(hidden.value, 1);
        assert.equal(calls, 1);
        assert.equal(Object.hasOwn(hidden, 'location'), false);
        assert.deepEqual(hidden.occurrence.source, { kind: 'unavailable', reason: 'redacted' });
        assert.deepEqual(Reflect.ownKeys(capturedFrame), capturedKeys);
      } finally { record.retire(); }

      const causalBundle = (idx, stageId, overwrite, paths) => ({
        idx, stage: stageId, stageId, runtimeStageId: stageId + '#' + idx,
        trace: paths.map(path => ({ path, verb: 'set' })), overwrite, updates: {}, redactedPaths: [],
      });
      const causalLog = [
        causalBundle(0, 'seed', { complete: true, manifest: ['fixture'] }, ['complete', 'manifest']),
        causalBundle(1, 'audit', {}, []),
        causalBundle(2, 'decide', { decision: 'ok' }, ['decision']),
      ];
      const causalRecording = {
        runId: 'fixture', logAddress: { logRunId: 'fixture', drillPath: [] }, commitLog: causalLog,
        executionTree: [
          { id: 'seed', runtimeStageId: 'seed#0', stageWrites: { complete: true, manifest: ['fixture'] } },
          { id: 'audit', runtimeStageId: 'audit#1', stageWrites: { complete: true }, stageReads: { manifest: ['fixture'] } },
          { id: 'decide', runtimeStageId: 'decide#2', stageWrites: { decision: 'ok' }, stageReads: { complete: true } },
        ],
      };
      const causalLookup = id => id === 'decide#2' ? ['complete'] : id === 'audit#1' ? ['manifest'] : [];
      const valueParent = {
        runtimeStageId: 'seed#0', stageId: 'seed', stageName: 'seed', keysWritten: ['complete', 'manifest'],
        linkedBy: 'complete', depth: 1, parents: [], parentEdges: [],
      };
      const legacyBytes = JSON.stringify({
        runtimeStageId: 'decide#2', stageId: 'decide', stageName: 'decide', keysWritten: ['decision'],
        linkedBy: '', depth: 0, parents: [valueParent],
        parentEdges: [{ parent: valueParent, kind: 'data', key: 'complete', weight: 1 }],
      });
      assert.equal(JSON.stringify(rootDoor.causalChain(causalLog, 'decide#2', causalLookup)), legacyBytes);
      const withWrites = rootDoor.causalChainWithUnchangedWrites(causalLog, 'decide#2', causalLookup, causalRecording);
      const edgeFacts = ({ kind, key, parent }) => [kind, key, parent.runtimeStageId];
      assert.deepEqual(withWrites.parentEdges.map(edgeFacts), [
        ['data', 'complete', 'seed#0'],
        ['unchanged-write', 'complete', 'audit#1'],
      ]);
      assert.deepEqual(withWrites.parentEdges[1].parent.parentEdges.map(edgeFacts), [['data', 'manifest', 'seed#0']]);
      assert.equal(JSON.stringify(rootDoor.causalChain(causalLog, 'decide#2', causalLookup, {
        unchangedWrites: causalRecording,
      })), legacyBytes);
    `;
    const expectedPackage = JSON.stringify({ name: source.name, version: source.version });
    const cjs = path.join(consumer, 'consumer.cjs');
    const esm = path.join(consumer, 'consumer.mjs');
    fs.writeFileSync(cjs, `const assert=require('node:assert/strict');
      const fs=require('node:fs'),path=require('node:path');
      const write=require('foottrace/write'),rootDoor=require('foottrace');
      const pkg=require('foottrace/package.json');
      const expected=${expectedPackage};
      assert.equal(pkg.name,expected.name);assert.equal(pkg.version,expected.version);
      assert.equal(fs.realpathSync(require.resolve('foottrace/write')),
        fs.realpathSync(path.join(__dirname,'node_modules/foottrace',pkg.exports['./write'].require.default)));
      ${assertions}
      console.log(JSON.stringify({format:'CJS',name:pkg.name,version:pkg.version}));`);
    fs.writeFileSync(esm, `import assert from 'node:assert/strict';
      import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
      import * as write from 'foottrace/write';import * as rootDoor from 'foottrace';
      const expected=${expectedPackage};
      const installed=new URL('./node_modules/foottrace/',import.meta.url);
      const pkg=JSON.parse(fs.readFileSync(new URL('package.json',installed),'utf8'));
      assert.equal(pkg.name,expected.name);assert.equal(pkg.version,expected.version);
      assert.equal(fs.realpathSync(fileURLToPath(import.meta.resolve('foottrace/write'))),
        fs.realpathSync(fileURLToPath(new URL(pkg.exports['./write'].import.default,installed))));
      ${assertions}
      console.log(JSON.stringify({format:'ESM',name:pkg.name,version:pkg.version}));`);
    const cjsResult = JSON.parse(run(process.execPath, [cjs], consumer, 20000));
    const esmResult = JSON.parse(run(process.execPath, [esm], consumer, 20000));
    assert.deepEqual([cjsResult.format, esmResult.format], ['CJS', 'ESM']);
    console.log(JSON.stringify({ proof: 'packed-read-location-cjs-esm', name: metadata.name, version: metadata.version,
      shasum: sha1, sha256, integrity, declarationTargets, formats: ['CJS', 'ESM'], installs: 0,
      resolution: 'actual unpacked consumer/node_modules/foottrace; no aliases',
      scope: 'actual original archive byte/export proof; no required-floor, engine-pair or publication acceptance' }));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
