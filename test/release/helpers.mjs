import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
export const root = fileURLToPath(new URL('../../', import.meta.url));
export const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
export function call(module, name, ...args) {
  const file = new URL(`../../scripts/${module}.cjs`, import.meta.url);
  assert(existsSync(file), `Release App feature absent on baseline: scripts/${module}.cjs`);
  const api = require(fileURLToPath(file));
  assert.equal(typeof api[name], 'function', `Missing reviewed contract ${module}.${name}`);
  return api[name](...args);
}
export const sha = (char) => char.repeat(40);
export const identity = () => ({
  repository: { id: 123, full_name: 'footprintjs/foottrace' },
  baseRef: 'main',
  headRef: 'release/next',
  mergeSha: sha('1'),
  headSha: sha('2'),
  tree: sha('3'),
  package: 'foottrace',
  version: '1.9.0',
  tag: 'v1.9.0',
  pr: 100,
});
export function authorityWorld() {
  const expected = identity();
  return {
    expected,
    event: { name: 'push', ref: 'refs/heads/main', sha: expected.mergeSha, repository: expected.repository },
    commit: { sha: expected.mergeSha, tree: { sha: expected.tree } },
    headCommit: { sha: expected.headSha, tree: { sha: expected.tree } },
    app: {
      expectedClientId: 'public-client-id',
      expectedSlug: 'release-app',
      metadata: { slug: 'release-app', client_id: 'public-client-id' },
      bot: { id: 99, login: 'release-app[bot]', type: 'Bot' },
    },
    pullsComplete: true,
    reviewsComplete: true,
    permissionsComplete: true,
    reviewerPermissions: [{ user: { id: 9, login: 'reviewer' }, permission: 'admin' }],
    pulls: [
      {
        id: 1000,
        number: 100,
        state: 'closed',
        merged_at: '2026-10-30T00:00:00Z',
        merge_commit_sha: expected.mergeSha,
        user: { id: 99, login: 'release-app[bot]', type: 'Bot' },
        base: { ref: 'main', repo: expected.repository },
        head: { ref: 'release/next', sha: expected.headSha, repo: expected.repository },
      },
    ],
    reviews: [
      {
        id: 10,
        state: 'APPROVED',
        commit_id: expected.headSha,
        submitted_at: '2026-10-29T23:00:00Z',
        user: { id: 9, login: 'reviewer', type: 'User' },
        author_association: 'OWNER',
      },
    ],
  };
}
export function ciWorld() {
  const expected = identity();
  const workflow = { id: 42, path: '.github/workflows/ci.yml' };
  const run = {
    id: 200,
    run_attempt: 2,
    workflow_id: 42,
    path: workflow.path,
    event: 'pull_request',
    head_sha: expected.headSha,
    head_branch: 'release/next',
    head_repository: expected.repository,
    status: 'completed',
    conclusion: 'success',
  };
  const job = (name) => ({
    id: name === 'tested-tree' ? 3 : name.includes('22') ? 1 : 2,
    name,
    run_id: 200,
    run_attempt: 2,
    status: 'completed',
    conclusion: 'success',
    steps: [],
  });
  const jobs = [job('check (22)'), job('check (24)'), job('tested-tree')];
  jobs[2].steps = [{ name: `tested tree ${expected.tree}`, conclusion: 'success' }];
  return { expected, workflow, runsComplete: true, jobsComplete: true, runs: [run], attempt: run, jobs };
}
export function authorityApiFixture() {
  const w = authorityWorld(),
    ci = ciWorld(),
    calls = [];
  const q = { ...ci.runs[0], id: 300, workflow_id: 43, path: '.github/workflows/codeql.yml', run_attempt: 1 };
  const jobs = ['Analyze (actions)', 'Analyze (javascript-typescript)'].map((name, i) => ({
    id: 21 + i,
    name,
    run_id: 300,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
  }));
  const routes = new Map([
    ['/repos/footprintjs/foottrace/git/ref/heads/main', { object: { sha: w.expected.mergeSha } }],
    [`/repos/footprintjs/foottrace/git/commits/${w.expected.mergeSha}`, w.commit],
    [`/repos/footprintjs/foottrace/git/commits/${w.expected.headSha}`, w.headCommit],
    [`/repos/footprintjs/foottrace/commits/${w.expected.mergeSha}/pulls?per_page=100&page=1`, w.pulls],
    ['/repos/footprintjs/foottrace/pulls/100', w.pulls[0]],
    ['/repos/footprintjs/foottrace/pulls/100/reviews?per_page=100&page=1', w.reviews],
    ['/repos/footprintjs/foottrace/collaborators/reviewer/permission', w.reviewerPermissions[0]],
    ['/apps/release-app', w.app.metadata],
    ['/users/release-app%5Bbot%5D', w.app.bot],
    [
      `/repos/footprintjs/foottrace/contents/package.json?ref=${w.expected.mergeSha}`,
      {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(JSON.stringify({ name: 'foottrace', version: '1.9.0' })).toString('base64'),
        size: JSON.stringify({ name: 'foottrace', version: '1.9.0' }).length,
      },
    ],
    ['/repos/footprintjs/foottrace/actions/workflows/codeql.yml', { id: 43, path: '.github/workflows/codeql.yml' }],
    [
      `/repos/footprintjs/foottrace/actions/workflows/43/runs?event=pull_request&head_sha=${w.expected.headSha}&per_page=100&page=1`,
      { total_count: 1, workflow_runs: [q] },
    ],
    ['/repos/footprintjs/foottrace/actions/runs/300/attempts/1', q],
    [
      '/repos/footprintjs/foottrace/actions/runs/300/attempts/1/jobs?per_page=100&page=1',
      { total_count: jobs.length, jobs },
    ],
    ['/repos/footprintjs/foottrace/actions/workflows/ci.yml', ci.workflow],
    [
      `/repos/footprintjs/foottrace/actions/workflows/42/runs?event=pull_request&head_sha=${w.expected.headSha}&per_page=100&page=1`,
      { total_count: 1, workflow_runs: ci.runs },
    ],
    ['/repos/footprintjs/foottrace/actions/runs/200/attempts/2', ci.attempt],
    [
      '/repos/footprintjs/foottrace/actions/runs/200/attempts/2/jobs?per_page=100&page=1',
      { total_count: 3, jobs: ci.jobs },
    ],
  ]);
  const api = async (method, route, body) => {
    calls.push({ method, route, body });
    assert.equal(method, 'GET', 'read-only fixture forbids writes');
    assert(routes.has(route), `Unexpected route ${route}`);
    return { data: routes.get(route) };
  };
  return {
    w,
    ci,
    q,
    jobs,
    routes,
    calls,
    api,
    context: {
      repository: w.expected.repository,
      sha: w.expected.mergeSha,
      ref: 'refs/heads/main',
      eventName: 'push',
      runId: 500,
      runAttempt: 1,
    },
    settings: { slug: 'release-app', clientId: 'public-client-id' },
  };
}
export function proposalApiFixture() {
  const repository = { id: 123, full_name: 'footprintjs/foottrace' },
    base = sha('1'),
    tree = sha('3');
  const files = Object.fromEntries(
    ['package.json', 'package-lock.json', 'CHANGELOG.md', 'README.md', 'docs/metadata.md'].map((name) => [
      name,
      read(name),
    ]),
  );
  files['.changes/metadata-query.md'] = read('.changes/metadata-query.md');
  const calls = [],
    blobs = new Map();
  let created = false,
    currentMain = base,
    pr = null;
  const api = async (method, route, body) => {
    calls.push({ method, route, body });
    const missing = () => {
      throw Object.assign(new Error('not-found'), { status: 404 });
    };
    if (method === 'GET') {
      if (route === '/repos/footprintjs/foottrace') return { data: repository };
      if (route.endsWith('/git/ref/heads/main')) return { data: { object: { sha: currentMain } } };
      if (route === `/repos/footprintjs/foottrace/git/commits/${base}`)
        return { data: { sha: base, tree: { sha: tree }, committer: { date: '2026-10-30T00:00:00Z' } } };
      if (route === `/repos/footprintjs/foottrace/git/trees/${tree}?recursive=1`)
        return {
          data: { truncated: false, tree: [{ path: '.changes/metadata-query.md', type: 'blob', mode: '100644' }] },
        };
      if (route.includes('/contents/')) {
        const name = route.split('/contents/')[1].split('?')[0];
        assert(Object.hasOwn(files, name), name);
        const bytes = Buffer.from(files[name]);
        return { data: { type: 'file', encoding: 'base64', content: bytes.toString('base64'), size: bytes.length } };
      }
      if (route.endsWith('/git/ref/heads/release/next'))
        return created ? { data: { object: { sha: sha('e') } } } : missing();
      if (route.endsWith(`/git/commits/${sha('e')}`))
        return { data: { sha: sha('e'), tree: { sha: sha('d') }, parents: [{ sha: base }] } };
      if (route.includes('/pulls?state=open&head=')) return { data: pr ? [pr] : [] };
    }
    if (method === 'POST') {
      if (route.endsWith('/git/blobs')) {
        const digest = createHash('sha1').update(body.content).digest('hex');
        blobs.set(digest, body.content);
        return { data: { sha: digest } };
      }
      if (route.endsWith('/git/trees')) return { data: { sha: sha('d') } };
      if (route.endsWith('/git/commits')) return { data: { sha: sha('e') } };
      if (route.endsWith('/git/refs')) {
        assert.equal(body.ref, 'refs/heads/release/next');
        assert.equal(body.sha, sha('e'));
        assert.equal(created, false);
        created = true;
        return { data: {} };
      }
      if (route.endsWith('/pulls')) {
        pr = { id: 555, number: 100, state: 'open', head: { sha: sha('e') }, base: { ref: 'main' } };
        return { data: pr };
      }
    }
    assert.fail(`Unexpected ${method} ${route}`);
  };
  return {
    api,
    calls,
    blobs,
    files,
    moveMain: () => {
      currentMain = sha('4');
    },
    context: { repository, sha: base, ref: 'refs/heads/main', eventName: 'push', runId: 500, runAttempt: 1 },
  };
}
export function actualControlProgram(stage) {
  const yaml = read('.github/workflows/publish.yml');
  const marker = `          # trusted-stage: ${stage}\n          node <<'FOOTTRACE_RELEASE'\n`;
  const start = yaml.indexOf(marker);
  assert(start >= 0, `Missing actual emitted stage ${stage}`);
  assert.equal(yaml.indexOf(marker, start + marker.length), -1);
  const end = yaml.indexOf('\n          FOOTTRACE_RELEASE', start + marker.length);
  assert(end > start);
  return yaml
    .slice(start + marker.length, end)
    .split('\n')
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
}
export async function executeRenderedStage(stage, { env, api, fetcher }) {
  const vm = await import('node:vm');
  const script = actualControlProgram(stage);
  let output = '',
    failure = null;
  const writes = [];
  const process = {
    env: { ...env, GITHUB_OUTPUT: 'outputs', RUNNER_TEMP: '/offline', GH_TOKEN: 'offline-test-token' },
    exitCode: 0,
  };
  const fetch = async (url, options = {}) => {
    if (url.startsWith('https://registry.npmjs.org/')) return fetcher(url, options);
    const parsed = new URL(url),
      route = parsed.hostname === 'uploads.github.com' ? url : parsed.pathname + parsed.search;
    const body = options.body
      ? Buffer.isBuffer(options.body)
        ? { raw: options.body, contentType: options.headers['content-type'] }
        : JSON.parse(options.body)
      : options.headers?.accept === 'application/octet-stream'
      ? { accept: 'application/octet-stream' }
      : undefined;
    try {
      const response = await api(options.method ?? 'GET', route, body);
      return new Response(Buffer.isBuffer(response.data) ? response.data : JSON.stringify(response.data), {
        headers: { 'content-type': Buffer.isBuffer(response.data) ? 'application/octet-stream' : 'application/json' },
      });
    } catch (e) {
      if (e.status) return new Response('', { status: e.status });
      throw e;
    }
  };
  await vm.runInNewContext(script, {
    Buffer,
    TextDecoder,
    AbortSignal,
    fetch,
    process,
    console: { error: (x) => (failure = x) },
    require: (name) =>
      name === 'node:fs'
        ? {
            appendFileSync: (file, bytes) => {
              assert.equal(file, 'outputs');
              output += bytes;
            },
            mkdirSync: () => {},
            writeFileSync: (name, bytes) => writes.push({ name, bytes }),
          }
        : name === 'node:child_process'
        ? { execFileSync: () => assert.fail('Privileged step may not execute project code') }
        : require(name),
  });
  return { output, failure, exit: process.exitCode, writes };
}
