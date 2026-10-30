import test from 'node:test';
import assert from 'node:assert/strict';
import { read } from './helpers.mjs';
const ci = read('.github/workflows/ci.yml');
const publish = read('.github/workflows/publish.yml');
const codeql = read('.github/workflows/codeql.yml');
test('baseline: both runtime lanes and complete existing gate commands remain', () => {
  assert.match(ci, /node: \[22, 24\]/);
  for (const command of [
    'npm ci',
    'npm run check',
    'npm run test:coverage',
    'git diff --exit-code -- test/fixtures/hcifootprint/transitions-2.6.1.json',
  ])
    assert(ci.includes(command));
});
test('baseline: both CodeQL languages remain', () =>
  assert(codeql.includes('language: [javascript-typescript, actions]')));
test('Release App workflow separates authority, reuse, build and privileged jobs', () => {
  for (const id of [
    'plan',
    'prepare',
    'proposal',
    'authority',
    'verdict',
    'gates',
    'build',
    'release',
    'publish',
    'verify',
  ])
    assert.match(publish, new RegExp(`^  ${id}:$`, 'm'), `missing isolated job ${id}`);
});
test('CI records the exact tested checkout separately from dependency code', () =>
  assert.match(ci, /^  tested-tree:$/m));
test('legacy GitHub release event is not a publication shortcut', () => {
  const triggers = /^on:\n([\s\S]*?)^permissions:/m.exec(publish);
  assert(triggers, 'Expected explicit trigger block before root permissions');
  assert.doesNotMatch(triggers[1], /^  release:\s*$/m);
});
test('one exact archive is published with project lifecycle scripts disabled', () => {
  const lines = publish.split('\n').filter((line) => line.includes('npm publish'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /--ignore-scripts/);
});
test('no automatic or force merge/rewrite path is introduced', () => {
  assert.doesNotMatch(publish, /--force(?:-with-lease)?\b|--admin\b|gh pr merge\b|enablePullRequestAutoMerge/);
});
// These initial interlocks deliberately remain small. Before workflow approval,
// add actual generated-step execution with offline GitHub/npm stand-ins and
// graph/permission/artifact checks, as required by the pinned implementation plan.
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { authorityApiFixture, root, actualControlProgram } from './helpers.mjs';
const require = createRequire(import.meta.url);
const renderer = require('../../scripts/render-release-workflow.cjs');
function jobBlock(name) {
  const marker = `  ${name}:\n`,
    start = publish.indexOf(marker);
  assert(start >= 0);
  const rest = publish.slice(start + marker.length);
  const next = /^  [a-z][a-z-]*:\n/m.exec(rest);
  return rest.slice(0, next ? next.index : undefined);
}
test('the checked workflow is exactly generated from the tested trusted helper sources', () =>
  assert.equal(publish, renderer.render(root)));
test('privileged and API-only jobs neither install nor check out repository code', () => {
  for (const name of ['plan', 'prepare', 'proposal', 'authority', 'verdict', 'release', 'publish', 'verify']) {
    const block = jobBlock(name);
    assert.doesNotMatch(block, /uses: actions\/checkout@|run: npm ci|run: npm run|npm install/);
  }
  assert.match(jobBlock('proposal'), /repositories: foottrace/);
  assert.match(jobBlock('proposal'), /owner: footprintjs/);
  assert.doesNotMatch(jobBlock('release'), /id-token: write|RELEASE_APP_PRIVATE_KEY/);
  assert.doesNotMatch(jobBlock('publish'), /contents: write|RELEASE_APP_PRIVATE_KEY/);
  assert.equal(publish.match(/secrets\.RELEASE_APP_PRIVATE_KEY/g)?.length, 1);
  for (const line of publish.split('\n').filter((l) => /^\s*- uses:/.test(l)))
    assert.match(line, /@[a-f0-9]{40}(?: |$)/);
});
function condition(job) {
  const block = jobBlock(job);
  let match = /^    if: >-\n((?:      [^\n]*\n)+)/m.exec(block);
  if (match) return match[1].trim().replace(/\n\s*/g, ' ');
  match = /^    if: (.*)$/m.exec(block);
  assert(match);
  return match[1];
}
function gate(job, needs, cancelled = false) {
  return Function(
    'needs',
    'always',
    'cancelled',
    `return (${condition(job)})`,
  )(
    needs,
    () => true,
    () => cancelled,
  );
}
test('actual job conditions cannot promote failed, skipped or cancelled gates', () => {
  const good = {
    plan: { result: 'success', outputs: { mode: 'publish' } },
    authority: { result: 'success' },
    verdict: { result: 'success', outputs: { tested: 'false' } },
    gates: { result: 'success' },
    build: { result: 'success' },
    release: { result: 'success', outputs: { fresh: 'true' } },
    publish: { result: 'success' },
  };
  for (const job of ['build', 'release', 'publish']) {
    assert.equal(gate(job, good), true);
    assert.equal(gate(job, good, true), false);
  }
  for (const field of ['plan', 'authority', 'verdict', 'gates'])
    for (const state of ['failure', 'skipped', 'cancelled']) {
      const w = structuredClone(good);
      w[field].result = state;
      assert.equal(gate('build', w), false);
    }
  const fast = structuredClone(good);
  fast.verdict.outputs.tested = 'true';
  fast.gates.result = 'skipped';
  assert.equal(gate('build', fast), true);
  fast.gates.result = 'failure';
  assert.equal(gate('build', fast), false);
  for (const job of ['release', 'publish'])
    for (const field of ['plan', 'authority', 'build']) {
      const w = structuredClone(good);
      w[field].result = 'failure';
      assert.equal(gate(job, w), false);
    }
  const old = structuredClone(good);
  old.release.outputs.fresh = 'false';
  assert.equal(gate('publish', old), false);
});
async function executeInline(stage, fixture, extra = {}) {
  let output = '',
    failure = null;
  const w = fixture.w;
  const env = {
    REPO_ID: '123',
    REPO_NAME: 'footprintjs/foottrace',
    SOURCE_SHA: w.expected.mergeSha,
    SOURCE_REF: 'refs/heads/main',
    EVENT_NAME: 'push',
    RUN_ID: '500',
    RUN_ATTEMPT: '1',
    APP_SLUG: 'release-app',
    APP_CLIENT_ID: 'public-client-id',
    PLAN_JSON: JSON.stringify({
      repository: w.expected.repository,
      sha: w.expected.mergeSha,
      tree: w.expected.tree,
      version: '1.9.0',
      package: 'foottrace',
    }),
    IDENTITY_JSON: JSON.stringify(w.expected),
    GITHUB_OUTPUT: 'outputs',
    GH_TOKEN: 'offline-test-token',
    ...extra,
  };
  const process = { env, exitCode: 0 };
  const fetch = async (url, options) => {
    const response = await fixture.api(options.method, new URL(url).pathname + new URL(url).search);
    return new Response(JSON.stringify(response.data), { headers: { 'content-type': 'application/json' } });
  };
  const sandbox = {
    Buffer,
    TextDecoder,
    AbortSignal,
    fetch,
    process,
    console: { error: (x) => (failure = x) },
    require: (name) =>
      name === 'node:fs'
        ? {
            appendFileSync: (file, bytes) => {
              assert.equal(file, 'outputs');
              output += bytes;
            },
          }
        : name === 'node:child_process'
        ? { execFileSync: () => assert.fail('No installed code may run') }
        : require(name),
  };
  const script = actualControlProgram(stage);
  await vm.runInNewContext(script, sandbox);
  return { output, exit: process.exitCode, failure };
}
test('the actual rendered authority step runs offline and yields the exact reviewed identity', async () => {
  const f = authorityApiFixture(),
    r = await executeInline('authority', f);
  assert.equal(r.exit, 0);
  assert(r.output.includes('authorized=true\n'));
  assert(r.output.includes(`identity=${JSON.stringify(f.w.expected)}\n`));
  assert(f.calls.every((c) => c.method === 'GET'));
});
test('the actual rendered authority step emits no grant when review permission changes', async () => {
  const f = authorityApiFixture();
  f.w.reviewerPermissions[0].permission = 'read';
  const r = await executeInline('authority', f);
  assert.equal(r.exit, 1);
  assert.equal(r.output, '');
  assert.match(r.failure, /authority-/);
});
test('the actual rendered fast-path step falls back on a stale attempt', async () => {
  const f = authorityApiFixture();
  f.ci.jobs[0].run_attempt = 1;
  const r = await executeInline('verdict', f);
  assert.equal(r.exit, 0);
  assert.equal(r.output, 'tested=false\n');
});
test('generated workflow blank lines carry no trailing indentation', () => assert.doesNotMatch(publish, /^[ \t]+$/m));
function runBodies(yaml) {
  const lines = yaml.split('\n'),
    bodies = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run: (.*)$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    if (m[2] === '|' || m[2] === '>-') {
      const body = [];
      for (i++; i < lines.length && (lines[i].trim() === '' || lines[i].match(/^ */)[0].length > indent); i++)
        body.push(lines[i].slice(indent + 2));
      i--;
      bodies.push(body.join('\n'));
    } else bodies.push(m[2]);
  }
  return bodies;
}
test('every final emitted run body stays within the documented 21000-character limit', () => {
  for (const file of ['.github/workflows/publish.yml', '.github/workflows/ci.yml', '.github/workflows/codeql.yml'])
    for (const body of runBodies(read(file))) assert(body.length <= 21000, `${file} run body is ${body.length}`);
});
test('every final workflow stays below the documented 500 KB file limit', () => {
  for (const file of ['.github/workflows/publish.yml', '.github/workflows/ci.yml', '.github/workflows/codeql.yml'])
    assert(Buffer.byteLength(read(file)) <= 500000, `${file} exceeds conservative 500000-byte bound`);
});
test('actual emitted assembly refuses changed trusted-program hashes before any API or file access', async () => {
  let touched = 0,
    failure = null;
  const process = { env: {}, exitCode: 0 };
  const source = actualControlProgram('publish');
  const changed = source.replace(/!=="[a-f0-9]{64}"/, '!=="' + '0'.repeat(64) + '"');
  assert.notEqual(changed, source);
  await vm.runInNewContext(changed, {
    Buffer,
    process,
    console: { error: (x) => (failure = x) },
    require: (name) => {
      if (name === 'node:zlib' || name === 'node:crypto') return require(name);
      touched++;
      throw new Error('unexpected-access');
    },
  });
  assert.equal(process.exitCode, 1);
  assert.equal(touched, 0);
  assert.equal(failure, 'trusted-program-integrity');
});
test('generation refuses oversized trusted programs and workflow files instead of emitting them', () => {
  const fs = require('node:fs'),
    path = require('node:path'),
    os = require('node:os'),
    crypto = require('node:crypto');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'foottrace-release-bounds-'));
  try {
    fs.mkdirSync(path.join(temp, 'scripts'));
    for (const name of [
      'changes.cjs',
      'release-prepare.cjs',
      'release-control.cjs',
      'release-archive.cjs',
      'release-github.cjs',
      'release-workflow-template.yml',
    ])
      fs.copyFileSync(path.join(root, 'scripts', name), path.join(temp, 'scripts', name));
    const module = path.join(temp, 'scripts/release-github.cjs'),
      original = fs.readFileSync(module, 'utf8');
    const varied = Array.from({ length: 2000 }, (_, i) =>
      crypto.createHash('sha256').update(String(i)).digest('hex'),
    ).join('');
    fs.writeFileSync(module, original + '\n// ' + varied + '\n');
    assert.throws(() => renderer.render(temp), /21000/);
    fs.writeFileSync(module, original);
    fs.appendFileSync(path.join(temp, 'scripts/release-workflow-template.yml'), '\n# ' + 'x'.repeat(500000) + '\n');
    assert.throws(() => renderer.render(temp), /500 KB/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
