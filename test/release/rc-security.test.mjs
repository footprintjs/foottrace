import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { sha, authorityApiFixture } from './helpers.mjs';
const require = createRequire(import.meta.url),
  runtime = require('../../scripts/release-github.cjs');
function fixture() {
  const repository = { id: 123, full_name: 'footprintjs/foottrace' },
    sourceSha = sha('1');
  const identity = { mode: 'rc', sourceSha, repository },
    workflow = { id: 43, path: '.github/workflows/codeql.yml' };
  const run = {
    id: 300,
    run_attempt: 2,
    workflow_id: 43,
    path: workflow.path,
    event: 'push',
    head_branch: 'main',
    head_sha: sourceSha,
    repository,
    head_repository: repository,
    status: 'completed',
    conclusion: 'success',
  };
  const jobs = ['Analyze (javascript-typescript)', 'Analyze (actions)'].map((name, i) => ({
    id: 20 + i,
    name,
    run_id: 300,
    run_attempt: 2,
    head_sha: sourceSha,
    status: 'completed',
    conclusion: 'success',
  }));
  const f = { identity, workflow, runs: [run], attempt: { ...run }, jobs, calls: [] };
  f.api = async (method, route) => {
    f.calls.push({ method, route });
    assert.equal(method, 'GET');
    const base = '/repos/footprintjs/foottrace';
    if (route === base + '/actions/workflows/codeql.yml') return { data: f.workflow };
    if (
      route ===
      base + '/actions/workflows/43/runs?event=push&head_sha=' + sourceSha + '&branch=main&per_page=100&page=1'
    )
      return { data: { total_count: f.runs.length, workflow_runs: f.runs } };
    if (route === base + '/actions/runs/300/attempts/2') return { data: f.attempt };
    if (route === base + '/actions/runs/299/attempts/2') return { data: f.runs.find((r) => r.id === 299) };
    if (route === base + '/actions/runs/299/attempts/2/jobs?per_page=100&page=1')
      return { data: { total_count: f.jobs.length, jobs: f.jobs.map((j) => ({ ...j, run_id: 299 })) } };
    if (route === base + '/actions/runs/300/attempts/2/jobs?per_page=100&page=1')
      return { data: { total_count: f.jobs.length, jobs: f.jobs } };
    assert.fail('Unexpected source-bound CodeQL route: ' + route);
  };
  return f;
}
test('RC security keeps the stable release PR query unchanged', async () => {
  const f = authorityApiFixture();
  assert.deepEqual(await runtime.requireSecurity(f.api, f.w.expected), { runId: 300, attempt: 1 });
});
test('RC security binds trusted push on the current main SHA without a PR head', async () => {
  const f = fixture();
  assert.equal(Object.hasOwn(f.identity, 'headSha'), false);
  assert.deepEqual(await runtime.requireSecurity(f.api, f.identity), { runId: 300, attempt: 2 });
});

for (const [name, change, code] of [
  ['PR run', (f) => (f.runs[0].event = 'pull_request'), 'security-run'],
  ['other branch', (f) => (f.runs[0].head_branch = 'other'), 'security-run'],
  ['other source', (f) => (f.runs[0].head_sha = sha('9')), 'security-run'],
  ['fork head repository', (f) => (f.runs[0].head_repository = { id: 999, full_name: 'foreign/repo' }), 'security-run'],
  [
    'foreign producer repository',
    (f) => (f.runs[0].repository = { id: 999, full_name: 'foreign/repo' }),
    'security-run',
  ],
  ['missing source SHA', (f) => delete f.identity.sourceSha, 'security-run'],
  ['wrong workflow path', (f) => (f.workflow.path = '.github/workflows/other.yml'), 'security-run'],
  ['wrong workflow identity', (f) => (f.runs[0].workflow_id = 99), 'security-run'],
  [
    'unfinished latest run',
    (f) => {
      f.runs[0].status = 'in_progress';
      f.runs[0].conclusion = null;
    },
    'security-run',
  ],
  ['failed latest run', (f) => (f.runs[0].conclusion = 'failure'), 'security-run'],
  ['old attempt', (f) => (f.attempt.run_attempt = 1), 'security-run'],
  ['wrong attempt source', (f) => (f.attempt.head_sha = sha('9')), 'security-run'],
  ['PR attempt', (f) => (f.attempt.event = 'pull_request'), 'security-run'],
  ['other attempt branch', (f) => (f.attempt.head_branch = 'other'), 'security-run'],
  [
    'foreign attempt repository',
    (f) => (f.attempt.repository = { id: 999, full_name: 'foreign/repo' }),
    'security-run',
  ],
  [
    'foreign attempt head repository',
    (f) => (f.attempt.head_repository = { id: 999, full_name: 'foreign/repo' }),
    'security-run',
  ],
  [
    'unfinished attempt',
    (f) => {
      f.attempt.status = 'in_progress';
      f.attempt.conclusion = null;
    },
    'security-run',
  ],
  ['missing Analyze job', (f) => f.jobs.pop(), 'security-job'],
  ['duplicate Analyze job', (f) => f.jobs.push({ ...f.jobs[0], id: 99 }), 'security-job'],
  ['wrong job attempt', (f) => (f.jobs[0].run_attempt = 1), 'security-job'],
  ['wrong job run', (f) => (f.jobs[0].run_id = 301), 'security-job'],
  ['failed language job', (f) => (f.jobs[0].conclusion = 'failure'), 'security-job'],
  ['wrong job source', (f) => (f.jobs[0].head_sha = sha('9')), 'security-job'],
])
  test('RC security refuses ' + name, async () => {
    const f = fixture();
    change(f);
    await assert.rejects(() => runtime.requireSecurity(f.api, f.identity), { code });
    assert(f.calls.every((x) => x.method === 'GET'));
  });
test('RC security never falls back to an older green run when the latest is unfinished', async () => {
  const f = fixture();
  f.runs.unshift({ ...f.runs[0], id: 299 });
  f.runs[1].status = 'in_progress';
  f.runs[1].conclusion = null;
  await assert.rejects(() => runtime.requireSecurity(f.api, f.identity), { code: 'security-run' });
  assert(f.calls.some((x) => x.route.includes('/300/attempts/2')));
  assert(!f.calls.some((x) => x.route.includes('/299/')));
});
test('RC security failed run-list read refuses without polling or another route', async () => {
  const f = fixture(),
    api = f.api;
  let attempts = 0;
  f.api = async (...args) => {
    if (args[1].includes('/runs?')) {
      attempts++;
      throw Object.assign(new Error('private'), { status: 500 });
    }
    return api(...args);
  };
  await assert.rejects(() => runtime.requireSecurity(f.api, f.identity));
  assert.equal(attempts, 1);
});

test('RC security selects only same-repository push runs on this main source', async () => {
  const f = fixture();
  f.runs.unshift({ ...f.runs[0], id: 999, head_repository: { id: 999, full_name: 'fork/repo' } });
  assert.deepEqual(await runtime.requireSecurity(f.api, f.identity), { runId: 300, attempt: 2 });
});
