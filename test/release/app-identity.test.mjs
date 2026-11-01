import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync, verify } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorityApiFixture, sha } from './helpers.mjs';
const require = createRequire(import.meta.url);
const runner = require('../../scripts/release-runner.cjs');
const runtime = require('../../scripts/release-github.cjs');
const WORKFLOW_TOKEN = 'offline-repository-token';
// Synthetic and unregistered. No real App credential is read, copied or stored.
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const syntheticPrivateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });

function environment(f) {
  return {
    REPO_ID: '123', REPO_NAME: 'footprintjs/foottrace',
    SOURCE_SHA: f.context.sha, SOURCE_REF: 'refs/heads/main', EVENT_NAME: 'push',
    RUN_ID: '500', RUN_ATTEMPT: '1', APP_SLUG: f.settings.slug,
    APP_CLIENT_ID: f.settings.clientId, APP_PRIVATE_KEY: syntheticPrivateKey,
    GH_TOKEN: WORKFLOW_TOKEN, GITHUB_OUTPUT: '/offline/output',
    PLAN_JSON: JSON.stringify({ repository: f.context.repository, sha: f.context.sha,
      tree: sha('3'), version: '1.9.0', package: 'foottrace' }),
    IDENTITY_JSON: JSON.stringify(f.w.expected),
  };
}

function privateAppWire(f, { appStatus, appText, appData } = {}) {
  const seen = [];
  const fetcher = async (url, options) => {
    const u = new URL(url), route = u.pathname + u.search;
    assert.equal(u.origin, 'https://api.github.com');
    assert.equal(options.method, 'GET');
    if (route.startsWith('/apps/')) {
      seen.push({ route, kind: 'forbidden-legacy-app-route' });
      return new Response('private-app-is-unavailable-to-workflow-token', { status: 403 });
    }
    if (route === '/app') {
      const authorization = options.headers.authorization;
      assert(typeof authorization === 'string', 'App authentication is present');
      assert(authorization !== `Bearer ${WORKFLOW_TOKEN}`, 'Repository token never authenticates App metadata');
      const parts = authorization.slice('Bearer '.length).split('.');
      assert.equal(parts.length, 3);
      const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
      assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
      assert.deepEqual(Object.keys(claims).sort(), ['exp', 'iat', 'iss']);
      assert.equal(claims.iss, f.settings.clientId);
      if (!verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), keys.publicKey,
        Buffer.from(parts[2], 'base64url'))) return new Response('signature-refused', { status: 401 });
      const now = Math.floor(Date.now() / 1000);
      assert(Number.isSafeInteger(claims.iat) && claims.iat <= now - 55 && claims.iat >= now - 65);
      assert(Number.isSafeInteger(claims.exp) && claims.exp >= now + 55 && claims.exp <= now + 65);
      assert(claims.exp - claims.iat <= 120, 'App JWT has a short fixed lifetime');
      assert.equal(options.redirect, 'error', 'No redirect may carry App authentication elsewhere');
      assert.equal(options.body, undefined);
      seen.push({ route, kind: 'verified-app-jwt' });
      return new Response(appText ?? JSON.stringify(appData ?? f.w.app.metadata), {
        status: appStatus ?? 200, headers: { 'content-type': 'application/json' },
      });
    }
    assert(options.headers.authorization === `Bearer ${WORKFLOW_TOKEN}`, 'Other API requests retain repository token');
    seen.push({ route, kind: 'repository-token' });
    return new Response(JSON.stringify((await f.api(options.method, route)).data), {
      headers: { 'content-type': 'application/json' },
    });
  };
  return { seen, fetcher };
}

for (const [label, options, code] of [
  ['forbidden', { appStatus: 403 }, 'authority-app:github-http-forbidden'],
  ['not found', { appStatus: 404 }, 'authority-app:github-http-not-found'],
  ['invalid JSON', { appText: '{broken' }, 'authority-app:github-json'],
  ['wrong client', { appData: { slug: 'release-app', client_id: 'another-client' } }, 'authority-app'],
  ['wrong slug', { appData: { slug: 'another-app', client_id: 'public-client-id' } }, 'authority-app'],
]) {
  test(`private App identity refuses ${label} without authority output`, async () => {
    const f = authorityApiFixture(), wire = privateAppWire(f, options);
    let outputs = 0;
    await assert.rejects(() => runner.runCli(['authority'], {
      env: environment(f), fetcher: wire.fetcher,
      io: { head: () => f.context.sha, appendOutput: () => outputs++ },
    }), (error) => error.code === code);
    assert.equal(outputs, 0);
    assert.equal(wire.seen.filter((x) => x.kind === 'verified-app-jwt').length, 1);
  });
}

for (const [name, privateKey] of [
  ['missing', undefined], ['empty', ''], ['malformed', 'unregistered-malformed-key-canary'],
  ['non-RSA', generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' })],
]) {
  test(`private App identity refuses ${name} signing key before App request`, async () => {
    const f = authorityApiFixture(), wire = privateAppWire(f);
    await assert.rejects(() => runner.runCli(['authority'], {
      env: { ...environment(f), APP_PRIVATE_KEY: privateKey }, fetcher: wire.fetcher,
      io: { head: () => f.context.sha, appendOutput: () => assert.fail('No authority output') },
    }), (error) => error.code === 'authority-app:app-auth');
    assert.equal(wire.seen.filter((x) => x.route === '/app').length, 0);
  });
}

test('private App identity: a different valid RSA key is refused by the independent server', async () => {
  const f = authorityApiFixture(), wire = privateAppWire(f);
  const another = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  await assert.rejects(() => runner.runCli(['authority'], {
    env: { ...environment(f), APP_PRIVATE_KEY: another }, fetcher: wire.fetcher,
    io: { head: () => f.context.sha, appendOutput: () => assert.fail('No authority output') },
  }), (error) => error.code === 'authority-app:github-http-unauthorized');
});

for (const [method, route, body] of [
  ['POST', '/apps/release-app'], ['HEAD', '/apps/release-app'],
  ['GET', '/apps/release-app?extra=1'], ['GET', '/apps/release-app/installation'],
  ['GET', '/apps/another-app'], ['GET', '/apps/release-app', {}],
  ['GET', '/apps/release%2Dapp'], ['GET', '/app'],
]) {
  test(`private App identity confines its credential: ${method} ${route} body=${body !== undefined}`, async () => {
    let calls = 0;
    const f = authorityApiFixture();
    const api = runtime.makeApi(WORKFLOW_TOKEN, async () => { calls++; return new Response('{}'); }, {
      slug: f.settings.slug, clientId: f.settings.clientId, privateKey: syntheticPrivateKey,
    });
    await assert.rejects(() => api(method, route, body),
      (error) => ['app-auth', 'api-route'].includes(error.code));
    assert.equal(calls, 0);
  });
}

for (const [method, route, body] of [
  ['GET', '/repos/footprintjs/foottrace'],
  ['GET', '/users/release-app%5Bbot%5D'],
  ['POST', '/repos/footprintjs/foottrace/git/refs', { ref: 'offline', sha: sha('1') }],
  ['POST', 'https://uploads.github.com/repos/footprintjs/foottrace/releases/123/assets?name=offline.json',
    { raw: Buffer.from('{}'), contentType: 'application/json' }],
]) {
  test(`private App credential never reaches sibling ${method} ${route}`, async () => {
    let calls = 0;
    const api = runtime.makeApi(WORKFLOW_TOKEN, async (_url, options) => {
      calls++;
      assert(options.headers.authorization === `Bearer ${WORKFLOW_TOKEN}`, 'Repository token stays in its domain');
      assert.equal(options.redirect, undefined);
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }, { slug: 'release-app', clientId: 'public-client-id', privateKey: syntheticPrivateKey });
    await api(method, route, body);
    assert.equal(calls, 1);
  });
}

test('checkout refuses before key access; current-main refuses before any App request', async () => {
  const f = authorityApiFixture();
  let keyReads = 0, requests = 0;
  const env = environment(f);
  Object.defineProperty(env, 'APP_PRIVATE_KEY', { enumerable: true, get() { keyReads++; return syntheticPrivateKey; } });
  await assert.rejects(() => runner.runCli(['authority'], {
    env, fetcher: async () => { requests++; assert.fail('No API before checkout'); },
    io: { head: () => sha('9') },
  }), (error) => error.code === 'checkout-sha');
  assert.equal(keyReads, 0);
  assert.equal(requests, 0);
  const wire = privateAppWire(f);
  f.routes.set('/repos/footprintjs/foottrace/git/ref/heads/main', { object: { sha: sha('9') } });
  await assert.rejects(() => runner.runCli(['authority'], {
    env: environment(f), fetcher: wire.fetcher,
    io: { head: () => f.context.sha, appendOutput: () => assert.fail('No authority output') },
  }), (error) => error.code === 'main-moved');
  assert.equal(wire.seen.filter((x) => x.route === '/app').length, 0);
});

test('private identity workflow keeps existing permissions and limits key to three control steps', () => {
  const text = readFileSync(new URL('../../.github/workflows/publish.yml', import.meta.url), 'utf8');
  const jobs = [...text.matchAll(/^  ([a-z][a-z-]*):\n/gm)].map((m, i, all) => ({
    name: m[1], block: text.slice(m.index, all[i + 1]?.index ?? text.length),
  }));
  assert.equal((text.match(/APP_PRIVATE_KEY:/g) ?? []).length, 3);
  assert.equal((text.match(/secrets\.RELEASE_APP_PRIVATE_KEY/g) ?? []).length, 4);
  for (const { name, block } of jobs) {
    if (['authority', 'release', 'publish'].includes(name)) {
      assert.match(block, /- id: control\n        env:\n(?:          [^\n]*\n)*          APP_PRIVATE_KEY: \$\{\{ secrets\.RELEASE_APP_PRIVATE_KEY \}\}\n        run: node scripts\/release-runner\.cjs /);
      assert.equal((block.match(/APP_PRIVATE_KEY:/g) ?? []).length, 1);
      const checkout = block.slice(block.indexOf('uses: actions/checkout@'), block.indexOf('uses: actions/setup-node@'));
      assert.doesNotMatch(checkout, /PRIVATE_KEY/);
    } else {
      assert.doesNotMatch(block, /APP_PRIVATE_KEY:/);
    }
  }
  const permissionBlocks = [...text.matchAll(/^permissions:\n(?:  [^\n]*\n)+|^    permissions:\n(?:      [^\n]*\n)+/gm)].map((m) => m[0]);
  assert.deepEqual(permissionBlocks, [
    'permissions:\n  contents: read\n  actions: read\n  pull-requests: read\n',
    '    permissions:\n      contents: read\n',
    '    permissions:\n      contents: read\n      actions: read\n',
    '    permissions:\n      contents: write\n      actions: read\n      pull-requests: read\n',
    '    permissions:\n      contents: read\n      actions: read\n      pull-requests: read\n      id-token: write\n',
  ]);
  const submit = text.slice(text.indexOf('      - name: Submit the one checked archive'));
  assert.doesNotMatch(submit, /APP_PRIVATE_KEY:/);
});

test('the private App key is excluded from actual child Git environments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ft-app-git-'));
  const priorPath = process.env.PATH, priorKey = process.env.APP_PRIVATE_KEY;
  try {
    writeFileSync(join(dir, 'git'), `#!${process.execPath}\nif (process.env.APP_PRIVATE_KEY !== undefined) process.exit(9); process.stdout.write('${sha('1')}\\n');\n`, { mode: 0o755 });
    process.env.PATH = dir + ':/usr/bin:/bin';
    process.env.APP_PRIVATE_KEY = 'synthetic-env-canary';
    assert.equal(runner.createIo({}).head(), sha('1'));
  } finally {
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    if (priorKey === undefined) delete process.env.APP_PRIVATE_KEY; else process.env.APP_PRIVATE_KEY = priorKey;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the key is absent from general stage inputs and actual CLI output', async () => {
  const f = authorityApiFixture(), wire = privateAppWire(f), env = environment(f), outputs = [];
  const original = runtime.runStage;
  try {
    runtime.runStage = async (stage, options) => {
      assert.equal(Object.hasOwn(options.env, 'APP_PRIVATE_KEY'), false);
      return original(stage, options);
    };
    await runner.runCli(['authority'], {
      env, fetcher: wire.fetcher,
      io: { head: () => f.context.sha, appendOutput: (_file, text) => outputs.push(text) },
    });
    assert.equal(outputs.length, 1);
    assert(!outputs[0].includes(syntheticPrivateKey), 'No key output');
    assert(!outputs[0].includes('eyJhbGciOiJSUzI1Ni'), 'No App JWT output');
  } finally {
    runtime.runStage = original;
  }
});

for (const [name, damage, code] of [
  ['Bot login', (f) => f.w.app.bot.login = 'another[bot]', 'authority-app'],
  ['Bot type', (f) => f.w.app.bot.type = 'User', 'authority-app'],
  ['PR author', (f) => f.w.pulls[0].user.id = 101, 'authority-release-pr'],
  ['reviewer permission', (f) => f.w.reviewerPermissions[0].permission = 'maintain', 'authority-approval'],
  ['current objection', (f) => f.w.reviews.push({ ...f.w.reviews[0], id: 11, state: 'CHANGES_REQUESTED' }), 'authority-changes-requested'],
  ['exact approved head', (f) => f.w.reviews[0].commit_id = sha('9'), 'authority-approval'],
]) {
  test(`private App metadata cannot override the existing ${name} refusal`, async () => {
    const f = authorityApiFixture();
    damage(f);
    const wire = privateAppWire(f);
    await assert.rejects(() => runner.runCli(['authority'], {
      env: environment(f), fetcher: wire.fetcher,
      io: { head: () => f.context.sha, appendOutput: () => assert.fail('No authority output') },
    }), (error) => error.code === code);
  });
}

for (const stage of ['authority', 'release', 'publish']) {
  test(`private App identity: ${stage} uses authenticated App metadata and retains strict fresh authority`, async () => {
    const f = authorityApiFixture(), wire = privateAppWire(f), outputs = [];
    const work = () => runner.runCli([stage], {
      env: environment(f), fetcher: wire.fetcher,
      io: { head: () => f.context.sha, appendOutput: (_file, text) => outputs.push(text) },
    });
    if (stage === 'authority') {
      const result = await work();
      assert.equal(result.authorized, 'true');
      assert.deepEqual(JSON.parse(result.identity), f.w.expected);
      assert.equal(outputs.length, 1);
    } else {
      // Passing the unchanged fresh-authority and security gates reaches the
      // existing artifact guard. This does not emulate or claim publication.
      await assert.rejects(work, (error) => error.code === 'artifact-id');
      assert.equal(outputs.length, 0);
    }
    assert.equal(wire.seen.filter((x) => x.kind === 'verified-app-jwt').length, 1);
    assert.equal(wire.seen.filter((x) => x.kind === 'forbidden-legacy-app-route').length, 0);
    assert(wire.seen.some((x) => x.kind === 'repository-token' && x.route.includes('/collaborators/')));
  });
}


test('private App identity accepts documented dotted client ID through actual authority runner', async () => {
  const f = authorityApiFixture();
  f.settings.clientId = 'Iv1.ab1112223334445c';
  f.w.app.expectedClientId = f.settings.clientId;
  f.w.app.metadata.client_id = f.settings.clientId;
  const wire = privateAppWire(f), outputs = [];
  const result = await runner.runCli(['authority'], {
    env: environment(f), fetcher: wire.fetcher,
    io: { head: () => f.context.sha, appendOutput: (_file, text) => outputs.push(text) },
  });
  assert.equal(result.authorized, 'true');
  assert.deepEqual(JSON.parse(result.identity), f.w.expected);
  assert.equal(outputs.length, 1);
  assert.equal(wire.seen.filter((x) => x.kind === 'verified-app-jwt').length, 1);
  assert.equal(wire.seen.filter((x) => x.kind === 'forbidden-legacy-app-route').length, 0);
});
