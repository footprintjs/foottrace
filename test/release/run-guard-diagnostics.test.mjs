import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const runtime = require('../../scripts/release-github.cjs');
const privateValue = 'SYNTHETIC_PRIVATE_VALUE\n::error::not-a-diagnostic';
const sha = 'a'.repeat(40);

function fixture() {
  const repository = { id: 11, full_name: 'footprintjs/foottrace' };
  const context = {
    repository,
    sha,
    ref: 'refs/heads/main',
    eventName: 'push',
    runId: 200,
    runAttempt: 2,
  };
  const run = {
    id: 200,
    run_attempt: 2,
    head_sha: sha,
    repository: { ...repository },
    head_repository: { ...repository },
    path: '.github/workflows/publish.yml',
    head_branch: 'main',
    event: 'push',
    status: 'in_progress',
    conclusion: null,
  };
  const job = {
    id: 300,
    name: 'prepare',
    run_id: 200,
    run_attempt: 2,
    head_sha: sha,
    status: 'in_progress',
    conclusion: null,
  };
  const calls = [];
  const api = async (method, route) => {
    calls.push({ method, route });
    assert.equal(method, 'GET');
    if (route === '/repos/footprintjs/foottrace/actions/runs/200') return { data: run };
    assert(route.startsWith('/repos/footprintjs/foottrace/actions/runs/200/attempts/2/jobs?'));
    return { data: { total_count: 1, jobs: [job] } };
  };
  return { context, run, job, calls, api };
}

const refusals = [
  [
    'id',
    (f) => {
      f.run.id = 201;
    },
  ],
  [
    'attempt',
    (f) => {
      f.run.run_attempt = 1;
    },
  ],
  [
    'sha',
    (f) => {
      f.run.head_sha = privateValue;
    },
  ],
  [
    'repository',
    (f) => {
      f.run.repository = { id: 12, full_name: privateValue };
    },
  ],
  [
    'head-repository',
    (f) => {
      f.run.head_repository = { id: 12, full_name: privateValue };
    },
  ],
  [
    'workflow',
    (f) => {
      f.run.path = privateValue;
    },
  ],
  [
    'branch',
    (f) => {
      f.run.head_branch = privateValue;
    },
  ],
  [
    'event',
    (f) => {
      f.run.event = 'workflow_dispatch';
    },
  ],
  [
    'ref',
    (f) => {
      f.context.ref = privateValue;
    },
  ],
  [
    'trigger',
    (f) => {
      f.run.event = f.context.eventName = 'pull_request';
    },
  ],
  [
    'status',
    (f) => {
      f.run.status = 'queued';
    },
  ],
  [
    'conclusion',
    (f) => {
      f.run.conclusion = privateValue;
    },
  ],
];

async function refuses(f, label) {
  await assert.rejects(
    () => runtime.withRefusal('runner-prepare', () => runtime.producerIdentity(f.api, f.context, 'prepare')),
    (error) => {
      assert.equal(error.code, label);
      assert.equal(error.message, label);
      assert.equal(runtime.refusalCode(error), label);
      assert(!runtime.refusalCode(error).includes(privateValue));
      return true;
    },
  );
  assert.deepEqual(f.calls, [{ method: 'GET', route: '/repos/footprintjs/foottrace/actions/runs/200' }]);
}

for (const [field, edit] of refusals)
  test(`current-run refusal names only the fixed ${field} predicate`, async () => {
    const f = fixture();
    edit(f);
    await refuses(f, `current-run-${field}`);
  });

test('run guard preserves first-failure order without reading later fields', async () => {
  const f = fixture();
  f.run.id = 201;
  let reads = 0;
  Object.defineProperty(f.run, 'run_attempt', {
    get() {
      reads++;
      throw Error(privateValue);
    },
  });
  await refuses(f, 'current-run-id');
  assert.equal(reads, 0);
});

test('status refusal reads once and does not inspect conclusion afterward', async () => {
  const f = fixture();
  let statusReads = 0,
    conclusionReads = 0;
  Object.defineProperty(f.run, 'status', {
    get() {
      statusReads++;
      return 'queued';
    },
  });
  Object.defineProperty(f.run, 'conclusion', {
    get() {
      conclusionReads++;
      throw Error(privateValue);
    },
  });
  await refuses(f, 'current-run-status');
  assert.equal(statusReads, 1);
  assert.equal(conclusionReads, 0);
});

for (const field of ['status', 'conclusion'])
  test(`absent ${field} remains a refusal before any jobs request`, async () => {
    const f = fixture();
    delete f.run[field];
    await refuses(f, `current-run-${field}`);
  });

for (const field of ['repository', 'head_repository'])
  for (const value of [null, { id: '11', full_name: 'footprintjs/foottrace' }, { id: 11, full_name: privateValue }])
    test(`${field} identity remains fail-closed without exposing its values`, async () => {
      const f = fixture();
      f.run[field] = value;
      await refuses(f, field === 'repository' ? 'current-run-repository' : 'current-run-head-repository');
    });

for (const event of ['push', 'workflow_dispatch'])
  test(`valid ${event} producer uses the original run and jobs requests once`, async () => {
    const f = fixture();
    f.run.event = f.context.eventName = event;
    assert.equal(await runtime.producerIdentity(f.api, f.context, 'prepare'), f.job);
    assert.equal(f.calls.length, 2);
  });

test('completed producer requirement remains unchanged', async () => {
  const f = fixture();
  await assert.rejects(() => runtime.producerIdentity(f.api, f.context, 'prepare', true), /producer-attempt/);
  assert.equal(f.calls.length, 2);
  f.job.status = 'completed';
  f.job.conclusion = 'success';
  assert.equal(await runtime.producerIdentity(f.api, f.context, 'prepare', true), f.job);
  assert.equal(f.calls.length, 4);
});

test('legacy current-run stays printable and unknown derived labels stay closed', () => {
  assert.equal(runtime.refusalCode({ code: 'current-run' }), 'current-run');
  assert.equal(runtime.refusalCode({ code: 'current-run-' + privateValue }), 'release-unexpected');
  let reads = 0;
  assert.equal(
    runtime.refusalCode(
      Object.defineProperty({}, 'code', {
        get() {
          reads++;
          return 'current-run-status';
        },
      }),
    ),
    'release-unexpected',
  );
  assert.equal(reads, 0);
});
