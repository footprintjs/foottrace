import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import child from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { root, sha, authorityApiFixture, proposalApiFixture } from './helpers.mjs';
const require = createRequire(import.meta.url);
const runtime = require('../../scripts/release-github.cjs');
const runner = require('../../scripts/release-runner.cjs');
const SECRET = 'invented-diagnostic-canary-never-print';
const stages = [
  'plan',
  'prepare',
  'proposal',
  'authority',
  'verdict',
  'build-manifest',
  'release',
  'publish',
  'verify',
];
const ownError = (code) => Object.assign(new Error(SECRET), { code });
function env(f = authorityApiFixture()) {
  return {
    REPO_ID: '123',
    REPO_NAME: 'footprintjs/foottrace',
    SOURCE_SHA: f.context.sha,
    SOURCE_REF: 'refs/heads/main',
    EVENT_NAME: 'push',
    RUN_ID: '500',
    RUN_ATTEMPT: '1',
    APP_SLUG: 'release-app',
    APP_CLIENT_ID: 'public-client-id',
    GITHUB_OUTPUT: '/offline/output',
    GITHUB_STEP_SUMMARY: '/offline/summary',
    RUNNER_TEMP: '/offline/temp',
    PLAN_JSON: JSON.stringify({
      repository: f.context.repository,
      sha: f.context.sha,
      tree: sha('3'),
      version: '1.9.0',
      package: 'foottrace',
    }),
    IDENTITY_JSON: JSON.stringify(f.w?.expected ?? {}),
  };
}
const rejectCode = (work, code) =>
  assert.rejects(work, (error) => {
    assert.equal(error.code, code);
    assert.equal(runtime.refusalCode(error), code);
    return true;
  });
const invalid = [
  null,
  undefined,
  SECRET,
  17,
  true,
  Symbol('private'),
  new Error(SECRET),
  new TypeError(SECRET),
  new SyntaxError(SECRET),
  { code: SECRET },
  Object.create({ code: 'stage' }),
];
for (const [status, category] of [
  [401, 'unauthorized'],
  [403, 'forbidden'],
  [404, 'not-found'],
  [409, 'conflict'],
  [422, 'invalid'],
  [429, 'rate-limited'],
  [500, 'server'],
  [599, 'server'],
  [418, 'other'],
]) {
  test(`diagnostic actual HTTP ${status} preserves status with a fixed code and no error-body read`, async () => {
    let calls = 0,
      reads = 0;
    const api = runtime.makeApi(SECRET, async () => {
      calls++;
      return {
        ok: false,
        status,
        get body() {
          reads++;
          throw new Error(SECRET);
        },
      };
    });
    await assert.rejects(
      () => api('POST', '/repos/footprintjs/foottrace/git/refs', { ref: 'x' }),
      (e) => {
        assert.equal(e.code, `github-http-${category}`);
        assert.equal(e.status, status);
        assert.equal(e.message, 'github-api-failed');
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.equal(reads, 0);
  });
}
for (const [i, value] of invalid.entries())
  test(`diagnostic transport rejection ${i} remains fixed`, async () => {
    const api = runtime.makeApi(SECRET, async () => {
      throw value;
    });
    await rejectCode(() => api('GET', '/repos/footprintjs/foottrace'), 'github-transport');
  });
test('diagnostic formatter never reads message, stack, getters or inherited codes', () => {
  let reads = 0;
  const x = Object.defineProperties(
    {},
    Object.fromEntries(
      ['code', 'message', 'stack', 'cause'].map((k) => [
        k,
        {
          get() {
            reads++;
            throw new Error(SECRET);
          },
        },
      ]),
    ),
  );
  for (const value of [
    ...invalid,
    x,
    { code: `stage\n${SECRET}` },
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error(SECRET);
        },
      },
    ),
  ])
    assert.equal(runtime.refusalCode(value), 'release-unexpected');
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  assert.equal(runtime.refusalCode(proxy), 'release-unexpected');
  assert.equal(reads, 0);
  for (const code of ['stage', 'EEXIST', 'dirty-checkout', 'authority-approval', 'invalid-archive'])
    assert.equal(runtime.refusalCode(ownError(code)), code);
});
for (const [label, fetcher, code] of [
  ['malformed response', async () => null, 'github-response'],
  ['malformed status', async () => ({ ok: false, status: SECRET }), 'github-response'],
  [
    'header failure',
    async () => ({
      ok: true,
      headers: {
        get() {
          throw new Error(SECRET);
        },
      },
    }),
    'github-body',
  ],
  [
    'stream failure',
    async () => ({
      ok: true,
      headers: new Headers(),
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('a');
          throw new Error(SECRET);
        },
      },
    }),
    'github-body',
  ],
  ['invalid JSON', async () => new Response('{', { headers: { 'content-type': 'application/json' } }), 'github-json'],
  [
    'oversized body',
    async () => new Response('', { headers: { 'content-length': String(25 * 1024 * 1024) } }),
    'response-limit',
  ],
])
  test(`diagnostic ${label}`, async () => {
    await rejectCode(() => runtime.makeApi(SECRET, fetcher)('GET', '/repos/footprintjs/foottrace'), code);
  });
test('diagnostic binary response remains bytes even with JSON content type', async () => {
  const api = runtime.makeApi(
    SECRET,
    async () => new Response('{broken', { headers: { 'content-type': 'application/json' } }),
  );
  assert.equal(
    (
      await api('GET', '/repos/footprintjs/foottrace/releases/assets/42', { accept: 'application/octet-stream' })
    ).data.toString(),
    '{broken',
  );
});
const authorityPoints = [
  ['main', (r) => r.endsWith('/git/ref/heads/main')],
  ['merge', (r) => r.endsWith(`/git/commits/${sha('1')}`)],
  ['linked-prs', (r) => r.includes('/commits/') && r.includes('/pulls?')],
  ['pr', (r) => r.endsWith('/pulls/100')],
  ['head', (r) => r.endsWith(`/git/commits/${sha('2')}`)],
  ['reviews', (r) => r.includes('/reviews?')],
  ['permission', (r) => r.includes('/collaborators/')],
  ['app', (r) => r.startsWith('/apps/')],
  ['bot', (r) => r.startsWith('/users/')],
  ['package', (r) => r.includes('/contents/package.json')],
  ['recheck', (r) => r.endsWith('/pulls/100')],
];
for (const [name, matches] of authorityPoints)
  test(`diagnostic actual authority ${name} preserves read order and refuses`, async () => {
    const f = authorityApiFixture();
    let hits = 0,
      writes = 0,
      triggered = false;
    const api = async (m, r, b) => {
      assert.equal(triggered, false, 'No read after failed operation');
      if (matches(r) && ++hits === (name === 'recheck' ? 2 : 1)) {
        triggered = true;
        throw new Error(SECRET);
      }
      return f.api(m, r, b);
    };
    await rejectCode(
      () =>
        runner.runCli(['authority'], {
          env: env(f),
          api,
          io: { head: () => f.context.sha, appendOutput: () => writes++ },
        }),
      `authority-${name}:unexpected`,
    );
    assert(triggered);
    assert.equal(writes, 0);
    assert(f.calls.every((c) => c.method === 'GET'));
  });
test('diagnostic real HTTP forbidden identifies the permission operation without body or URL', async () => {
  const f = authorityApiFixture();
  const fetcher = async (url, options) => {
    const u = new URL(url),
      r = u.pathname + u.search;
    if (r.includes('/collaborators/')) return new Response(SECRET, { status: 403 });
    return new Response(JSON.stringify((await f.api(options.method, r)).data), {
      headers: { 'content-type': 'application/json' },
    });
  };
  await rejectCode(
    () =>
      runner.runCli(['authority'], {
        env: env(f),
        fetcher,
        io: { head: () => f.context.sha, appendOutput: () => assert.fail('No output') },
      }),
    'authority-permission:github-http-forbidden',
  );
});
for (const [name, value] of [
  ['null', null],
  ['undefined', undefined],
  ['string', SECRET],
  ['other-status', { status: 403 }],
  ['string404', { status: '404' }],
  ['inherited404', Object.create({ status: 404 })],
  [
    'accessor404',
    Object.defineProperty({}, 'status', {
      get() {
        throw new Error(SECRET);
      },
    }),
  ],
])
  test(`diagnostic optional ${name} is not absence`, async () => {
    await rejectCode(
      () =>
        runtime.optional(async () => {
          throw value;
        }, '/synthetic'),
      'optional:unexpected',
    );
  });

// These use a real child process at the common Git boundary, without patching
// execFileSync. The executable is an owned, offline stand-in, not repository Git.
function withNativeGit(failure, check) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-native-git-'));
  try {
    const bin = path.join(dir, 'bin'),
      calls = path.join(dir, 'calls.jsonl'),
      network = path.join(dir, 'network-attempt'),
      output = path.join(dir, 'github-output'),
      summary = path.join(dir, 'github-summary'),
      preload = path.join(dir, 'offline.cjs');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'git'),
      `#!${process.execPath}\n` +
        `const fs = require('node:fs');\n` +
        `const args = process.argv.slice(2);\n` +
        `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args, cwd:process.cwd()})+'\\n');\n` +
        `const key = JSON.stringify(args);\n` +
        `const methods = {'["rev-parse","HEAD"]':'head','["rev-parse","HEAD^{tree}"]':'gitTree','["diff","--exit-code","HEAD"]':'requireClean'};\n` +
        `const method = methods[key];\n` +
        `if (!method) process.exit(99);\n` +
        `if (method === ${JSON.stringify(failure)}) {\n` +
        `  fs.writeSync(1, ${JSON.stringify(SECRET + '-stdout\n')});\n` +
        `  fs.writeSync(2, ${JSON.stringify(SECRET + '-stderr\n')});\n` +
        `  process.exit(17);\n` +
        `}\n` +
        `fs.writeSync(1, method === 'head' ? ${JSON.stringify(
          sha('1') + '\n',
        )} : method === 'gitTree' ? ${JSON.stringify(sha('3') + '\n')} : '');\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      preload,
      `global.fetch = async () => { require('node:fs').writeFileSync(${JSON.stringify(
        network,
      )}, 'unexpected'); throw new Error('network-forbidden'); };\n`,
    );
    const run = (args) =>
      child.spawnSync(process.execPath, ['--require', preload, ...args], {
        cwd: dir,
        env: {
          ...env(),
          PATH: bin + path.delimiter + path.dirname(process.execPath),
          NODE_OPTIONS: '',
          NODE_PATH: '',
          RUNNER_TEMP: dir,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
        },
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 64 * 1024,
      });
    check({
      run,
      calls: () => fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse),
      output,
      summary,
    });
    assert.equal(fs.existsSync(network), false, 'Git failures must precede any API request');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const nativeGitArgs = {
  head: ['rev-parse', 'HEAD'],
  gitTree: ['rev-parse', 'HEAD^{tree}'],
  requireClean: ['diff', '--exit-code', 'HEAD'],
};
for (const [method, code] of [
  ['head', 'runner-checkout:unexpected'],
  ['gitTree', 'runner-build-manifest:unexpected'],
  ['requireClean', 'runner-build-manifest:unexpected'],
]) {
  test(`diagnostic native Git CLI ${method} prints only the fixed refusal`, () => {
    withNativeGit(method, ({ run, calls, output, summary }) => {
      const result = run([path.join(root, 'scripts/release-runner.cjs'), 'build-manifest']);
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, code + '\n');
      assert.equal(result.stderr.includes(SECRET), false);
      assert.equal(fs.existsSync(output), false);
      assert.equal(fs.existsSync(summary), false);
      const methods = ['head', 'gitTree', 'requireClean'];
      assert.deepEqual(
        calls(),
        methods.slice(0, methods.indexOf(method) + 1).map((m) => ({ args: nativeGitArgs[m], cwd: path.resolve(root) })),
      );
    });
  });
  test(`diagnostic native Git direct ${method} retains captured native error`, () => {
    withNativeGit(method, ({ run, calls }) => {
      const result = run([
        '-e',
        `const io = require(${JSON.stringify(path.join(root, 'scripts/release-runner.cjs'))}).createIo({});\n` +
          `try { io[${JSON.stringify(method)}](); process.exitCode = 2; } catch (error) {\n` +
          `process.stdout.write(JSON.stringify({native:error instanceof Error, status:error.status, signal:error.signal, stdout:error.stdout, stderr:error.stderr, output:error.output, pid:error.pid, code:error.code ?? null})); }`,
      ]);
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, 0);
      const captured = JSON.parse(result.stdout);
      assert.equal(captured.native, true);
      assert.equal(captured.status, 17);
      assert.equal(captured.signal, null);
      assert.equal(captured.stdout, SECRET + '-stdout\n');
      assert.equal(captured.stderr, SECRET + '-stderr\n');
      assert.deepEqual(captured.output, [null, captured.stdout, captured.stderr]);
      assert(Number.isSafeInteger(captured.pid) && captured.pid > 0);
      assert.equal(captured.code, null);
      assert.equal(result.stderr, '', 'Captured child stderr must not also be forwarded');
      assert.deepEqual(calls(), [{ args: nativeGitArgs[method], cwd: path.resolve(root) }]);
    });
  });
}
test('diagnostic native Git success preserves trimmed stdout, argument order and repository cwd', () => {
  withNativeGit(null, ({ run, calls }) => {
    const result = run([
      '-e',
      `const io = require(${JSON.stringify(path.join(root, 'scripts/release-runner.cjs'))}).createIo({});\n` +
        `process.stdout.write(JSON.stringify([io.head(), io.gitTree(), io.requireClean()]));`,
    ]);
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), [sha('1'), sha('3'), '']);
    assert.deepEqual(
      calls(),
      Object.values(nativeGitArgs).map((args) => ({ args, cwd: path.resolve(root) })),
    );
  });
});
test('diagnostic optional own numeric404 and valid values keep their meaning', async () => {
  assert.equal(
    await runtime.optional(async () => {
      throw Object.assign(new Error(SECRET), { status: 404 });
    }, '/synthetic'),
    null,
  );
  assert.equal(await runtime.optional(async () => ({ data: 42 }), '/synthetic'), 42);
  const api = runtime.makeApi(SECRET, async () => new Response('', { status: 404 }));
  assert.equal(await runtime.optional(api, '/repos/footprintjs/foottrace/releases/tags/v1.9.0'), null);
});
for (const stage of stages)
  test(`diagnostic ${stage} malformed PLAN_JSON rejects before API/output`, async () => {
    let calls = 0;
    const f = authorityApiFixture();
    await rejectCode(
      () =>
        runner.runCli([stage], {
          env: { ...env(f), PLAN_JSON: '{' },
          api: () => calls++,
          io: { head: () => f.context.sha, appendOutput: () => calls++, appendSummary: () => calls++ },
        }),
      'plan-json:json',
    );
    assert.equal(calls, 0);
  });
for (const stage of stages)
  for (const asyncFailure of [false, true])
    test(`diagnostic ${stage} ${asyncFailure ? 'rejected' : 'thrown'} operation failure`, async () => {
      const f = authorityApiFixture();
      // The malformed identity boundary is shared by every actual stage before its authority/IO work.
      await rejectCode(
        () =>
          runner.runCli([stage], {
            env: { ...env(f), IDENTITY_JSON: '{' },
            api: () => assert.fail('No API'),
            io: { head: () => f.context.sha },
          }),
        'identity-json:json',
      );
      const operation = `runner-${stage}`;
      await rejectCode(
        () =>
          runtime.withRefusal(operation, () =>
            asyncFailure
              ? Promise.reject(null)
              : (() => {
                  throw null;
                })(),
          ),
        `${operation}:unexpected`,
      );
    });
for (const [point, code] of [
  ['head', 'runner-checkout:unexpected'],
  ['appendOutput', 'runner-output-write:unexpected'],
])
  test(`diagnostic runner ${point} native failure`, async () => {
    const f = authorityApiFixture(),
      events = [];
    const io = { head: () => f.context.sha, appendOutput: () => events.push('output') };
    io[point] = () => {
      throw new Error(SECRET);
    };
    await rejectCode(() => runner.runCli(['authority'], { env: env(f), api: f.api, io }), code);
    assert.deepEqual(events, []);
  });
test('diagnostic dirty-checkout and native EEXIST remain exact direct-call contracts', async () => {
  const f = authorityApiFixture();
  const dirty = ownError('dirty-checkout');
  await assert.rejects(
    () =>
      runner.runCli(['build-manifest'], {
        env: env(f),
        api: () => assert.fail('No API'),
        io: {
          head: () => f.context.sha,
          gitTree: () => sha('3'),
          requireClean: () => {
            throw dirty;
          },
        },
      }),
    (e) => e === dirty && e.code === 'dirty-checkout',
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-diagnostic-exclusive-'));
  try {
    const io = runner.createIo({ RUNNER_TEMP: dir, RUN_ID: '1', RUN_ATTEMPT: '1' }),
      file = io.publishFile(1, 1);
    io.write(file, Buffer.from('one'));
    assert.throws(() => io.write(file, Buffer.from('two')), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'one');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('diagnostic verify retains prior output if the subsequent summary fails', async () => {
  const f = authorityApiFixture(),
    effects = [];
  const api = async () => {
    throw Object.assign(new Error('not-found'), { status: 404 });
  };
  await rejectCode(
    () =>
      runner.runCli(['verify'], {
        env: env(f),
        api,
        io: {
          head: () => f.context.sha,
          appendOutput: (p, b) => effects.push(b),
          appendSummary: () => {
            effects.push('partial-summary');
            throw null;
          },
        },
      }),
    'runner-summary-write:unexpected',
  );
  assert.equal(effects.length, 2);
  assert(effects[0].includes('pending-release'));
  assert.equal(effects[1], 'partial-summary');
});
test('diagnostic failed append retains partial evidence without retry', async () => {
  const f = authorityApiFixture(),
    effects = [];
  await rejectCode(
    () =>
      runner.runCli(['authority'], {
        env: env(f),
        api: f.api,
        io: {
          head: () => f.context.sha,
          appendOutput: (p, b) => {
            effects.push(b.slice(0, 5));
            throw new Error(SECRET);
          },
        },
      }),
    'runner-output-write:unexpected',
  );
  assert.equal(effects.length, 1);
});
for (const [name, fetcher, code] of [
  [
    'transport',
    async () => {
      throw null;
    },
    'registry-transport',
  ],
  [
    'body',
    async () => ({
      status: 200,
      ok: true,
      headers: new Headers(),
      body: {
        async *[Symbol.asyncIterator]() {
          throw null;
        },
      },
    }),
    'registry-body',
  ],
  ['json', async () => new Response('{'), 'registry-json:json'],
])
  test(`diagnostic registry ${name} refuses`, async () => {
    await rejectCode(() => runtime.registryVersion('1.9.0', fetcher), code);
  });
test('diagnostic registry404 still means pending and security never becomes CI success', async () => {
  assert.equal(await runtime.registryVersion('1.9.0', async () => new Response('', { status: 404 })), null);
  const f = authorityApiFixture(),
    api = async () => {
      throw null;
    };
  await rejectCode(() => runtime.requireSecurity(api, f.w.expected), 'security-evidence:unexpected');
  assert.deepEqual(await runtime.ciVerdict(api, f.w.expected), {
    tested: false,
    fallback: 'both-full-runtime-gates',
    reason: 'evidence-unavailable',
  });
});
test('diagnostic reservation failure remains one ambiguous write, never a retry', async () => {
  let calls = 0;
  const api = runtime.makeApi(SECRET, async () => {
    calls++;
    throw null;
  });
  await rejectCode(
    () =>
      runtime.reserveAttempt(
        api,
        { upload_url: 'https://uploads.github.com/repos/footprintjs/foottrace/releases/12/assets{?name,label}' },
        { version: '1.9.0' },
      ),
    'github-transport',
  );
  assert.equal(calls, 1);
});
test('diagnostic healthy authority success output and request trace remain exact', async () => {
  const f = authorityApiFixture(),
    output = [];
  await runner.runCli(['authority'], {
    env: env(f),
    api: f.api,
    io: { head: () => f.context.sha, appendOutput: (p, b) => output.push(b) },
  });
  assert.deepEqual(output, [`identity=${JSON.stringify(f.w.expected)}\nauthorized=true\n`]);
  assert.equal(f.calls.filter((c) => c.route.endsWith('/pulls/100')).length, 2);
  assert(f.calls.every((c) => c.method === 'GET'));
});
for (const [label, statement] of [
  ['native', `throw new TypeError('${SECRET}');`],
  ['null', 'throw null;'],
  ['forbidden', `return new Response('${SECRET}',{status:403});`],
  ['malicious-code', `throw {code:'${SECRET}\\nforged=true'};`],
])
  test(`diagnostic actual terminal CLI ${label}`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-diagnostic-cli-'));
    try {
      const preload = path.join(dir, 'offline.cjs');
      fs.writeFileSync(
        preload,
        `require('node:child_process').execFileSync=()=> '${sha('1')}';global.fetch=async()=>{${statement}};`,
      );
      const result = child.spawnSync(
        process.execPath,
        ['--require', preload, path.join(root, 'scripts/release-runner.cjs'), 'authority'],
        {
          cwd: root,
          env: { ...env(), PATH: '/usr/bin:/bin', NODE_OPTIONS: '', NODE_PATH: '' },
          encoding: 'utf8',
          timeout: 3000,
        },
      );
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.signal, null);
      assert.equal(result.stdout, '');
      assert.equal(
        result.stderr.trim(),
        label === 'forbidden' ? 'authority-main:github-http-forbidden' : 'authority-main:github-transport',
      );
      assert(!result.stderr.includes(SECRET));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

// Synthetic byte builders retained from the unchanged archive suite. Never extracted or executed.
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

function artifactFixture(role = 'build', change = {}) {
  const f = authorityApiFixture(),
    c = f.context,
    calls = [];
  const bytes = tar([
    { name: 'package/package.json', body: JSON.stringify({ name: 'foottrace', version: '1.9.0' }) },
    { name: 'package/dist/index.js', body: 'exports.fixture=true;' },
  ]);
  const archive = require('../../scripts/release-archive.cjs').inspectArchive(bytes, {
    package: 'foottrace',
    version: '1.9.0',
  });
  const manifest = {
    repositoryId: 123,
    runId: 500,
    runAttempt: 1,
    jobId: 300,
    sourceSha: c.sha,
    tree: sha('3'),
    package: 'foottrace',
    version: '1.9.0',
    sha256: archive.sha256,
    integrity: archive.integrity,
    shasum: archive.shasum,
  };
  const api = async (method, route, body) => {
    calls.push({ method, route });
    assert.equal(method, 'GET');
    if (route.endsWith('/actions/runs/500'))
      return {
        data: {
          id: 500,
          run_attempt: 1,
          head_sha: c.sha,
          repository: c.repository,
          head_repository: c.repository,
          path: '.github/workflows/publish.yml',
          head_branch: 'main',
          event: 'push',
          status: 'in_progress',
          conclusion: null,
        },
      };
    if (route.includes('/actions/runs/500/attempts/1/jobs?'))
      return {
        data: {
          total_count: 1,
          jobs: [
            {
              id: 300,
              name: role,
              run_id: 500,
              run_attempt: 1,
              head_sha: c.sha,
              status: 'completed',
              conclusion: 'success',
            },
          ],
        },
      };
    if (route.endsWith('/actions/artifacts/400'))
      return {
        data: {
          id: 400,
          name: `foottrace-123-500-1-${role}`,
          expired: false,
          workflow_run: { id: 500, head_sha: c.sha, repository_id: 123 },
        },
      };
    if (route.endsWith('/actions/artifacts/400/zip'))
      return {
        data: zip([
          ['manifest.json', change.manifest ?? JSON.stringify(manifest)],
          [role === 'prepare' ? 'proposal.json' : 'package.tgz', role === 'prepare' ? change.proposal ?? '{}' : bytes],
        ]),
      };
    return f.api(method, route, body);
  };
  return { ...f, api, calls, bytes, archive };
}
for (const [name, code] of [
  ['package.json', 'package-json:json'],
  ['package-lock.json', 'lock-json:json'],
  ['pack.json', 'pack-json:json'],
])
  test(`diagnostic build ${name} JSON parsing refuses in the real stage`, async () => {
    const f = authorityApiFixture(),
      events = [];
    const good = {
      'package.json': JSON.stringify({ name: 'foottrace', version: '1.9.0' }),
      'package-lock.json': JSON.stringify({ version: '1.9.0', packages: { '': { version: '1.9.0' } } }),
      'pack.json': '[]',
    };
    await rejectCode(
      () =>
        runner.runCli(['build-manifest'], {
          env: env(f),
          api: () => assert.fail('No API'),
          io: {
            head: () => f.context.sha,
            gitTree: () => sha('3'),
            requireClean: () => {},
            read: (p) => {
              events.push(p);
              return p === name ? '{' : good[p];
            },
          },
        }),
      code,
    );
    assert.equal(events.at(-1), name);
  });
for (const [name, body] of [
  ['package.json', 'null'],
  ['package-lock.json', 'null'],
])
  test(`diagnostic build ${name} null shape refuses with fixed stage fallback`, async () => {
    const f = authorityApiFixture();
    await rejectCode(
      () =>
        runner.runCli(['build-manifest'], {
          env: env(f),
          api: () => assert.fail('No API'),
          io: {
            head: () => f.context.sha,
            gitTree: () => sha('3'),
            requireClean: () => {},
            read: (p) =>
              p === name
                ? body
                : JSON.stringify({ name: 'foottrace', version: '1.9.0', packages: { '': { version: '1.9.0' } } }),
          },
        }),
      'runner-build-manifest:unexpected',
    );
  });
for (const [role, change, stage, code] of [
  ['prepare', { manifest: '{' }, 'proposal', 'artifact-json:json'],
  ['prepare', { proposal: '{' }, 'proposal', 'artifact-json:json'],
  ['build', { manifest: '{' }, 'publish', 'artifact-json:json'],
  ['build', {}, 'publish', 'grant-json:json'],
])
  test(`diagnostic real ${stage} parses bound ${
    Object.keys(change)[0] ?? 'grant'
  } data only after its gates`, async () => {
    const f = artifactFixture(role, change);
    await rejectCode(
      () =>
        runner.runCli([stage], {
          env: { ...env(f), ARTIFACT_ID: '400', GRANT_JSON: '{' },
          api: f.api,
          fetcher: async () => new Response('', { status: 404 }),
          io: {
            head: () => f.context.sha,
            write: () => assert.fail('No archive write'),
            appendOutput: () => assert.fail('No output'),
          },
        }),
      code,
    );
    assert(f.calls.some((c) => c.route.endsWith('/actions/artifacts/400/zip')));
  });
test('diagnostic prepare retains first artifact after second write fails', async () => {
  const f = proposalApiFixture(),
    pinned = await runtime.plan(f.api, f.context),
    effects = [];
  const api = async (m, r, b) => {
    if (r.endsWith('/actions/runs/500'))
      return {
        data: {
          id: 500,
          run_attempt: 1,
          head_sha: f.context.sha,
          repository: f.context.repository,
          head_repository: f.context.repository,
          path: '.github/workflows/publish.yml',
          head_branch: 'main',
          event: 'push',
          status: 'in_progress',
          conclusion: null,
        },
      };
    if (r.includes('/actions/runs/500/attempts/1/jobs?'))
      return {
        data: {
          total_count: 1,
          jobs: [{ id: 300, name: 'prepare', run_id: 500, run_attempt: 1, head_sha: f.context.sha }],
        },
      };
    return f.api(m, r, b);
  };
  await rejectCode(
    () =>
      runner.runCli(['prepare'], {
        env: { ...env(f), PLAN_JSON: JSON.stringify(pinned) },
        api,
        io: {
          head: () => f.context.sha,
          write: (name, bytes) => {
            effects.push(name);
            if (effects.length === 2) throw new Error(SECRET);
            assert(bytes.length > 0);
          },
          appendOutput: () => assert.fail('No output after write failure'),
        },
      }),
    'runner-prepare:unexpected',
  );
  assert.deepEqual(effects, ['release-artifact/proposal.json', 'release-artifact/manifest.json']);
});
test('diagnostic actual publish final archive write failure is not retried', async () => {
  const f = artifactFixture(),
    effects = [],
    journal = { version: '1.9.0', runId: 500, runAttempt: 1, sha: f.context.sha, integrity: f.archive.integrity };
  const api = async (m, r, b) => {
    if (r.endsWith('/releases/assets/800'))
      return {
        data: b?.accept
          ? Buffer.from(JSON.stringify(journal))
          : { id: 800, state: 'uploaded', name: 'publish-attempt-1.9.0.json', size: JSON.stringify(journal).length },
      };
    if (r.endsWith('/git/ref/tags/v1.9.0')) return { data: { object: { type: 'commit', sha: f.context.sha } } };
    return f.api(m, r, b);
  };
  await rejectCode(
    () =>
      runner.runCli(['publish'], {
        env: {
          ...env(f),
          ARTIFACT_ID: '400',
          GRANT_JSON: JSON.stringify({ fresh: true, assetId: 800, runId: 500, runAttempt: 1 }),
        },
        api,
        fetcher: async () => new Response('', { status: 404 }),
        io: {
          head: () => f.context.sha,
          publishFile: () => '/offline/archive',
          write: (p, b) => {
            effects.push(p);
            throw new Error(SECRET);
          },
          appendOutput: () => assert.fail('No output'),
        },
      }),
    'runner-publish:unexpected',
  );
  assert.deepEqual(effects, ['/offline/archive']);
});
test('diagnostic malformed reservation journal refuses before a subsequent tag read', async () => {
  const f = artifactFixture(),
    calls = [];
  const api = async (m, r, b) => {
    calls.push(r);
    if (r.endsWith('/git/ref/heads/main')) return { data: { object: { sha: f.context.sha } } };
    if (r.endsWith('/releases/assets/800'))
      return {
        data: b?.accept
          ? Buffer.from('{')
          : { id: 800, state: 'uploaded', name: 'publish-attempt-1.9.0.json', size: 1 },
      };
    assert.fail('No later tag lookup');
  };
  await rejectCode(
    () =>
      runtime.publishGrant(api, f.context, f.w.expected, f.archive, {
        fresh: true,
        assetId: 800,
        runId: 500,
        runAttempt: 1,
      }),
    'journal-json:json',
  );
  assert.equal(calls.length, 3);
});
for (const code of ['EEXIST', 'dirty-checkout'])
  test(`diagnostic wrappers keep exact legacy ${code} without echoing native detail`, async () => {
    const original = ownError(code);
    assert.throws(
      () =>
        runtime.withRefusalSync('runner-checkout', () => {
          throw original;
        }),
      (e) => e === original,
    );
    await assert.rejects(
      () => runtime.withRefusal('runner-build-manifest', () => Promise.reject(original)),
      (e) => e === original,
    );
    assert.equal(runtime.refusalCode(original), code);
  });
for (const op of [SECRET, 'runner-evil', null, {}, 'authority-permission:' + SECRET])
  test(`diagnostic invalid context refuses without callback ${typeof op}`, async () => {
    let calls = 0;
    await rejectCode(() => runtime.withRefusal(op, () => calls++), 'diagnostic-operation');
    assert.equal(calls, 0);
  });

// A synthetic helper rejection isolates the outer terminal contract. This is not
// an additional hosted/normal-producer reproduction: inner boundaries normally
// sanitize these values first, which can mask removal of the final formatter.
for (const [name, value] of [
  ['null', 'null'],
  ['raw-code', `{code:'${SECRET}\\nforged=true'}`],
  ['accessor', `Object.defineProperty({},'code',{get(){throw new Error('${SECRET}')}})`],
])
  test(`diagnostic isolated terminal refuses synthetic helper rejection ${name}`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-terminal-isolation-'));
    try {
      const preload = path.join(dir, 'offline.cjs');
      fs.writeFileSync(
        preload,
        `require('node:child_process').execFileSync=()=> '${sha('1')}';` +
          `global.fetch=async()=>{throw new Error('network-forbidden')};` +
          `require(${JSON.stringify(
            path.join(root, 'scripts/release-github.cjs'),
          )}).withRefusal=async()=>{throw ${value}};`,
      );
      const result = child.spawnSync(
        process.execPath,
        ['--require', preload, path.join(root, 'scripts/release-runner.cjs'), 'authority'],
        {
          cwd: root,
          env: { ...env(), PATH: '/usr/bin:/bin', NODE_OPTIONS: '', NODE_PATH: '' },
          encoding: 'utf8',
          timeout: 3000,
        },
      );
      assert.equal(result.status, 1);
      assert.equal(result.signal, null);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'release-unexpected\n');
      assert(!result.stderr.includes(SECRET));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
