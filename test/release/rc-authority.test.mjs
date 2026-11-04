import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { authorityWorld, sha } from './helpers.mjs';
const require = createRequire(import.meta.url),
  control = require('../../scripts/release-control.cjs');
test('RC authority: existing stable PR authority remains its own decision', () => {
  assert.equal(control.decideAuthority(authorityWorld()).authorized, true);
});
test('RC authority: the named phase-specific package-native decision exists', () => {
  assert.equal(typeof control.decideRcAuthority, 'function', 'missing named RC authority decision');
});

function world(phase = 'initial') {
  const old = authorityWorld(),
    repository = old.expected.repository,
    source = sha('1'),
    tree = sha('3');
  const expected = {
    mode: 'rc',
    repository,
    sourceSha: source,
    tree,
    package: 'foottrace',
    fromVersion: '1.11.0',
    version: '2.0.0-rc.0',
    tag: 'v2.0.0-rc.0',
  };
  return {
    expected,
    event: { name: 'workflow_dispatch', ref: 'refs/heads/main', sha: source, repository },
    bump: 'major',
    currentMain: source,
    sourceCommit: { sha: source, tree: { sha: tree } },
    sourcePackage: { name: 'foottrace', version: '1.11.0' },
    publication: { state: 'published', version: '1.11.0', latest: '1.11.0' },
    pullsComplete: true,
    pulls: [],
    app: old.app,
    runId: 500,
    runAttempt: 1,
    producer: {
      id: 80,
      status: 'in_progress',
      conclusion: null,
      name: phase === 'publish' ? 'publish' : 'authority',
      run_id: 500,
      run_attempt: 1,
      head_sha: source,
    },
    selectedVersion: expected.version,
    tag: phase === 'publish' ? source : null,
    registry: null,
  };
}
const decide = (w, phase = 'initial') => control.decideRcAuthority(w, phase);
test('RC authority: initial five admissions are source eligibility, not a publish grant', () => {
  const w = world(),
    r = decide(w);
  assert.equal(r.authorized, true);
  assert.equal(r.mayPublish, false);
  assert.deepEqual(r.identity, w.expected);
});
test('RC authority: publish uses this source tag without reselecting the next number', () => {
  const w = world('publish');
  delete w.selectedVersion;
  assert.equal(decide(w, 'publish').authorized, true);
  w.registry = { version: w.expected.version, integrity: 'not-yet-compared-with-archive' };
  const r = decide(w, 'publish');
  assert.equal(r.authorized, true);
  assert.equal(r.mayPublish, false);
});
for (const [name, change, reason] of [
  ['push event', (w) => (w.event.name = 'push'), 'rc-event'],
  ['foreign ref', (w) => (w.event.ref = 'refs/heads/other'), 'rc-event'],
  ['foreign event repository', (w) => (w.event.repository = { id: 124, full_name: 'other/repo' }), 'rc-event'],
  ['moved main', (w) => (w.currentMain = sha('9')), 'rc-main'],
  ['wrong source tree', (w) => (w.sourceCommit.tree.sha = sha('9')), 'rc-source'],
  ['wrong stable source package', (w) => (w.sourcePackage.version = '1.10.0'), 'rc-source'],
  [
    'noncanonical version',
    (w) => {
      w.expected.version = '2.0.0-rc.01';
      w.expected.tag = 'v' + w.expected.version;
    },
    'rc-version',
  ],
  [
    'lowered candidate core',
    (w) => {
      w.expected.version = '1.11.1-rc.0';
      w.expected.tag = 'v' + w.expected.version;
    },
    'rc-version',
  ],
  ['absent dispatch bump', (w) => delete w.bump, 'rc-version'],
  ['unpublished stable', (w) => (w.publication.state = 'pending'), 'rc-stable'],
  ['latest drift', (w) => (w.publication.latest = '1.10.0'), 'rc-stable'],
  ['open release proposal', (w) => (w.pulls = [{ number: 100 }]), 'rc-proposal'],
  ['incomplete proposal read', (w) => (w.pullsComplete = false), 'rc-proposal'],
  ['unknown proposal read', (w) => delete w.pulls, 'rc-proposal'],
  ['wrong configured App', (w) => (w.app.metadata.client_id = 'different'), 'rc-app'],
  ['missing current producer', (w) => delete w.producer, 'rc-producer'],
  ['old producer attempt', (w) => (w.producer.run_attempt = 2), 'rc-producer'],
  ['wrong producer source', (w) => (w.producer.head_sha = sha('8')), 'rc-producer'],
  ['unprivileged build producer', (w) => (w.producer.name = 'build'), 'rc-producer'],
  ['different selected N', (w) => (w.selectedVersion = '2.0.0-rc.1'), 'rc-plan'],
  ['existing candidate tag', (w) => (w.tag = w.expected.sourceSha), 'rc-tag'],
  ['unknown tag read', (w) => delete w.tag, 'rc-tag'],
  ['existing registry version', (w) => (w.registry = { version: w.expected.version }), 'rc-registry'],
  ['unknown registry read', (w) => delete w.registry, 'rc-registry'],
])
  test('RC authority initial refuses ' + name, () => {
    const w = world();
    change(w);
    const r = decide(w);
    assert.equal(r.authorized, false);
    assert.equal(r.reason, reason);
  });
for (const [name, change, reason] of [
  ['moved main', (w) => (w.currentMain = sha('9')), 'rc-main'],
  ['foreign tag source', (w) => (w.tag = sha('9')), 'rc-tag'],
  ['unknown tag', (w) => delete w.tag, 'rc-tag'],
  ['foreign registry version', (w) => (w.registry = { version: '2.0.0-rc.1' }), 'rc-registry'],
  ['unknown registry state', (w) => delete w.registry, 'rc-registry'],
  ['old producer attempt', (w) => (w.producer.run_attempt = 2), 'rc-producer'],
  ['proposal opened after reservation', (w) => (w.pulls = [{ number: 100 }]), 'rc-proposal'],
])
  test('RC authority publish refuses ' + name, () => {
    const w = world('publish');
    change(w);
    const r = decide(w, 'publish');
    assert.equal(r.authorized, false);
    assert.equal(r.reason, reason);
  });
test('RC authority: unknown phase cannot select an admission recipe', () => {
  assert.equal(decide(world(), 'other').authorized, false);
});

for (const [name, change] of [
  ['queued job', (w) => (w.producer.status = 'queued')],
  [
    'completed old role',
    (w) => {
      w.producer.status = 'completed';
      w.producer.conclusion = 'success';
    },
  ],
  ['unknown job status', (w) => delete w.producer.status],
  ['invalid job ID', (w) => (w.producer.id = 0)],
])
  test('RC authority current producer refuses ' + name, () => {
    const w = world();
    change(w);
    const r = decide(w);
    assert.equal(r.authorized, false);
    assert.equal(r.reason, 'rc-producer');
  });
