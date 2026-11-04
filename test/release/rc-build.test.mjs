import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha, syntheticPackageArchive } from './helpers.mjs';
const require = createRequire(import.meta.url),
  { runCli } = require('../../scripts/release-runner.cjs');
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
function world({ rc = true, source = '1.11.0', from = '1.11.0', lock = source, packed } = {}) {
  const version = rc ? '2.0.0-rc.0' : source,
    repository = { id: 123, full_name: 'footprintjs/foottrace' },
    writes = new Map(),
    calls = [];
  const plan = {
    mode: rc ? 'rc' : 'publish',
    repository,
    sha: sha('1'),
    tree: sha('3'),
    package: 'foottrace',
    version,
    ...(rc ? { fromVersion: from } : {}),
  };
  const files = {
    'package.json': Buffer.from(JSON.stringify({ name: 'foottrace', version: source })),
    'package-lock.json': Buffer.from(JSON.stringify({ version: lock, packages: { '': { version: lock } } })),
    'pack.json': Buffer.from(JSON.stringify([{ filename: 'foottrace-' + version + '.tgz' }])),
  };
  files['foottrace-' + version + '.tgz'] = syntheticPackageArchive(packed ?? version);
  const env = {
    REPO_ID: '123',
    REPO_NAME: repository.full_name,
    SOURCE_SHA: plan.sha,
    SOURCE_REF: 'refs/heads/main',
    EVENT_NAME: rc ? 'workflow_dispatch' : 'push',
    RUN_ID: '500',
    RUN_ATTEMPT: '1',
    GITHUB_OUTPUT: '/offline/output',
    PLAN_JSON: JSON.stringify(plan),
  };
  const io = {
    head: () => plan.sha,
    gitTree: () => plan.tree,
    requireClean: () => {},
    read: (name) => {
      assert(Object.hasOwn(files, name), 'undeclared fixture file');
      return files[name];
    },
    write: (name, bytes) => writes.set(name, bytes),
    appendOutput: () => {},
  };
  const api = async (method, route) => {
    calls.push({ method, route });
    assert.equal(method, 'GET');
    if (route.endsWith('/actions/runs/500'))
      return {
        data: {
          id: 500,
          run_attempt: 1,
          head_sha: plan.sha,
          repository,
          head_repository: repository,
          path: '.github/workflows/publish.yml',
          head_branch: 'main',
          event: env.EVENT_NAME,
          status: 'in_progress',
          conclusion: null,
        },
      };
    if (route.includes('/jobs?'))
      return {
        data: { total_count: 1, jobs: [{ id: 50, name: 'build', run_id: 500, run_attempt: 1, head_sha: plan.sha }] },
      };
    assert.fail('undeclared synthetic API route');
  };
  return { env, io, api, plan, writes, calls, files, run: () => runCli(['build-manifest'], { env, io, api }) };
}
test('RC build: ordinary stable manifest remains bound to the unmodified source package', async () => {
  const w = world({ rc: false });
  await w.run();
  assert.equal(JSON.parse(w.writes.get('release-artifact/manifest.json')).version, '1.11.0');
});
test('RC build: actual manifest binds candidate archive to original stable source and current producer', async () => {
  const w = world();
  await assert.doesNotReject(w.run);
  const m = JSON.parse(w.writes.get('release-artifact/manifest.json'));
  assert.equal(m.version, '2.0.0-rc.0');
  assert.equal(m.tree, w.plan.tree);
  assert.equal(m.sourceSha, w.plan.sha);
  assert.equal(m.runId, 500);
  assert.equal(m.runAttempt, 1);
  assert.equal(m.jobId, 50);
  assert.equal(JSON.parse(w.files['package.json']).version, '1.11.0');
  assert.equal(JSON.parse(w.files['package-lock.json']).version, '1.11.0');
});
for (const [name, options, code] of [
  ['wrong source version', { from: '1.10.0' }, 'package-version'],
  ['mutated source lock', { lock: '2.0.0-rc.0' }, 'package-version'],
  ['wrong package bytes', { packed: '1.11.0' }, 'invalid-archive'],
])
  test('RC build: refuses ' + name + ' without an artifact', async () => {
    const w = world(options);
    await assert.rejects(w.run, { code });
    assert.equal(w.writes.size, 0);
    assert.equal(w.calls.length, 0);
  });
test('RC build: actual workflow stages only package data outside the checkout with scripts disabled', (t) => {
  const yaml = readFileSync(path.join(ROOT, '.github/workflows/publish.yml'), 'utf8');
  const start = yaml.indexOf('      - name: Stage the RC package outside the checkout');
  assert(start >= 0, 'missing external RC package staging step');
  const rest = yaml.slice(start),
    end = rest.indexOf('\n      - ', 1),
    step = end < 0 ? rest : rest.slice(0, end);
  assert(step.includes("if: needs.plan.outputs.mode == 'rc'"));
  const marker = '        run: |\n',
    at = step.indexOf(marker);
  assert(at >= 0);
  const script = step
    .slice(at + marker.length)
    .split('\n')
    .map((l) => (l.startsWith('          ') ? l.slice(10) : l))
    .join('\n');
  const root = mkdtempSync(path.join(os.tmpdir(), 'rc-pack-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'dist'));
  mkdirSync(path.join(root, 'temp'));
  const pkg = JSON.stringify({
    name: 'foottrace',
    version: '1.11.0',
    files: ['dist'],
    scripts: { prepack: 'exit 89', postpack: 'exit 90' },
  });
  const lock = '{"version":"1.11.0","lockfileVersion":3}\n';
  writeFileSync(path.join(root, 'package.json'), pkg);
  writeFileSync(path.join(root, 'package-lock.json'), lock);
  writeFileSync(path.join(root, 'dist/index.js'), 'module.exports = {};\n');
  writeFileSync(path.join(root, 'empty.npmrc'), '');
  writeFileSync(path.join(root, 'global.npmrc'), '');
  const r = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    env: {
      PATH: path.dirname(process.execPath) + ':/usr/bin:/bin',
      RUNNER_TEMP: path.join(root, 'temp'),
      PLAN_JSON: JSON.stringify({ version: '2.0.0-rc.0' }),
      NPM_CONFIG_USERCONFIG: path.join(root, 'empty.npmrc'),
      NPM_CONFIG_GLOBALCONFIG: path.join(root, 'global.npmrc'),
      npm_config_cache: path.join(root, 'cache'),
      npm_config_update_notifier: 'false',
      NODE_OPTIONS: '',
      NODE_PATH: '',
    },
  });
  assert.equal(r.error, undefined);
  assert.equal(r.signal, null);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(path.join(root, 'package.json'), 'utf8'), pkg);
  assert.equal(readFileSync(path.join(root, 'package-lock.json'), 'utf8'), lock);
  const packed = JSON.parse(readFileSync(path.join(root, 'pack.json'), 'utf8'));
  assert.equal(packed[0].filename, 'foottrace-2.0.0-rc.0.tgz');
  const archive = require('../../scripts/release-archive.cjs').inspectArchive(
    readFileSync(path.join(root, packed[0].filename)),
    { package: 'foottrace', version: '2.0.0-rc.0' },
  );
  assert.equal(archive.version, '2.0.0-rc.0');
});
