import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { call, sha, authorityApiFixture, executeWorkflowStage } from './helpers.mjs';

// Tiny synthetic USTAR fixture builder. Never extracts or executes its members.
function tar(members) {
  const buffers = [];
  for (const member of members) {
    const body = Buffer.from(member.body ?? '');
    const h = Buffer.alloc(512);
    const field = (offset, length, value) => h.write(value, offset, length, 'ascii');
    field(0, 100, member.name);
    field(100, 8, '0000644\0');
    field(108, 8, '0000000\0');
    field(116, 8, '0000000\0');
    field(124, 12, body.length.toString(8).padStart(11, '0') + '\0');
    field(136, 12, '00000000000\0');
    h.fill(32, 148, 156);
    field(156, 1, member.type ?? '0');
    field(157, 100, member.link ?? '');
    field(257, 6, 'ustar\0');
    field(263, 2, '00');
    const sum = h.reduce((a, b) => a + b, 0);
    field(148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
    buffers.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...buffers, Buffer.alloc(1024)]));
}
const members = () => [
  { name: 'package/package.json', body: JSON.stringify({ name: 'foottrace', version: '1.9.0', files: ['dist/'] }) },
  { name: 'package/dist/index.js', body: 'exports.version = "fixture";\n' },
];
const expected = () => ({
  package: 'foottrace',
  version: '1.9.0',
  maxArchiveBytes: 100000,
  maxExpandedBytes: 100000,
  maxFiles: 100,
});
test('archive: checked bytes retain their original sha256 and identity', () => {
  const bytes = tar(members());
  const result = call('release-archive', 'inspectArchive', bytes, expected());
  assert.equal(result.package, 'foottrace');
  assert.equal(result.version, '1.9.0');
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
});
for (const [name, change] of [
  ['parent traversal', (m) => m.push({ name: 'package/../escape', body: 'no' })],
  ['absolute path', (m) => m.push({ name: '/escape', body: 'no' })],
  ['duplicate package identity', (m) => m.push(m[0])],
  ['symbolic link', (m) => m.push({ name: 'package/link', type: '2', link: '../../outside' })],
  ['hard link', (m) => m.push({ name: 'package/link', type: '1', link: 'package/package.json' })],
  ['device file', (m) => m.push({ name: 'package/device', type: '3' })],
  [
    'wrong package name',
    (m) => {
      m[0].body = JSON.stringify({ name: 'other', version: '1.9.0' });
    },
  ],
  [
    'wrong version',
    (m) => {
      m[0].body = JSON.stringify({ name: 'foottrace', version: '9.0.0' });
    },
  ],
])
  test(`archive refuses: ${name}`, () => {
    call('release-archive', 'inspectArchive', tar(members()), expected());
    const fixture = members();
    change(fixture);
    assert.throws(
      () => call('release-archive', 'inspectArchive', tar(fixture), expected()),
      (e) => e.code === 'invalid-archive',
    );
  });
const binding = () => ({
  expected: {
    repositoryId: 123,
    runId: 200,
    runAttempt: 2,
    jobId: 300,
    jobName: 'build',
    artifactId: 400,
    artifactName: 'foottrace-123-200-2-build',
    sourceSha: sha('1'),
    tree: sha('3'),
    package: 'foottrace',
    version: '1.9.0',
  },
  artifact: {
    id: 400,
    name: 'foottrace-123-200-2-build',
    expired: false,
    workflow_run: { id: 200, head_sha: sha('1'), repository_id: 123 },
  },
  producer: {
    id: 300,
    name: 'build',
    run_id: 200,
    run_attempt: 2,
    status: 'completed',
    conclusion: 'success',
    uploadArtifactId: 400,
  },
  manifest: {
    repositoryId: 123,
    runId: 200,
    runAttempt: 2,
    jobId: 300,
    sourceSha: sha('1'),
    tree: sha('3'),
    package: 'foottrace',
    version: '1.9.0',
  },
});
test('artifact: the fixed producer output binds a current-run artifact', () =>
  assert.equal(call('release-control', 'validateArtifactBinding', binding()).valid, true));
for (const [name, change] of [
  [
    'another run',
    (x) => {
      x.artifact.workflow_run.id = 201;
    },
  ],
  [
    'another attempt',
    (x) => {
      x.producer.run_attempt = 1;
    },
  ],
  [
    'selective rerun carries an old producer and manifest',
    (x) => {
      x.expected.runAttempt = 3;
    },
  ],
  [
    'missing actual producer attempt',
    (x) => {
      delete x.producer.run_attempt;
    },
  ],
  [
    'another producer',
    (x) => {
      x.producer.id = 301;
    },
  ],
  [
    'substituted artifact ID',
    (x) => {
      x.artifact.id = 401;
    },
  ],
  [
    'expired artifact',
    (x) => {
      x.artifact.expired = true;
    },
  ],
  [
    'substituted source',
    (x) => {
      x.manifest.sourceSha = sha('4');
    },
  ],
  [
    'substituted tree with matching adjacent checksum',
    (x) => {
      x.manifest.tree = sha('4');
      x.manifest.sha256 = 'a'.repeat(64);
    },
  ],
])
  test(`artifact refuses: ${name}`, () => {
    const world = binding();
    change(world);
    assert.equal(call('release-control', 'validateArtifactBinding', world).valid, false);
  });
function zip(entries) {
  const locals = [],
    central = [];
  let offset = 0;
  const crc = (bytes) => {
    let n = 0xffffffff;
    for (const b of bytes) {
      n ^= b;
      for (let i = 0; i < 8; i++) n = n & 1 ? (n >>> 1) ^ 0xedb88320 : n >>> 1;
    }
    return (n ^ 0xffffffff) >>> 0;
  };
  for (const [name, value] of entries) {
    const data = Buffer.from(value),
      n = Buffer.from(name),
      h = Buffer.alloc(30),
      c = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt32LE(crc(data), 14);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(n.length, 26);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt32LE(crc(data), 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    locals.push(h, n, data);
    central.push(c, n);
    offset += h.length + n.length + data.length;
  }
  const end = Buffer.alloc(22),
    dir = Buffer.concat(central);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
test('artifact ZIP is read without extraction and admits only the fixed members', () => {
  const result = call(
    'release-archive',
    'readArtifactZip',
    zip([
      ['manifest.json', '{}'],
      ['package.tgz', 'archive'],
    ]),
    ['manifest.json', 'package.tgz'],
  );
  assert.equal(result['package.tgz'].toString(), 'archive');
});
for (const [name, entries] of [
  [
    'traversal',
    [
      ['../manifest.json', '{}'],
      ['package.tgz', 'x'],
    ],
  ],
  [
    'duplicate',
    [
      ['manifest.json', '{}'],
      ['manifest.json', '{}'],
    ],
  ],
  [
    'extra executable',
    [
      ['manifest.json', '{}'],
      ['package.tgz', 'x'],
      ['run.cjs', 'bad'],
    ],
  ],
])
  test(`artifact ZIP refuses ${name}`, () => {
    call(
      'release-archive',
      'readArtifactZip',
      zip([
        ['manifest.json', '{}'],
        ['package.tgz', 'x'],
      ]),
      ['manifest.json', 'package.tgz'],
    );
    assert.throws(
      () => call('release-archive', 'readArtifactZip', zip(entries), ['manifest.json', 'package.tgz']),
      (e) => e.code === 'invalid-archive',
    );
  });
function paxPath(path) {
  let line = ` path=${path}\n`,
    n = line.length + 1;
  while (String(n).length + line.length !== n) n = String(n).length + line.length;
  return String(n) + line;
}
test('archive: a bounded PAX long path is retained without extracting it', () => {
  const path = 'package/dist/' + 'long/'.repeat(30) + 'index.js';
  const m = members();
  m.push({ name: 'PaxHeader/long', type: 'x', body: paxPath(path) }, { name: 'truncated', body: 'safe' });
  const r = call('release-archive', 'inspectArchive', tar(m), expected());
  assert(r.files.some((f) => f.path === path));
});
test('archive: PAX cannot disguise a traversal or add extraction directives', () => {
  for (const body of [paxPath('package/../escape'), paxPath('package/dist/good') + paxPath('package/dist/again')]) {
    const m = members();
    m.push({ name: 'PaxHeader/x', type: 'x', body }, { name: 'truncated', body: 'bad' });
    assert.throws(
      () => call('release-archive', 'inspectArchive', tar(m), expected()),
      (e) => e.code === 'invalid-archive',
    );
  }
});
test('actual artifact reader checks producer attempt before consuming the fixed ZIP', async () => {
  const b = binding(),
    context = {
      repository: { id: 123, full_name: 'footprintjs/foottrace' },
      sha: sha('1'),
      runId: 200,
      runAttempt: 2,
      ref: 'refs/heads/main',
      eventName: 'push',
    },
    pinned = { tree: sha('3'), package: 'foottrace', version: '1.9.0' };
  let downloads = 0;
  const api = async (method, route) => {
    assert.equal(method, 'GET');
    if (route.endsWith('/actions/runs/200'))
      return {
        data: {
          id: 200,
          run_attempt: 2,
          head_sha: context.sha,
          repository: context.repository,
          head_repository: context.repository,
          path: '.github/workflows/publish.yml',
          head_branch: 'main',
          event: 'push',
          status: 'in_progress',
          conclusion: null,
        },
      };
    if (route.endsWith('/artifacts/400')) return { data: b.artifact };
    if (route.includes('/jobs?')) return { data: { total_count: 1, jobs: [{ ...b.producer, head_sha: sha('1') }] } };
    if (route.endsWith('/artifacts/400/zip')) {
      downloads++;
      return {
        data: zip([
          ['manifest.json', JSON.stringify(b.manifest)],
          ['package.tgz', tar(members())],
        ]),
      };
    }
    assert.fail(route);
  };
  const r = await call('release-github', 'readArtifact', api, context, pinned, 400, 'build');
  assert.deepEqual(r.manifest, b.manifest);
  assert.equal(downloads, 1);
  await assert.rejects(
    () => call('release-github', 'readArtifact', api, { ...context, runAttempt: 3 }, pinned, 400, 'build'),
    /current-run|producer-attempt/,
  );
  assert.equal(downloads, 1);
});
test('actual release/reservation/grant/registry path preserves checked bytes and never repeats a reservation', async (t) => {
  const auth = authorityApiFixture();
  const bytes = tar(members()),
    archive = call('release-archive', 'inspectArchive', bytes, expected());
  const context = {
    repository: { id: 123, full_name: 'footprintjs/foottrace' },
    sha: sha('1'),
    runId: 200,
    runAttempt: 2,
    ref: 'refs/heads/main',
    eventName: 'push',
  };
  const identity = auth.w.expected,
    pinned = { version: '1.9.0' };
  let changelog =
    '# Changelog\n\n## 1.9.0 — 2026-10-30\n\n### Added\n\n- Tested feature.\n\n## 1.8.0 — 2026-10-26\n\nOld notes.\n';
  const calls = [];
  let tag = null,
    release = null,
    journal = null;
  const api = async (method, route, body) => {
    calls.push({ method, route, body });
    const missing = () => {
      throw Object.assign(new Error('not-found'), { status: 404 });
    };
    if (method === 'GET') {
      if (route.endsWith('/actions/runs/200'))
        return {
          data: {
            id: 200,
            run_attempt: 2,
            head_sha: context.sha,
            repository: context.repository,
            head_repository: context.repository,
            path: '.github/workflows/publish.yml',
            head_branch: 'main',
            event: 'push',
            status: 'in_progress',
            conclusion: null,
          },
        };
      if (route.endsWith('/actions/artifacts/400')) return { data: binding().artifact };
      if (route.includes('/actions/runs/200/attempts/2/jobs?'))
        return { data: { total_count: 1, jobs: [{ ...binding().producer, head_sha: context.sha }] } };
      if (route.endsWith('/actions/artifacts/400/zip'))
        return {
          data: zip([
            [
              'manifest.json',
              JSON.stringify({
                ...binding().manifest,
                sha256: archive.sha256,
                integrity: archive.integrity,
                shasum: archive.shasum,
              }),
            ],
            ['package.tgz', bytes],
          ]),
        };
      if (route.endsWith('/git/ref/heads/main')) return { data: { object: { sha: context.sha } } };
      if (route.endsWith('/git/ref/tags/v1.9.0')) return tag ? { data: tag } : missing();
      if (route.endsWith('/releases/tags/v1.9.0')) return release ? { data: release } : missing();
      if (route.includes('/contents/CHANGELOG.md?')) {
        const content = Buffer.from(changelog);
        return {
          data: { type: 'file', encoding: 'base64', size: content.length, content: content.toString('base64') },
        };
      }
      if (route.includes('/releases/1/assets?'))
        return {
          data: journal
            ? [{ id: 800, name: 'publish-attempt-1.9.0.json', state: 'uploaded', size: journal.length }]
            : [],
        };
      if (route.endsWith('/releases/assets/800'))
        return body?.accept
          ? { data: journal }
          : { data: { id: 800, name: 'publish-attempt-1.9.0.json', state: 'uploaded', size: journal.length } };
    }
    if (method === 'POST') {
      if (route.endsWith('/git/refs')) {
        assert.equal(body.ref, 'refs/tags/v1.9.0');
        assert.equal(body.sha, context.sha);
        tag = { object: { type: 'commit', sha: body.sha } };
        return { data: tag };
      }
      if (route.endsWith('/releases')) {
        release = {
          id: 1,
          ...body,
          upload_url: 'https://uploads.github.com/repos/footprintjs/foottrace/releases/1/assets{?name,label}',
        };
        return { data: release };
      }
      if (route.startsWith('https://uploads.github.com/')) {
        assert.equal(journal, null);
        journal = body.raw;
        return { data: { id: 800, state: 'uploaded', size: journal.length } };
      }
    }
    return auth.api(method, route, body);
  };
  const grant = await call('release-github', 'releaseState', api, context, identity, archive, null);
  assert.equal(grant.fresh, true);
  assert.equal(await call('release-github', 'publishGrant', api, context, identity, archive, grant), true);
  const again = await call('release-github', 'releaseState', api, context, identity, archive, null);
  assert.equal(again.fresh, false);
  assert.equal(calls.filter((c) => c.route.startsWith('https://uploads.github.com/')).length, 1);
  assert(calls.every((c) => !['DELETE', 'PATCH', 'PUT'].includes(c.method)));
  const fetcher = async (url) => {
    if (url.endsWith('.tgz')) return new Response(bytes);
    if (url.endsWith('/latest')) return new Response(JSON.stringify({ name: 'foottrace', version: '1.9.0' }));
    return new Response(
      JSON.stringify({
        name: 'foottrace',
        version: '1.9.0',
        dist: {
          integrity: archive.integrity,
          shasum: archive.shasum,
          tarball: 'https://registry.npmjs.org/foottrace/-/foottrace-1.9.0.tgz',
        },
      }),
    );
  };
  const start = calls.length;
  const verified = await call('release-github', 'verifyPublished', api, context, pinned, fetcher);
  assert.equal(verified.state, 'verified');
  assert.equal(verified.sha256, archive.sha256);
  assert.equal(verified.provenanceCryptographicallyVerified, false);
  assert(calls.slice(start).every((c) => c.method === 'GET'));
  const pending = await call(
    'release-github',
    'verifyPublished',
    api,
    context,
    pinned,
    async () => new Response('not-yet', { status: 404 }),
  );
  assert.equal(pending.state, 'pending-registry');
  await assert.rejects(
    () => call('release-github', 'publishGrant', api, { ...context, runAttempt: 3 }, identity, archive, grant),
    /journal-grant/,
  );
  const writes = [];
  const output = await call('release-github', 'runStage', 'publish', {
    api,
    context: { ...context, ref: 'refs/heads/main', eventName: 'push' },
    env: {
      PLAN_JSON: JSON.stringify({
        ...pinned,
        package: 'foottrace',
        tree: sha('3'),
        sha: context.sha,
        repository: context.repository,
      }),
      IDENTITY_JSON: JSON.stringify(identity),
      APP_SLUG: 'release-app',
      APP_CLIENT_ID: 'public-client-id',
      ARTIFACT_ID: '400',
      GRANT_JSON: JSON.stringify(grant),
    },
    io: { publishFile: () => '/fixed/package.tgz', write: (name, value) => writes.push({ name, value }) },
    fetcher: async () => new Response('not-yet', { status: 404 }),
  });
  assert.equal(output.submit, 'true');
  assert.equal(output.file, '/fixed/package.tgz');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].value, bytes);

  const workflow = await executeWorkflowStage('publish', {
    api,
    env: {
      REPO_ID: '123',
      REPO_NAME: 'footprintjs/foottrace',
      SOURCE_SHA: context.sha,
      SOURCE_REF: 'refs/heads/main',
      EVENT_NAME: 'push',
      RUN_ID: '200',
      RUN_ATTEMPT: '2',
      PLAN_JSON: JSON.stringify({
        ...pinned,
        package: 'foottrace',
        tree: sha('3'),
        sha: context.sha,
        repository: context.repository,
      }),
      IDENTITY_JSON: JSON.stringify(identity),
      APP_SLUG: 'release-app',
      APP_CLIENT_ID: 'public-client-id',
      ARTIFACT_ID: '400',
      GRANT_JSON: JSON.stringify(grant),
    },
    fetcher: async () => new Response('not-yet', { status: 404 }),
  });
  assert.equal(workflow.exit, 0, workflow.failure);
  assert(workflow.output.includes('submit=true\n'));
  assert.equal(workflow.writes.length, 1);
  assert.deepEqual(workflow.writes[0].bytes, bytes);
  const workflowVerified = await executeWorkflowStage('verify', {
    api,
    env: {
      REPO_ID: '123',
      REPO_NAME: 'footprintjs/foottrace',
      SOURCE_SHA: context.sha,
      SOURCE_REF: 'refs/heads/main',
      EVENT_NAME: 'push',
      RUN_ID: '200',
      RUN_ATTEMPT: '2',
      PLAN_JSON: JSON.stringify({
        ...pinned,
        package: 'foottrace',
        tree: sha('3'),
        sha: context.sha,
        repository: context.repository,
      }),
    },
    fetcher,
  });
  assert.equal(workflowVerified.exit, 0, workflowVerified.failure);
  assert.equal(JSON.parse(workflowVerified.output.slice('verification='.length).trim()).state, 'verified');
  const originalNotes = release.body,
    originalChangelog = changelog;
  for (const mode of ['wrong', 'missing', 'ambiguous'])
    for (const path of ['writer', 'standalone', 'workflow'])
      await t.test(`${path} verification refuses ${mode} pinned notes`, async () => {
        release.body = originalNotes;
        changelog = originalChangelog;
        if (mode === 'wrong') release.body = 'WRONG RELEASE NOTES';
        if (mode === 'missing') changelog = changelog.replace('## 1.9.0 — 2026-10-30', '## 1.7.0 — 2026-10-30');
        if (mode === 'ambiguous') changelog += '\n## 1.9.0 — 2026-10-30\n\nOther notes.\n';
        if (path === 'writer')
          await assert.rejects(
            () => call('release-github', 'releaseState', api, context, identity, archive, null),
            /release-notes|release-conflict/,
          );
        else if (path === 'standalone')
          await assert.rejects(
            () => call('release-github', 'verifyPublished', api, context, pinned, fetcher),
            /release-notes|release-conflict/,
          );
        else {
          const held = await executeWorkflowStage('verify', {
            api,
            env: {
              REPO_ID: '123',
              REPO_NAME: 'footprintjs/foottrace',
              SOURCE_SHA: context.sha,
              SOURCE_REF: 'refs/heads/main',
              EVENT_NAME: 'push',
              RUN_ID: '200',
              RUN_ATTEMPT: '2',
              PLAN_JSON: JSON.stringify({
                ...pinned,
                package: 'foottrace',
                tree: sha('3'),
                sha: context.sha,
                repository: context.repository,
              }),
            },
            fetcher,
          });
          assert.equal(held.exit, 1);
          assert.equal(held.output, '');
          assert.match(held.failure, /release-notes|release-conflict/);
        }
      });
  release.body = originalNotes;
  changelog = originalChangelog;
});
