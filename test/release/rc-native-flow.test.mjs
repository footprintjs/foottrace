import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { rcWriteFixture } from './rc-fixture.mjs';
import { artifactZip, syntheticPackageArchive, executeWorkflowStage } from './helpers.mjs';
const require = createRequire(import.meta.url),
  runtime = require('../../scripts/release-github.cjs'),
  arc = require('../../scripts/release-archive.cjs');
function outputs(result) {
  assert.equal(result.failure, null);
  return Object.fromEntries(
    result.output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
}
async function candidate({ release = true } = {}) {
  const f = rcWriteFixture(),
    p = await runtime.plan(f.api, f.context, f.options);
  const env = {
    REPO_ID: '123',
    REPO_NAME: f.repository.full_name,
    SOURCE_SHA: f.context.sha,
    SOURCE_REF: f.context.ref,
    EVENT_NAME: 'workflow_dispatch',
    RUN_ID: '500',
    RUN_ATTEMPT: '2',
    RC: 'true',
    RC_BUMP: 'major',
    PLAN_JSON: JSON.stringify(p),
    APP_SLUG: 'release-app',
    APP_CLIENT_ID: 'public-client-id',
  };
  const authority = outputs(await executeWorkflowStage('authority', { env, api: f.api, fetcher: f.fetcher }));
  env.IDENTITY_JSON = authority.identity;
  const verdict = outputs(await executeWorkflowStage('verdict', { env, api: f.api, fetcher: f.fetcher }));
  assert.equal(verdict.tested, 'false');
  f.setRole('build');
  const source = f.trees.get(f.commits.get(f.context.sha).tree.sha),
    sourceManifest = JSON.parse(source.get('package.json').bytes),
    bytes = syntheticPackageArchive(p.version, { ...sourceManifest, version: p.version }),
    files = new Map();
  await runtime.runStage('build-manifest', {
    api: f.api,
    context: f.context,
    env,
    fetcher: f.fetcher,
    io: {
      gitTree: () => p.tree,
      requireClean: () => {},
      read: (name) => {
        if (name === 'pack.json') return Buffer.from(JSON.stringify([{ filename: 'foottrace-' + p.version + '.tgz' }]));
        if (name === 'foottrace-' + p.version + '.tgz') return bytes;
        assert(source.has(name));
        return source.get(name).bytes;
      },
      write: (name, value) => files.set(name, Buffer.from(value)),
    },
  });
  const manifest = JSON.parse(files.get('release-artifact/manifest.json')),
    info = arc.inspectArchive(bytes, { package: 'foottrace', version: p.version });
  const envelope = {
    id: 400,
    name: 'foottrace-123-500-2-build',
    expired: false,
    workflow_run: { id: 500, head_sha: f.context.sha, repository_id: 123 },
  };
  const api = f.api;
  let downloads = 0;
  f.api = async (method, route, body) => {
    if (method === 'GET' && route === '/repos/footprintjs/foottrace/actions/artifacts/400') return { data: envelope };
    if (method === 'GET' && route === '/repos/footprintjs/foottrace/actions/artifacts/400/zip') {
      downloads++;
      return {
        data: artifactZip([
          ['manifest.json', JSON.stringify(manifest)],
          ['package.tgz', bytes],
        ]),
      };
    }
    return api(method, route, body);
  };
  env.ARTIFACT_ID = '400';
  f.setRole('release');
  if (release) {
    const released = outputs(await executeWorkflowStage('release', { env, api: f.api, fetcher: f.fetcher }));
    assert.equal(released.fresh, 'true');
    env.GRANT_JSON = released.grant;
    assert.equal(f.releases.get('v' + p.version).prerelease, true);
    f.setRole('publish');
  }
  return {
    f,
    p,
    env,
    bytes,
    info,
    manifest,
    envelope,
    get downloads() {
      return downloads;
    },
  };
}
const publish = (x) => executeWorkflowStage('publish', { env: x.env, api: x.f.api, fetcher: x.f.fetcher });
test('actual native RC stages bind one checked archive and own marker, then verify next and unchanged latest', async () => {
  const x = await candidate(),
    r = await publish(x),
    result = outputs(r);
  assert.equal(result.submit, 'true');
  assert.equal(result.npmtag, 'next');
  assert.equal(r.writes.length, 1);
  assert.deepEqual(r.writes[0].bytes, x.bytes);
  assert.equal(r.writes[0].name, '/offline/temp/foottrace-publish-500-2/package.tgz');
  assert.equal(x.manifest.sourceSha, x.f.context.sha);
  assert.equal(x.manifest.tree, x.p.tree);
  assert.equal(x.manifest.version, x.p.version);
  // External registry success is supplied as data; no npm or provider submission runs in this test.
  x.f.registry.set(x.p.version, {
    bytes: x.bytes,
    metadata: {
      name: 'foottrace',
      version: x.p.version,
      dist: {
        integrity: x.info.integrity,
        shasum: x.info.shasum,
        tarball: 'https://registry.npmjs.org/foottrace/-/foottrace-' + x.p.version + '.tgz',
      },
    },
  });
  const fetcher = x.f.fetcher;
  x.f.fetcher = (url, options) =>
    url.endsWith('/next')
      ? Promise.resolve(Response.json({ name: 'foottrace', version: x.p.version }))
      : fetcher(url, options);
  const verified = outputs(await executeWorkflowStage('verify', { env: x.env, api: x.f.api, fetcher: x.f.fetcher }));
  const witness = JSON.parse(verified.verification);
  assert.equal(witness.state, 'verified');
  assert.equal(witness.next, x.p.version);
  assert.equal(witness.latest, '1.11.0');
  assert.equal(witness.sha256, x.info.sha256);
  assert.equal(witness.provenanceCryptographicallyVerified, false);
  assert.equal(x.f.implicitTags, 0);
  assert.equal(x.f.calls.filter((c) => c.method === 'POST').length, 3);
});
test('native RC publish refuses an old attempt grant despite all fresh source facts', async () => {
  const x = await candidate(),
    grant = JSON.parse(x.env.GRANT_JSON);
  grant.runAttempt = 1;
  x.env.GRANT_JSON = JSON.stringify(grant);
  const r = await publish(x);
  assert.equal(r.exit, 1);
  assert.equal(r.output, '');
  assert.equal(r.writes.length, 0);
});
test('native RC artifact source/tree substitution refuses before publication', async () => {
  const x = await candidate();
  x.manifest.tree = '9999999999999999999999999999999999999999';
  const r = await publish(x);
  assert.equal(r.exit, 1);
  assert.equal(r.output, '');
  assert.equal(r.writes.length, 0);
});
for (const position of [1, 3])
  test('native RC publish never erases an observed registry match at read ' + position, async () => {
    const x = await candidate(),
      fetcher = x.f.fetcher;
    let reads = 0;
    x.f.fetcher = (url, options) =>
      url.endsWith('/' + x.p.version) && ++reads === position
        ? Promise.resolve(
            Response.json({ name: 'foottrace', version: x.p.version, dist: { integrity: x.info.integrity } }),
          )
        : fetcher(url, options);
    const r = await publish(x),
      result = outputs(r);
    assert.equal(result.submit, 'false');
    assert.equal(r.writes.length, 0);
  });
test('native RC publish retains an observed integrity conflict even if a later read is absent', async () => {
  const x = await candidate(),
    fetcher = x.f.fetcher;
  let reads = 0;
  x.f.fetcher = (url, options) =>
    url.endsWith('/' + x.p.version) && ++reads === 1
      ? Promise.resolve(
          Response.json({ name: 'foottrace', version: x.p.version, dist: { integrity: 'sha512-conflicting' } }),
        )
      : fetcher(url, options);
  const r = await publish(x);
  assert.equal(r.exit, 1);
  assert.equal(r.output, '');
  assert.equal(r.writes.length, 0);
});

for (const stage of ['release', 'publish'])
  for (const [key, value] of [
    ['tag', 'latest'],
    ['dependencies', { unreviewed: '9.0.0' }],
    ['scripts', { postinstall: 'unreviewed' }],
    ['bin', { x: 'dist/x' }],
    ['dist', { tarball: 'unreviewed' }],
    ['publishConfig', { tag: 'latest' }],
  ])
    test('native ' + stage + ' refuses source-manifest drift before effects: ' + key, async () => {
      const x = await candidate({ release: stage === 'publish' }),
        api = x.f.api;
      const source = JSON.parse(x.f.trees.get(x.p.tree).get('package.json').bytes);
      const bytes = syntheticPackageArchive(x.p.version, { ...source, version: x.p.version, [key]: value });
      const hash = (algorithm, encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
      const manifest = {
        ...x.manifest,
        sha256: hash('sha256'),
        shasum: hash('sha1'),
        integrity: 'sha512-' + hash('sha512', 'base64'),
      };
      x.f.api = async (method, route, body) => {
        if (method === 'GET' && route === '/repos/footprintjs/foottrace/actions/artifacts/400/zip')
          return {
            data: artifactZip([
              ['manifest.json', JSON.stringify(manifest)],
              ['package.tgz', bytes],
            ]),
          };
        return api(method, route, body);
      };
      const before = x.f.calls.filter((c) => c.method !== 'GET').length;
      const result = await executeWorkflowStage(stage, { env: x.env, api: x.f.api, fetcher: x.f.fetcher });
      assert.equal(result.exit, 1);
      assert.equal(result.failure, 'manifest-source:' + key);
      assert.equal(result.output, '');
      assert.equal(result.writes.length, 0);
      assert.equal(x.f.calls.filter((c) => c.method !== 'GET').length, before);
    });
