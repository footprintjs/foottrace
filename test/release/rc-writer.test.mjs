import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rcWriteFixture } from './rc-fixture.mjs';
import { syntheticPackageArchive } from './helpers.mjs';
const require = createRequire(import.meta.url),
  runtime = require('../../scripts/release-github.cjs'),
  arc = require('../../scripts/release-archive.cjs');
async function prepared() {
  const f = rcWriteFixture(),
    p = await runtime.plan(f.api, f.context, f.options),
    identity = (await runtime.collectRcAuthority(f.api, f.context, p, 'authority', f.options)).identity;
  f.setRole('release');
  const bytes = syntheticPackageArchive(p.version),
    archive = arc.inspectArchive(bytes, { package: 'foottrace', version: p.version });
  return { f, p, identity, bytes, archive };
}
const write = (x) => runtime.releaseState(x.f.api, x.f.context, x.identity, x.archive, null);
test('RC fresh writer creates one explicit tag, prerelease/latest=false and own attempt marker', async () => {
  const x = await prepared();
  let grant;
  await assert.doesNotReject(async () => {
    grant = await write(x);
  });
  const release = x.f.releases.get(x.identity.tag);
  assert.equal(release.prerelease, true);
  assert.equal(x.f.calls.find((c) => c.method === 'POST' && c.route.endsWith('/releases')).body.make_latest, 'false');
  assert.equal(grant.fresh, true);
  assert.equal(x.f.implicitTags, 0);
  assert.equal(x.f.calls.filter((c) => c.method === 'POST').length, 3);
  assert.equal(await runtime.publishGrant(x.f.api, x.f.context, x.identity, x.archive, grant), true);
});
test('RC initial writer never adopts even a same-SHA existing tag', async () => {
  const x = await prepared();
  x.f.tags.set(x.identity.tag, x.f.context.sha);
  await assert.rejects(() => write(x), { code: 'rc-existing-tag' });
  assert.equal(x.f.calls.filter((c) => c.method === 'POST').length, 0);
});
test('RC initial writer never adopts an existing release even while its tag read is absent', async () => {
  const x = await prepared();
  x.f.releases.set(x.identity.tag, {
    id: 101,
    tag_name: x.identity.tag,
    target_commitish: x.f.context.sha,
    body: await runtime.sourceReleaseNotes(x.f.api, x.f.context, x.identity.version),
    draft: false,
    prerelease: true,
    assets: [],
  });
  await assert.rejects(() => write(x), { code: 'rc-existing-release' });
  assert.equal(x.f.calls.filter((c) => c.method === 'POST').length, 0);
});

test('uncertain tag create stops; a fresh dispatch that cannot see it holds on strict 422', async () => {
  const x = await prepared();
  x.f.uncertainTag = true;
  x.f.hiddenTags.add(x.identity.tag);
  await assert.rejects(() => write(x));
  assert.equal(x.f.calls.filter((c) => c.method === 'POST').length, 1);
  const nextContext = { ...x.f.context, runId: 501, runAttempt: 1 };
  const refs = await runtime.rcTagRefs(x.f.api, nextContext),
    rc = require('../../scripts/release-rc-version.cjs');
  assert.equal(rc.candidateVersion(x.p.fromVersion, 'major', refs), x.p.version);
  await assert.rejects(
    () => runtime.releaseState(x.f.api, nextContext, x.identity, x.archive, null),
    (e) => e.status === 422,
  );
  const posts = x.f.calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 2);
  assert(posts.every((c) => c.route.endsWith('/git/refs')));
  assert.equal(x.f.releases.has(x.identity.tag), false);
});
test('RC rerun attempt after a landed tag holds and cannot reuse the old marker grant', async () => {
  const x = await prepared(),
    grant = await write(x),
    posts = x.f.calls.filter((c) => c.method === 'POST').length;
  const rerun = { ...x.f.context, runAttempt: x.f.context.runAttempt + 1 };
  await assert.rejects(() => runtime.releaseState(x.f.api, rerun, x.identity, x.archive, null), {
    code: 'rc-existing-tag',
  });
  assert.equal(x.f.calls.filter((c) => c.method === 'POST').length, posts);
  await assert.rejects(() => runtime.publishGrant(x.f.api, rerun, x.identity, x.archive, grant), {
    code: 'journal-grant',
  });
});
test('uncertainty after release creation burns N; the next dispatch creates N+1 with its own marker', async () => {
  const x = await prepared();
  x.f.uncertainRelease = true;
  await assert.rejects(() => write(x));
  assert.equal(x.f.calls.filter((c) => c.method === 'POST').length, 2);
  assert.equal(x.f.markerAssets.size, 0);
  const rc = require('../../scripts/release-rc-version.cjs'),
    version = rc.candidateVersion(x.p.fromVersion, 'major', await runtime.rcTagRefs(x.f.api, x.f.context));
  assert.equal(version, '2.0.0-rc.1');
  const identity = { ...x.identity, version, tag: 'v' + version },
    context = { ...x.f.context, runId: 501, runAttempt: 1 };
  const archive = arc.inspectArchive(syntheticPackageArchive(version), { package: 'foottrace', version });
  let grant;
  await assert.doesNotReject(async () => {
    grant = await runtime.releaseState(x.f.api, context, identity, archive, null);
  });
  assert.equal(grant.runId, 501);
  assert.equal(grant.runAttempt, 1);
  assert.equal(x.f.releases.get(x.identity.tag).assets.length, 0);
  assert.equal(x.f.releases.get(identity.tag).assets.length, 1);
  assert.equal(x.f.tags.get(x.identity.tag), x.f.context.sha);
  assert.equal(x.f.implicitTags, 0);
});
test('existing marker/release is never adopted even in the same run when the tag read is hidden', async () => {
  const x = await prepared();
  await write(x);
  x.f.hiddenTags.add(x.identity.tag);
  const posts = x.f.calls.filter((c) => c.method === 'POST').length;
  await assert.rejects(() => write(x), { code: 'rc-existing-release' });
  assert.equal(x.f.calls.filter((c) => c.method === 'POST').length, posts);
});
test('uncertain marker upload stops without retry and the next attempt cannot adopt it', async () => {
  const x = await prepared();
  x.f.uncertainMarker = true;
  await assert.rejects(() => write(x));
  assert.equal(x.f.calls.filter((c) => c.method === 'POST').length, 3);
  assert.equal(x.f.markerAssets.size, 1);
  await assert.rejects(() => write(x), { code: 'rc-existing-tag' });
  assert.equal(x.f.calls.filter((c) => c.method === 'POST').length, 3);
});
for (const [name, change, code, postCount] of [
  ['incoherent tag acknowledgement', (f) => (f.badTagAck = true), 'rc-tag-create', 1],
  ['incoherent release acknowledgement', (f) => (f.badReleaseAck = true), 'release-conflict', 2],
])
  test('RC writer holds on ' + name, async () => {
    const x = await prepared();
    change(x.f);
    await assert.rejects(() => write(x), { code });
    assert.equal(x.f.calls.filter((c) => c.method === 'POST').length, postCount);
    assert.equal(x.f.markerAssets.size, 0);
  });
for (const [name, suffix, postCount] of [
  ['tag', '/git/refs', 1],
  ['release', '/releases', 2],
])
  test('RC writer rechecks main after the ' + name + ' create', async () => {
    const x = await prepared(),
      api = x.f.api;
    x.f.api = async (...args) => {
      const result = await api(...args);
      if (args[0] === 'POST' && args[1].endsWith(suffix)) x.f.moveMain();
      return result;
    };
    await assert.rejects(() => write(x), { code: 'main-moved' });
    assert.equal(x.f.calls.filter((c) => c.method === 'POST').length, postCount);
  });
test('RC writer does not issue a grant for an unusable marker acknowledgement', async () => {
  const x = await prepared(),
    api = x.f.api;
  x.f.api = async (...args) => {
    const result = await api(...args);
    return args[0] === 'POST' && args[1].startsWith('https://uploads.github.com')
      ? { ...result, data: { ...result.data, id: 0 } }
      : result;
  };
  await assert.rejects(() => write(x), { code: 'reservation-ambiguous' });
  assert.equal(x.f.calls.filter((c) => c.method === 'POST').length, 3);
});
test('RC writer refuses an already present registry version before any create', async () => {
  const x = await prepared();
  await assert.rejects(
    () =>
      runtime.releaseState(x.f.api, x.f.context, x.identity, x.archive, {
        version: x.p.version,
        integrity: x.archive.integrity,
      }),
    { code: 'rc-registry' },
  );
  assert.equal(x.f.calls.filter((c) => c.method === 'POST').length, 0);
});

test('RC publish grant must still belong to this tag release and its source notes', async () => {
  const x = await prepared(),
    grant = await write(x);
  x.f.releases.get(x.identity.tag).body = 'changed after reservation\n';
  await assert.rejects(() => runtime.publishGrant(x.f.api, x.f.context, x.identity, x.archive, grant), {
    code: 'release-conflict',
  });
});
test('RC publish grant cannot move to an asset outside the pinned release', async () => {
  const x = await prepared(),
    grant = await write(x);
  x.f.releases.get(x.identity.tag).assets = [];
  await assert.rejects(() => runtime.publishGrant(x.f.api, x.f.context, x.identity, x.archive, grant), {
    code: 'journal-grant',
  });
});

for (const [name, predicate, code] of [
  ['tag', (route) => route.endsWith('/git/refs'), 'rc-tag-create'],
  ['release', (route) => route.endsWith('/releases'), 'rc-release-create'],
  ['marker', (route) => route.startsWith('https://uploads.github.com'), 'reservation-ambiguous'],
])
  test('RC create requires its own 201 acknowledgement for ' + name, async () => {
    const x = await prepared(),
      api = x.f.api;
    x.f.api = async (...args) => {
      const r = await api(...args);
      return args[0] === 'POST' && predicate(args[1]) ? { ...r, status: 200 } : r;
    };
    await assert.rejects(() => write(x), { code });
  });
