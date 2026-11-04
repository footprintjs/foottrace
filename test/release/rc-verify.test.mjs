import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { syntheticPackageArchive, sha } from './helpers.mjs';
const require = createRequire(import.meta.url),
  runtime = require('../../scripts/release-github.cjs'),
  archive = require('../../scripts/release-archive.cjs');
function fixture() {
  const repository = { id: 123, full_name: 'footprintjs/foottrace' },
    version = '2.0.0-rc.0',
    source = sha('1');
  const context = {
    repository,
    sha: source,
    ref: 'refs/heads/main',
    eventName: 'workflow_dispatch',
    runId: 500,
    runAttempt: 2,
  };
  const pinned = {
    mode: 'rc',
    repository,
    sha: source,
    tree: sha('3'),
    package: 'foottrace',
    version,
    fromVersion: '1.11.0',
  };
  const bytes = syntheticPackageArchive(version),
    info = archive.inspectArchive(bytes, { package: 'foottrace', version });
  const marker = { version, runId: 500, runAttempt: 2, sha: source, integrity: info.integrity };
  const f = {
    context,
    pinned,
    bytes,
    info,
    marker,
    main: source,
    tag: source,
    next: version,
    latest: '1.11.0',
    calls: [],
    reads: [],
  };
  f.release = {
    id: 20,
    tag_name: 'v' + version,
    target_commitish: source,
    draft: false,
    prerelease: true,
    body: 'Release candidate ' + version + ' from ' + source + '.\n',
  };
  f.api = async (method, route, body) => {
    f.calls.push({ method, route });
    assert.equal(method, 'GET', 'Verification is GET-only');
    const base = '/repos/footprintjs/foottrace';
    if (route === base + '/git/ref/heads/main') return { data: { object: { type: 'commit', sha: f.main } } };
    if (route === base + '/git/ref/tags/v' + version) return { data: { object: { type: 'commit', sha: f.tag } } };
    if (route === base + '/releases/tags/v' + version) return { data: f.release };
    const raw = Buffer.from(JSON.stringify(f.marker));
    if (route === base + '/releases/20/assets?per_page=100&page=1')
      return { data: [{ id: 21, name: 'publish-attempt-' + version + '.json', size: raw.length, state: 'uploaded' }] };
    if (route === base + '/releases/assets/21' && body?.accept === 'application/octet-stream') return { data: raw };
    // The pinned source keeps its STABLE changelog; an RC has no RC commit.
    if (route === base + '/contents/CHANGELOG.md?ref=' + source) {
      const text = '# Changelog\n\n## 1.11.0 — 2026-11-01\n\n- Stable release.\n';
      return {
        data: {
          type: 'file',
          encoding: 'base64',
          content: Buffer.from(text).toString('base64'),
          size: Buffer.byteLength(text),
        },
      };
    }
    assert.fail('Unexpected RC verification route ' + route);
  };
  f.fetcher = async (url, options) => {
    f.reads.push(url);
    assert(!options?.method || options.method === 'GET');
    const base = 'https://registry.npmjs.org/foottrace';
    if (url === base + '/' + version)
      return Response.json({
        name: 'foottrace',
        version,
        dist: {
          integrity: f.info.integrity,
          shasum: f.info.shasum,
          tarball: base + '/-/foottrace-' + version + '.tgz',
        },
      });
    if (url === base + '/-/foottrace-' + version + '.tgz') return new Response(f.bytes);
    if (url === base + '/latest') return Response.json({ name: 'foottrace', version: f.latest });
    if (url === base + '/next') return Response.json({ name: 'foottrace', version: f.next });
    assert.fail('Unexpected RC registry read ' + url);
  };
  return f;
}
test('RC verify derives fixed source-bound notes without an RC changelog commit', async () => {
  const f = fixture();
  let notes;
  await assert.doesNotReject(async () => {
    notes = await runtime.sourceReleaseNotes(f.api, f.context, f.pinned.version);
  });
  assert.equal(notes, f.release.body);
  assert.equal(f.calls.length, 0);
});
test('RC verify checks exact package bytes, current-attempt marker, next and unchanged latest', async () => {
  const f = fixture();
  let result;
  await assert.doesNotReject(async () => {
    result = await runtime.verifyPublished(f.api, f.context, f.pinned, f.fetcher);
  });
  assert.equal(result.state, 'verified');
  assert.equal(result.version, f.pinned.version);
  assert.equal(result.next, f.pinned.version);
  assert.equal(result.latest, f.pinned.fromVersion);
  assert.equal(result.sha256, f.info.sha256);
  assert.equal(result.provenanceCryptographicallyVerified, false);
  assert.equal(f.reads.filter((u) => u.endsWith('/next')).length, 1);
  assert.equal(f.reads.filter((u) => u.endsWith('/latest')).length, 1);
  assert(f.calls.every((x) => x.method === 'GET'));
});

for (const [name, change, code] of [
  ['next moved', (f) => (f.next = '2.0.0-rc.1'), 'rc-next'],
  ['latest changed', (f) => (f.latest = '2.0.0'), 'rc-latest'],
  ['old reservation run', (f) => (f.marker.runId = 499), 'journal-conflict'],
  ['old reservation attempt', (f) => (f.marker.runAttempt = 1), 'journal-conflict'],
  ['foreign reservation source', (f) => (f.marker.sha = sha('9')), 'journal-conflict'],
  ['unadmitted reservation field', (f) => (f.marker.extra = 'not-a-grant'), 'journal-conflict'],
  ['wrong package bytes', (f) => (f.bytes = syntheticPackageArchive('2.0.0-rc.1')), 'invalid-archive'],
  ['registry byte digest', (f) => (f.info.shasum = sha('9')), 'registry-bytes'],
  ['registry integrity', (f) => (f.info.integrity = 'sha512-not-the-archive'), 'registry-conflict'],
  ['foreign tag source', (f) => (f.tag = sha('9')), 'release-conflict'],
  ['ordinary final release flag', (f) => (f.release.prerelease = false), 'release-conflict'],
  ['wrong source release notes', (f) => (f.release.body = 'different\n'), 'release-conflict'],
  ['wrong release source', (f) => (f.release.target_commitish = sha('9')), 'release-conflict'],
  ['moved current main', (f) => (f.main = sha('9')), 'main-moved'],
])
  test('RC verify refuses ' + name, async () => {
    const f = fixture();
    change(f);
    await assert.rejects(() => runtime.verifyPublished(f.api, f.context, f.pinned, f.fetcher), { code });
    assert(f.calls.every((c) => c.method === 'GET'));
  });
for (const [name, suffix, response, code] of [
  ['unknown next', '/next', () => new Response('', { status: 404 }), 'registry-unavailable'],
  ['unavailable latest', '/latest', () => new Response('', { status: 503 }), 'registry-unavailable'],
  [
    'malformed next',
    '/next',
    () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    'registry-next-json:json',
  ],
  ['foreign next package', '/next', () => Response.json({ name: 'other', version: '2.0.0-rc.0' }), 'registry-shape'],
  ['foreign latest package', '/latest', () => Response.json({ name: 'other', version: '1.11.0' }), 'registry-shape'],
])
  test('RC verify refuses ' + name + ' without polling', async () => {
    const f = fixture(),
      fetcher = f.fetcher;
    let attempts = 0;
    f.fetcher = async (url, options) => {
      if (url.endsWith(suffix)) {
        attempts++;
        return response();
      }
      return fetcher(url, options);
    };
    await assert.rejects(() => runtime.verifyPublished(f.api, f.context, f.pinned, f.fetcher), { code });
    assert.equal(attempts, 1);
  });
test('RC verify rechecks current main before reporting verified', async () => {
  const f = fixture(),
    api = f.api;
  let reads = 0;
  f.api = async (...args) => {
    if (args[1].endsWith('/git/ref/heads/main') && ++reads > 1)
      return { data: { object: { type: 'commit', sha: sha('9') } } };
    return api(...args);
  };
  await assert.rejects(() => runtime.verifyPublished(f.api, f.context, f.pinned, f.fetcher), { code: 'main-moved' });
});
test('RC verify pending registry is diagnostic only and never enables submission', async () => {
  const f = fixture(),
    fetcher = f.fetcher;
  f.fetcher = (url, options) =>
    url.endsWith('/' + f.pinned.version) ? Promise.resolve(new Response('{}', { status: 404 })) : fetcher(url, options);
  const result = await runtime.verifyPublished(f.api, f.context, f.pinned, f.fetcher);
  assert.equal(result.state, 'pending-registry');
  assert.notEqual(result.mayPublish, true);
  assert(f.calls.every((c) => c.method === 'GET'));
  assert(!f.reads.some((u) => u.endsWith('/next')));
});
test('RC notes reject noncanonical candidate numbers before any content read', async () => {
  const f = fixture();
  await assert.rejects(() => runtime.sourceReleaseNotes(f.api, f.context, '2.0.0-rc.01'), { code: 'rc-version' });
  assert.equal(f.calls.length, 0);
});

test('native RC verify entry returns diagnostic verification without any submission path', async () => {
  const f = fixture();
  let result;
  await assert.doesNotReject(async () => {
    result = await runtime.runStage('verify', {
      context: f.context,
      env: { PLAN_JSON: JSON.stringify(f.pinned) },
      api: f.api,
      fetcher: f.fetcher,
      io: { write: () => assert.fail('verify must not write a package') },
    });
  });
  assert.equal(JSON.parse(result.verification).state, 'verified');
  assert.equal(Object.hasOwn(result, 'submit'), false);
  assert(f.calls.every((c) => c.method === 'GET'));
});
