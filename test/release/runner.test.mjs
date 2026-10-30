import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import child from 'node:child_process';
import { root, read, sha, authorityApiFixture } from './helpers.mjs';
const require = createRequire(import.meta.url);
const runner = () => require('../../scripts/release-runner.cjs');
const env = () => ({
  REPO_ID: '123',
  REPO_NAME: 'footprintjs/foottrace',
  SOURCE_SHA: sha('1'),
  SOURCE_REF: 'refs/heads/main',
  EVENT_NAME: 'push',
  RUN_ID: '500',
  RUN_ATTEMPT: '1',
  GITHUB_OUTPUT: '/offline/output',
  GITHUB_STEP_SUMMARY: '/offline/summary',
  RUNNER_TEMP: '/offline/temp',
  APP_SLUG: 'release-app',
  APP_CLIENT_ID: 'public-client-id',
});
function harness(extra = {}) {
  const e = { ...env(), ...extra },
    events = [];
  const io = {
    head: () => {
      events.push('head');
      return e.SOURCE_SHA;
    },
    appendOutput: (file, bytes) => events.push(['output', file, bytes]),
    appendSummary: (file, bytes) => events.push(['summary', file, bytes]),
  };
  const api = () => {
    events.push('api');
    assert.fail('Invalid input must not touch the API');
  };
  return { env: e, io, api, events };
}
for (const argv of [[], ['unknown'], ['plan', 'extra'], ['../../evil']])
  test(`readable runner rejects stage ${JSON.stringify(argv)} before IO/API`, async () => {
    const h = harness();
    await assert.rejects(runner().runCli(argv, h), { code: 'stage' });
    assert.deepEqual(h.events, []);
  });
for (const [name, extra, code] of [
  ['foreign ref', { SOURCE_REF: 'refs/heads/other' }, 'event'],
  ['PR event', { EVENT_NAME: 'pull_request_target' }, 'event'],
  ['bad SHA', { SOURCE_SHA: 'main' }, 'context'],
  ['missing output', { GITHUB_OUTPUT: '' }, 'runner-output'],
])
  test(`readable runner refuses ${name} before API`, async () => {
    const h = harness(extra);
    await assert.rejects(runner().runCli(['plan'], h), { code });
    assert.deepEqual(h.events, []);
  });
test('readable runner binds actual checkout HEAD before API', async () => {
  const h = harness();
  h.io.head = () => sha('2');
  await assert.rejects(runner().runCli(['plan'], h), { code: 'checkout-sha' });
  assert.deepEqual(h.events, []);
});
test('actual readable authority adapter emits exact identity only after checkout binding', async () => {
  const f = authorityApiFixture(),
    events = [],
    e = {
      ...env(),
      PLAN_JSON: JSON.stringify({
        repository: f.w.expected.repository,
        sha: f.w.expected.mergeSha,
        tree: f.w.expected.tree,
        version: '1.9.0',
        package: 'foottrace',
      }),
    };
  let output = '';
  await runner().runCli(['authority'], {
    env: e,
    api: async (...a) => {
      assert.equal(events[0], 'head');
      return f.api(...a);
    },
    io: {
      head: () => {
        events.push('head');
        return e.SOURCE_SHA;
      },
      appendOutput: (file, bytes) => {
        assert.equal(file, e.GITHUB_OUTPUT);
        output += bytes;
      },
    },
  });
  assert(output.includes('authorized=true\n'));
  assert(output.includes(`identity=${JSON.stringify(f.w.expected)}\n`));
});
test('readable delivery replaces compressed program transport', () => {
  const yaml = read('.github/workflows/publish.yml');
  assert.doesNotMatch(yaml, /brotliDecompressSync|new Function|FOOTTRACE_RELEASE|@@INLINE|trusted-program-integrity/);
  assert(!fs.existsSync(path.join(root, 'scripts/render-release-workflow.cjs')));
  assert(!fs.existsSync(path.join(root, 'scripts/release-workflow-template.yml')));
  assert(yaml.includes('run: node scripts/release-runner.cjs authority'));
});
test('actual CLI executable refuses an invalid stage without a provider call', () => {
  assert(fs.existsSync(path.join(root, 'scripts/release-runner.cjs')));
  const result = child.spawnSync(process.execPath, ['scripts/release-runner.cjs', 'unknown'], {
    cwd: root,
    env: { PATH: '/usr/bin:/bin', NODE_OPTIONS: '', NODE_PATH: '' },
    encoding: 'utf8',
    timeout: 3000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), 'stage');
  assert.equal(result.stdout, '');
});
test('real IO adapter uses exclusive writes and refuses destinations outside its fixed outputs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foottrace-runner-'));
  try {
    const e = { ...env(), RUNNER_TEMP: tmp },
      io = runner().createIo(e);
    const file = io.publishFile(500, 1);
    assert.equal(file, path.join(tmp, 'foottrace-publish-500-1/package.tgz'));
    io.write(file, Buffer.from('archive'));
    assert.equal(fs.readFileSync(file, 'utf8'), 'archive');
    assert.throws(() => io.write(file, Buffer.from('replace')), { code: 'EEXIST' });
    assert.throws(() => io.write('scripts/release-runner.cjs', Buffer.from('replace')), { code: 'output-path' });
    assert.throws(() => io.write('../escape', Buffer.from('replace')), { code: 'output-path' });
    assert.throws(
      () =>
        runner()
          .createIo({ ...e, RUNNER_TEMP: root })
          .publishFile(500, 1),
      { code: 'publish-directory' },
    );
    assert.throws(
      () =>
        runner()
          .createIo({ ...e, RUNNER_TEMP: 'relative' })
          .publishFile(500, 1),
      { code: 'publish-directory' },
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test('real IO adapter retains fixed checkout identity/tree and cleanliness reads', () => {
  const io = runner().createIo(env());
  assert.equal(io.head(), child.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim());
  assert.equal(
    io.gitTree(),
    child.execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim(),
  );
  assert.equal(typeof io.requireClean, 'function');
});
test('production release helper closure is static, builtin-only and closed', () => {
  const closure = new Map([
    ['release-runner', ['release-github', 'release-control']],
    ['release-github', ['release-prepare', 'release-control', 'release-archive']],
    ['release-prepare', ['release-changes']],
    ['release-changes', []],
    ['release-control', []],
    ['release-archive', []],
  ]);
  const builtins = new Set(['node:fs', 'node:path', 'node:child_process', 'node:crypto', 'node:zlib']);
  for (const [name, allowed] of closure) {
    const file = path.join(root, `scripts/${name}.cjs`),
      text = fs.readFileSync(file, 'utf8');
    assert(!fs.lstatSync(file).isSymbolicLink());
    assert.doesNotMatch(text, /\bimport\s*\(|\beval\s*\(|\bnew\s+Function\s*\(|\bvm\./);
    const imports = [...text.matchAll(/\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g)].map((m) => m[2]);
    assert.equal(imports.length, (text.match(/\brequire\s*\(/g) ?? []).length, 'Dynamic module load');
    const local = new Set();
    for (const specifier of imports) {
      if (builtins.has(specifier)) continue;
      assert(specifier.startsWith('./') && specifier.endsWith('.cjs'));
      const target = specifier.slice(2, -4);
      assert(allowed.includes(target), `${name} -> ${target}`);
      local.add(target);
    }
    assert.deepEqual([...local].sort(), [...allowed].sort());
  }
});
test('publisher uses the actual isolated CWD/argv, ignoring hostile checkout config and scripts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foottrace-submit-fixture-'));
  try {
    const checkout = path.join(tmp, 'hostile-checkout'),
      runnerTemp = path.join(tmp, 'runner-temp'),
      bins = path.join(tmp, 'bin');
    for (const d of [checkout, runnerTemp, bins]) fs.mkdirSync(d);
    fs.writeFileSync(path.join(checkout, '.npmrc'), 'registry=https://wrong.invalid/\n');
    fs.writeFileSync(
      path.join(checkout, 'package.json'),
      JSON.stringify({ name: 'not-the-package', scripts: { prepublishOnly: 'touch NEVER_RUN' } }),
    );
    const config = path.join(tmp, 'user.npmrc'),
      global = path.join(tmp, 'global.npmrc');
    fs.writeFileSync(config, 'registry=https://registry.npmjs.org/\n');
    fs.writeFileSync(global, '');
    const archive = runner()
      .createIo({ ...env(), RUNNER_TEMP: runnerTemp })
      .publishFile(500, 1);
    fs.mkdirSync(path.dirname(archive));
    fs.writeFileSync(archive, 'inert test archive, never published');
    const cleanEnv = {
      PATH: process.env.PATH,
      NPM_CONFIG_USERCONFIG: config,
      NPM_CONFIG_GLOBALCONFIG: global,
      npm_config_cache: path.join(tmp, 'cache'),
      npm_config_update_notifier: 'false',
      NODE_OPTIONS: '',
      NODE_PATH: '',
    };
    // This is an actual read-only npm config query; no install/auth/network/publish.
    for (const [cwd, expected] of [
      [checkout, 'https://wrong.invalid/'],
      [path.dirname(archive), 'https://registry.npmjs.org/'],
    ]) {
      const r = child.spawnSync('npm', ['config', 'get', 'registry'], {
        cwd,
        env: cleanEnv,
        encoding: 'utf8',
        timeout: 3000,
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), expected);
    }
    const yaml = read('.github/workflows/publish.yml');
    const block = yaml.slice(yaml.indexOf('      - name: Submit the one checked archive'), yaml.indexOf('\n  verify:'));
    const cwdLine = /working-directory: (.+)/.exec(block)?.[1];
    assert.equal(cwdLine, '${{ runner.temp }}/foottrace-publish-${{ github.run_id }}-${{ github.run_attempt }}');
    const cwd = cwdLine
      .replace('${{ runner.temp }}', runnerTemp)
      .replace('${{ github.run_id }}', '500')
      .replace('${{ github.run_attempt }}', '1');
    const command = /        run: (.+)/.exec(block)?.[1];
    assert.equal(
      command,
      'npm publish "$PACKAGE_FILE" --ignore-scripts --access public --registry=https://registry.npmjs.org',
    );
    fs.writeFileSync(
      path.join(bins, 'npm'),
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({cwd:process.cwd(),argv:process.argv.slice(2)}));\n`,
      { mode: 0o700 },
    );
    const r = child.spawnSync('/bin/sh', ['-c', command], {
      cwd,
      env: {
        PATH: bins + ':/usr/bin:/bin',
        PACKAGE_FILE: archive,
        NODE_AUTH_TOKEN: '',
        NODE_OPTIONS: '',
        NODE_PATH: '',
      },
      encoding: 'utf8',
      timeout: 3000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {
      cwd: fs.realpathSync(path.dirname(archive)),
      argv: ['publish', archive, '--ignore-scripts', '--access', 'public', '--registry=https://registry.npmjs.org'],
    });
    assert.deepEqual(fs.readdirSync(path.dirname(archive)), ['package.tgz']);
    assert(!fs.existsSync(path.join(checkout, 'NEVER_RUN')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

for (const [name, extra, code] of [
  ['different checkout tree', { gitTree: () => sha('4') }, 'build-tree'],
  [
    'dirty checkout',
    {
      requireClean: () => {
        const e = new Error('dirty-checkout');
        e.code = 'dirty-checkout';
        throw e;
      },
    },
    'dirty-checkout',
  ],
])
  test(`actual build-manifest runner refuses ${name} before archive/API work`, async () => {
    const h = harness({
      PLAN_JSON: JSON.stringify({
        repository: { id: 123, full_name: 'footprintjs/foottrace' },
        sha: sha('1'),
        tree: sha('3'),
        version: '1.9.0',
        package: 'foottrace',
      }),
    });
    Object.assign(h.io, {
      gitTree: () => sha('3'),
      requireClean: () => assert.fail('Unexpected clean check'),
      read: () => assert.fail('Unexpected archive/source read'),
      ...extra,
    });
    await assert.rejects(runner().runCli(['build-manifest'], h), { code });
    assert(!h.events.includes('api'));
    assert(!h.events.some((e) => Array.isArray(e)));
  });
test('actual IO cleanliness adapter invokes only fixed Git arguments and propagates failure', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foottrace-git-adapter-'));
  try {
    const capture = path.join(tmp, 'capture.json');
    fs.writeFileSync(
      path.join(tmp, 'git'),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(
        capture,
      )},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));process.exit(1);\n`,
      { mode: 0o700 },
    );
    const r = child.spawnSync(
      process.execPath,
      [
        '-e',
        "try { require('./scripts/release-runner.cjs').createIo({}).requireClean(); process.exitCode=2; } catch (e) { process.stdout.write(String(e.status)); }",
      ],
      {
        cwd: root,
        env: { PATH: tmp + ':/usr/bin:/bin', NODE_OPTIONS: '', NODE_PATH: '' },
        encoding: 'utf8',
        timeout: 3000,
      },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '1');
    assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')), {
      args: ['diff', '--exit-code', 'HEAD'],
      cwd: fs.realpathSync(root),
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
