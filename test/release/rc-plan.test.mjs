import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { managedReleaseFixture, sha } from './helpers.mjs';
const require = createRequire(import.meta.url),
  runtime = require('../../scripts/release-github.cjs');
async function succeeds(action) {
  let value;
  await assert.doesNotReject(async () => {
    value = await action();
  });
  return value;
}
function fixture() {
  const f = managedReleaseFixture({ version: '1.11.0', published: true }),
    api = f.api;
  f.context.eventName = 'workflow_dispatch';
  f.context.rc = true;
  f.context.bump = 'major';
  f.api = async (method, route, body) => {
    if (route === '/repos/footprintjs/foottrace/git/matching-refs/tags/v') {
      f.calls.push({ method, route, body });
      assert.equal(method, 'GET');
      return {
        data: [...f.tags].map(([tag, source]) => ({
          ref: 'refs/tags/' + tag,
          object: { type: 'commit', sha: source },
        })),
      };
    }
    return api(method, route, body);
  };
  return f;
}
test('RC plan leaves the ordinary stable fragment route intact', async () => {
  const f = fixture();
  f.context.rc = false;
  const p = await succeeds(() => runtime.plan(f.api, f.context, f.options));
  assert.equal(p.mode, 'prepare');
  assert.equal(p.version, '1.11.1');
});
test('RC plan uses explicit major dispatch and the exact native tags, not the patch queue', async () => {
  const f = fixture();
  f.tags.set('v2.0.0-rc.2', sha('8'));
  f.tags.set('v2.0.0-rc.9', sha('8'));
  const p = await succeeds(() => runtime.plan(f.api, f.context, f.options));
  assert.equal(p.mode, 'rc');
  assert.equal(p.fromVersion, '1.11.0');
  assert.equal(p.version, '2.0.0-rc.10');
  assert.equal(p.sha, f.context.sha);
  assert.equal(p.tree, f.commits.get(f.context.sha).tree.sha);
  assert(f.calls.every((c) => c.method === 'GET'));
  assert.equal(f.pulls.filter((x) => x.state === 'open').length, 0);
});

for (const [name, change, code] of [
  ['push event', (f) => (f.context.eventName = 'push'), 'rc-event'],
  ['verify-only dispatch', (f) => (f.context.verify = true), 'rc-event'],
  ['missing explicit bump', (f) => delete f.context.bump, 'rc-bump'],
  ['unpublished stable predecessor', (f) => f.registry.clear(), 'rc-stable'],
  ['stable latest drift', (f) => (f.latest = '1.10.0'), 'rc-stable'],
  ['moved main', (f) => f.moveMain(), 'main-moved'],
  [
    'open release proposal',
    (f) => f.pulls.push({ ...f.originalPR, id: 900, number: 900, state: 'open', merged: false, merged_at: null }),
    'rc-proposal',
  ],
  ['malformed matching tag', (f) => f.tags.set('v2.0.0-rc.01', sha('8')), 'rc-tag-number'],
])
  test('RC plan refuses ' + name + ' without effects', async () => {
    const f = fixture();
    change(f);
    await assert.rejects(() => runtime.plan(f.api, f.context, f.options), { code });
    assert(f.calls.every((c) => c.method === 'GET'));
  });
test('RC planning refuses unavailable native tag inventory rather than using zero', async () => {
  const f = fixture(),
    api = f.api;
  f.api = async (...args) => {
    if (args[1].includes('/git/matching-refs/')) throw Object.assign(new Error('private'), { status: 500 });
    return api(...args);
  };
  await assert.rejects(() => runtime.plan(f.api, f.context, f.options));
  assert(f.calls.every((c) => c.method === 'GET'));
});
test('RC publication continuation keeps its reserved number rather than selecting N+1', async () => {
  const f = fixture(),
    p = await succeeds(() => runtime.plan(f.api, f.context, f.options));
  f.tags.set('v' + p.version, f.context.sha);
  const w = await succeeds(() => runtime.rcSource(f.api, f.context, p, 'publish', f.options));
  assert.equal(w.expected.version, p.version);
  assert.equal(w.selectedVersion, undefined);
});
test('RC publication continuation holds after current main moves', async () => {
  const f = fixture(),
    p = await succeeds(() => runtime.plan(f.api, f.context, f.options));
  f.tags.set('v' + p.version, f.context.sha);
  f.moveMain();
  await assert.rejects(() => runtime.rcSource(f.api, f.context, p, 'publish', f.options), { code: 'main-moved' });
});
test('final preparation names its hold when queued fragments do not match the unpromoted RC core', async () => {
  const f = fixture();
  f.context.rc = false;
  f.tags.set('v2.0.0-rc.0', sha('8'));
  await assert.rejects(() => runtime.plan(f.api, f.context, f.options), { code: 'rc-final-target' });
  assert(f.calls.every((c) => c.method === 'GET'));
});

test('final preparation accepts the newest numeric RC core when the fragment target agrees', async () => {
  const f = fixture();
  f.context.rc = false;
  f.tags.set('v1.12.0-rc.99', sha('8'));
  f.tags.set('v2.0.0-rc.1', sha('8'));
  const pure = require('../../scripts/release-prepare.cjs');
  f.advance((inventory) => {
    const path = '.changes/helper-fix.md',
      bytes = Buffer.from('---\ntype: changed\nbump: major\n---\n\n- Intended major.\n');
    inventory.set(path, { bytes, mode: '100644', sha: pure.gitObject('blob', bytes) });
  });
  const p = await succeeds(() => runtime.plan(f.api, f.context, f.options));
  assert.equal(p.mode, 'prepare');
  assert.equal(p.version, '2.0.0');
});
test('promoted RC cores do not freeze the next ordinary stable patch', async () => {
  const f = managedReleaseFixture({ version: '2.0.0', published: true });
  f.tags.set('v2.0.0-rc.9', sha('8'));
  const p = await succeeds(() => runtime.plan(f.api, f.context, f.options));
  assert.equal(p.mode, 'prepare');
  assert.equal(p.version, '2.0.1');
});
test('unknown final tag inventory refuses instead of silently bypassing the RC target hold', async () => {
  const f = fixture();
  f.context.rc = false;
  const api = f.api;
  f.api = async (...args) => {
    if (args[1].includes('/git/matching-refs/')) throw Object.assign(new Error('private'), { status: 403 });
    return api(...args);
  };
  await assert.rejects(() => runtime.plan(f.api, f.context, f.options));
  assert(f.calls.every((c) => c.method === 'GET'));
});
for (const [name, rows] of [
  ['unavailable', undefined],
  ['non-array', {}],
  [
    'duplicate names',
    [
      { ref: 'refs/tags/v2.0.0-rc.0', object: { type: 'commit', sha: sha('8') } },
      { ref: 'refs/tags/v2.0.0-rc.0', object: { type: 'commit', sha: sha('8') } },
    ],
  ],
  ['wrong namespace', [{ ref: 'refs/heads/main', object: { type: 'commit', sha: sha('8') } }]],
  ['unknown target', [{ ref: 'refs/tags/v2.0.0-rc.0', object: { type: 'commit', sha: 'main' } }]],
  [
    'oversized',
    Array.from({ length: 4097 }, (_, i) => ({
      ref: 'refs/tags/v2.0.0-rc.' + i,
      object: { type: 'commit', sha: sha('8') },
    })),
  ],
])
  test('RC native tag inventory refuses ' + name, async () => {
    const f = fixture();
    await assert.rejects(() => runtime.rcTagRefs(async () => ({ data: rows }), f.context), { code: 'rc-tags' });
  });
test('an already published registry candidate cannot become planning authority through absent tag metadata', async () => {
  const f = fixture();
  f.registry.set('2.0.0-rc.0', {
    metadata: { name: 'foottrace', version: '2.0.0-rc.0', dist: { integrity: 'sha512-synthetic' } },
  });
  await assert.rejects(() => runtime.plan(f.api, f.context, f.options), { code: 'rc-registry' });
  assert(f.calls.every((c) => c.method === 'GET'));
});

test('RC planning rechecks mutable main after the outer event check', async () => {
  const f = fixture(),
    api = f.api;
  let reads = 0;
  f.api = async (...args) => {
    if (args[1].endsWith('/git/ref/heads/main') && ++reads > 1)
      return { data: { object: { type: 'commit', sha: sha('9') } } };
    return api(...args);
  };
  await assert.rejects(() => runtime.plan(f.api, f.context, f.options), { code: 'main-moved' });
  assert(f.calls.every((c) => c.method === 'GET'));
});
