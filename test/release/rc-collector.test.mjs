import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { authorityApiFixture } from './helpers.mjs';
const require = createRequire(import.meta.url),
  runtime = require('../../scripts/release-github.cjs');
test('RC native collector keeps the existing stable authority path', async () => {
  const f = authorityApiFixture();
  assert.deepEqual(await runtime.collectAuthority(f.api, f.context, f.settings), f.w.expected);
});
test('RC native collector exists without manufacturing a release PR identity', () => {
  assert.equal(typeof runtime.collectRcAuthority, 'function', 'missing native RC collector');
});

import { executeWorkflowStage, sha } from './helpers.mjs';
import { rcFixture as fixture } from './rc-fixture.mjs';
const plan = (f) => runtime.plan(f.api, f.context, f.options);
const collect = (f, p, role = 'authority') =>
  runtime.collectRcAuthority(f.api, f.context, p, role, f.options).then((value) => value.identity);
test('RC native collector binds actual native source, configured App, running job and push CodeQL reads', async () => {
  const f = fixture(),
    p = await plan(f);
  let id;
  await assert.doesNotReject(async () => {
    id = await collect(f, p);
  });
  assert.equal(id.mode, 'rc');
  assert.equal(id.sourceSha, f.context.sha);
  assert.equal(id.tree, p.tree);
  assert.equal(id.version, p.version);
  assert.equal(Object.hasOwn(id, 'headSha'), false);
  assert.equal(Object.hasOwn(id, 'pr'), false);
  assert.notEqual(id.mayPublish, true);
  assert(f.calls.some((c) => c.route === '/apps/release-app'));
  assert(f.calls.some((c) => c.route.endsWith('/actions/runs/500')));
  assert(f.calls.some((c) => c.route.includes('event=push&head_sha=')));
  assert(f.calls.every((c) => c.method === 'GET'));
});
test('RC native post-reservation collector retains its exact version and never grants submission', async () => {
  const f = fixture(),
    p = await plan(f);
  f.tags.set('v' + p.version, f.context.sha);
  f.setRole('publish');
  let id;
  await assert.doesNotReject(async () => {
    id = await collect(f, p, 'publish');
  });
  assert.equal(id.version, p.version);
  assert.notEqual(id.mayPublish, true);
});
for (const [name, change, code] of [
  ['substituted tree', (f, p) => (p.tree = sha('9')), 'rc-plan'],
  ['substituted stable source version', (f, p) => (p.fromVersion = '1.10.0'), 'rc-plan'],
  ['substituted package', (f, p) => (p.package = 'other'), 'rc-plan'],
  [
    'open release proposal',
    (f) =>
      f.pulls.push({ ...f.originalPR, id: 999, number: 999, state: 'open', merged_at: null, merge_commit_sha: null }),
    'rc-proposal',
  ],
  ['wrong configured App client', (f) => (f.app.metadata.client_id = 'other'), 'rc-app'],
  ['stale current run', (f) => (f.run.run_attempt = 1), 'current-run-attempt'],
  [
    'completed run',
    (f) => {
      f.run.status = 'completed';
      f.run.conclusion = 'success';
    },
    'current-run-status',
  ],
  ['wrong current workflow', (f) => (f.run.path = '.github/workflows/other.yml'), 'current-run-workflow'],
  ['wrong job source', (f) => (f.jobs[0].head_sha = sha('9')), 'producer-attempt'],
  [
    'completed current job',
    (f) => {
      f.jobs[0].status = 'completed';
      f.jobs[0].conclusion = 'success';
    },
    'rc-producer',
  ],
  ['queued current job', (f) => (f.jobs[0].status = 'queued'), 'rc-producer'],
  [
    'unfinished push CodeQL',
    (f) => {
      f.security.status = 'in_progress';
      f.security.conclusion = null;
    },
    'security-run',
  ],
  ['wrong CodeQL job attempt', (f) => (f.securityJobs[0].run_attempt = 2), 'security-job'],
])
  test('RC native collector refuses ' + name, async () => {
    const f = fixture(),
      p = await plan(f);
    change(f, p);
    await assert.rejects(() => collect(f, p), { code });
    assert(f.calls.every((c) => c.method === 'GET'));
  });
test('RC collector does not turn an unavailable private App read into absence', async () => {
  const f = fixture(),
    p = await plan(f),
    api = f.api;
  let attempts = 0;
  f.api = async (...a) => {
    if (a[1] === '/apps/release-app') {
      attempts++;
      throw Object.assign(new Error('synthetic unavailable'), { status: 403 });
    }
    return api(...a);
  };
  await assert.rejects(() => collect(f, p));
  assert.equal(attempts, 1);
});
test('RC collector rechecks mutable main after App, producer and CodeQL', async () => {
  const f = fixture(),
    p = await plan(f),
    api = f.api;
  let reads = 0;
  f.api = async (...a) => {
    if (a[1].endsWith('/git/ref/heads/main') && ++reads > 2) return { data: { object: { sha: sha('9') } } };
    return api(...a);
  };
  await assert.rejects(() => collect(f, p), { code: 'main-moved' });
});
function env(f, p) {
  return {
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
}
test('RC authority entry uses the existing private-App JWT transport and emits a source identity only', async () => {
  const f = fixture(),
    p = await plan(f),
    r = await executeWorkflowStage('authority', { env: env(f, p), api: f.api, fetcher: f.fetcher });
  assert.equal(r.failure, null);
  assert.equal(r.exit, 0);
  assert.equal(r.writes.length, 0);
  assert.match(r.output, /authorized=true\n/);
  const id = JSON.parse(/^identity=(.+)$/m.exec(r.output)[1]);
  assert.equal(id.sourceSha, f.context.sha);
  assert.equal(id.version, p.version);
  assert.equal(Object.hasOwn(id, 'headSha'), false);
});
test('RC authority entry refuses a wrong private-App client without an output grant', async () => {
  const f = fixture(),
    p = await plan(f);
  f.app.metadata.client_id = 'other';
  const r = await executeWorkflowStage('authority', { env: env(f, p), api: f.api, fetcher: f.fetcher });
  assert.equal(r.exit, 1);
  assert.equal(r.output, '');
  assert.equal(r.writes.length, 0);
});
test('RC verdict always requires both full runtime gates, without looking for a fabricated PR', async () => {
  const f = fixture(),
    p = await plan(f),
    id = await collect(f, p);
  const r = await runtime.runStage('verdict', {
    context: f.context,
    env: { PLAN_JSON: JSON.stringify(p), IDENTITY_JSON: JSON.stringify(id) },
    io: {},
    api: () => assert.fail('RC verdict must not look for PR CI'),
  });
  assert.deepEqual(r, { tested: 'false' });
});

test('RC source collection cannot impersonate a later queued publish job', async () => {
  const f = fixture(),
    p = await plan(f);
  f.tags.set('v' + p.version, f.context.sha);
  await assert.rejects(() => collect(f, p, 'publish'), { code: 'rc-producer' });
});
test('RC source collection may observe a registry match but still never issues a publish grant', async () => {
  const f = fixture(),
    p = await plan(f);
  f.tags.set('v' + p.version, f.context.sha);
  f.setRole('publish');
  f.registry.set(p.version, {
    metadata: { name: 'foottrace', version: p.version, dist: { integrity: 'not-yet-bound-to-archive' } },
  });
  let id;
  await assert.doesNotReject(async () => {
    id = await collect(f, p, 'publish');
  });
  assert.equal(id.version, p.version);
  assert.notEqual(id.mayPublish, true);
});

import { generateKeyPairSync, verify } from 'node:crypto';
test('RC native collector authenticates App metadata privately through the actual HTTP adapter', async () => {
  const f = fixture(),
    p = await plan(f),
    keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let privateReads = 0;
  const fetcher = async (url, options) => {
    const u = new URL(url);
    assert.equal(u.origin, 'https://api.github.com');
    assert.equal(options.method, 'GET');
    let route = u.pathname + u.search;
    if (route === '/app') {
      privateReads++;
      assert.equal(options.redirect, 'error');
      const token = options.headers.authorization.slice('Bearer '.length),
        parts = token.split('.');
      assert.equal(parts.length, 3);
      assert.equal(JSON.parse(Buffer.from(parts[1], 'base64url')).iss, 'public-client-id');
      assert(
        verify(
          'RSA-SHA256',
          Buffer.from(parts[0] + '.' + parts[1]),
          keys.publicKey,
          Buffer.from(parts[2], 'base64url'),
        ),
      );
      route = '/apps/release-app';
    } else {
      assert(!route.startsWith('/apps/'), 'private App identity must not use the public slug route');
      assert.equal(options.headers.authorization, 'Bearer synthetic-workflow');
    }
    let value;
    try {
      value = await f.api('GET', route);
    } catch (error) {
      if (error.status) return new Response('', { status: error.status });
      throw error;
    }
    return new Response(Buffer.isBuffer(value.data) ? value.data : JSON.stringify(value.data), {
      headers: { 'content-type': Buffer.isBuffer(value.data) ? 'application/octet-stream' : 'application/json' },
    });
  };
  const api = runtime.makeApi('synthetic-workflow', fetcher, {
    slug: 'release-app',
    clientId: 'public-client-id',
    privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });
  let id;
  await assert.doesNotReject(async () => {
    id = (await runtime.collectRcAuthority(api, f.context, p, 'authority', f.options)).identity;
  });
  assert.equal(privateReads, 1);
  assert.equal(id.sourceSha, f.context.sha);
  assert.notEqual(id.mayPublish, true);
});
