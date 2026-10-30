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
import { authorityApiFixture, executeWorkflowStage } from './helpers.mjs';
function jobBlock(name) {
  const marker = `  ${name}:\n`,
    start = publish.indexOf(marker);
  assert(start >= 0);
  const rest = publish.slice(start + marker.length);
  const next = /^  [a-z][a-z-]*:\n/m.exec(rest);
  return rest.slice(0, next ? next.index : undefined);
}
test('controls check out exactly the event source, without persisted credentials or installs', () => {
  for (const name of ['plan', 'prepare', 'proposal', 'authority', 'verdict', 'release', 'publish', 'verify']) {
    const block = jobBlock(name);
    assert.equal((block.match(/uses: actions\/checkout@/g) ?? []).length, 1);
    const checkout = block.slice(
      block.indexOf('      - uses: actions/checkout@'),
      block.indexOf('      - uses: actions/setup-node@'),
    );
    assert.equal(
      checkout,
      '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          ref: ${{ github.sha }}\n          persist-credentials: false\n          submodules: false\n          lfs: false\n',
    );
    assert.match(
      block,
      /ref: \$\{\{ github\.sha \}\}\n          persist-credentials: false\n          submodules: false\n          lfs: false/,
    );
    assert.match(block, /package-manager-cache: false/);
    assert.doesNotMatch(
      block,
      /npm ci|npm install|npm run|npx |uses: \.\/|core\.hooksPath|git submodule|git lfs|ssh-key:|allow-unsafe-pr-checkout: true/,
    );
    const commands = runBodies(block);
    for (const command of commands)
      assert(
        command === `node scripts/release-runner.cjs ${name}` ||
          (name === 'publish' &&
            [
              'test "$(npm --version)" = \'11.19.0\'',
              'npm publish "$PACKAGE_FILE" --ignore-scripts --access public --registry=https://registry.npmjs.org',
            ].includes(command)),
        `Unexpected ${name} command: ${command}`,
      );
  }
  assert.match(jobBlock('proposal'), /repositories: foottrace/);
  assert.match(jobBlock('proposal'), /owner: footprintjs/);
  assert(
    jobBlock('proposal').indexOf('actions/checkout@') <
      jobBlock('proposal').indexOf('actions/create-github-app-token@'),
  );
  assert.doesNotMatch(jobBlock('release'), /id-token: write|RELEASE_APP_PRIVATE_KEY/);
  assert.doesNotMatch(jobBlock('publish'), /contents: write|RELEASE_APP_PRIVATE_KEY/);
  assert.equal(publish.match(/secrets\.RELEASE_APP_PRIVATE_KEY/g)?.length, 1);
  assert.equal(publish.match(/GH_TOKEN: \$\{\{ steps\.app\.outputs\.token \}\}/g)?.length, 1);
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
async function executeReadable(stage, fixture, extra = {}) {
  const w = fixture.w;
  return executeWorkflowStage(stage, {
    api: fixture.api,
    env: {
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
      ...extra,
    },
  });
}
test('the actual readable authority step runs offline and yields the exact reviewed identity', async () => {
  const f = authorityApiFixture(),
    r = await executeReadable('authority', f);
  assert.equal(r.exit, 0);
  assert(r.output.includes('authorized=true\n'));
  assert(r.output.includes(`identity=${JSON.stringify(f.w.expected)}\n`));
  assert(f.calls.every((c) => c.method === 'GET'));
});
test('the actual readable authority step emits no grant when review permission changes', async () => {
  const f = authorityApiFixture();
  f.w.reviewerPermissions[0].permission = 'read';
  const r = await executeReadable('authority', f);
  assert.equal(r.exit, 1);
  assert.equal(r.output, '');
  assert.match(r.failure, /authority-/);
});
test('the actual readable fast-path step falls back on a stale attempt', async () => {
  const f = authorityApiFixture();
  f.ci.jobs[0].run_attempt = 1;
  const r = await executeReadable('verdict', f);
  assert.equal(r.exit, 0);
  assert.equal(r.output, 'tested=false\n');
});
test('workflow blank lines carry no trailing indentation', () => assert.doesNotMatch(publish, /^[ \t]+$/m));
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
test('every final readable run body stays within the documented 21000-character limit', () => {
  for (const file of ['.github/workflows/publish.yml', '.github/workflows/ci.yml', '.github/workflows/codeql.yml'])
    for (const body of runBodies(read(file))) assert(body.length <= 21000, `${file} run body is ${body.length}`);
});
test('every final workflow stays below the documented 500 KB file limit', () => {
  for (const file of ['.github/workflows/publish.yml', '.github/workflows/ci.yml', '.github/workflows/codeql.yml'])
    assert(Buffer.byteLength(read(file)) <= 500000, `${file} exceeds conservative 500000-byte bound`);
});

test('publisher version check and one submission stay after archive selection and outside checkout', () => {
  const block = jobBlock('publish');
  assert(block.indexOf('node scripts/release-runner.cjs publish') < block.indexOf('Require the pinned bundled npm'));
  assert.equal(
    (
      block.match(
        /working-directory: \$\{\{ runner.temp \}\}\/foottrace-publish-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}/g,
      ) ?? []
    ).length,
    2,
  );
  assert.equal((block.match(/if: steps.control.outputs.submit == 'true'/g) ?? []).length, 2);
  assert.match(block, /NODE_AUTH_TOKEN: ''/);
  assert.match(publish, /  NODE_OPTIONS: ''\n  NODE_PATH: ''/);
});
test('docs permit explicit owner delegation while retaining separate GitHub approval and setup', () => {
  const guide = read('docs/RELEASING.md');
  for (const term of [
    'explicitly authorize Codex or Claude',
    'existing authorized User account',
    'Standing authorization for FootTrace releases',
    'names the submitting agent',
    'recorded publicly',
    'physical operator',
    'cannot authenticate private authorization',
    'does not submit approvals',
    'Approve',
    'write',
    'admin',
    'RELEASE_APP_CLIENT_ID',
    'RELEASE_APP_SLUG',
    'RELEASE_APP_PRIVATE_KEY',
  ])
    assert(guide.includes(term));
  assert.match(guide, /exchange.*not.*approval/i);
  assert.match(guide, /No independent technical review is waived/);
  assert.match(guide, /unavailable authentication or insufficient permission holds/i);
  assert.doesNotMatch(guide, /owner (?:must |)(?:personally|manually) submit/i);
  assert.doesNotMatch(guide, /approval[^\n]*by another human/i);
  assert.doesNotMatch(guide, /compressed literal|embedded program|generated.*template/);
});

test('trusted workflow triggers and context stay bound to the actual event', () => {
  const triggers = /^on:\n([\s\S]*?)^permissions:/m.exec(publish)?.[1];
  assert.equal(
    triggers,
    '  push:\n    branches: [main]\n  workflow_dispatch:\n    inputs:\n      verify_only:\n        description: Inspect the existing release without preparation or submission\n        type: boolean\n        default: false\n',
  );
  assert.equal(condition('plan'), "github.ref == 'refs/heads/main'");
  for (const [name, field] of [
    ['REPO_ID', 'repository_id'],
    ['REPO_NAME', 'repository'],
    ['SOURCE_SHA', 'sha'],
    ['SOURCE_REF', 'ref'],
    ['EVENT_NAME', 'event_name'],
    ['RUN_ID', 'run_id'],
    ['RUN_ATTEMPT', 'run_attempt'],
  ]) {
    assert.equal(
      (publish.match(new RegExp(`^  ${name}: .+$`, 'gm')) ?? []).join(''),
      `  ${name}: \u0024{{ github.${field} }}`,
    );
    assert.doesNotMatch(publish, new RegExp(`^ {4,}${name}:`, 'm'));
  }
});
