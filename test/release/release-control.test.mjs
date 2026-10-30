import test from 'node:test';
import assert from 'node:assert/strict';
import { call, authorityWorld, ciWorld, sha } from './helpers.mjs';

test('authority: exact reviewed normal release merge is admissible', () => {
  const result = call('release-control', 'decideAuthority', authorityWorld());
  assert.equal(result.authorized, true);
  assert.equal(result.identity.mergeSha, sha('1'));
  assert.equal(result.identity.headSha, sha('2'));
});
const authorityNegatives = [
  [
    'manual GitHub release trigger',
    (w) => {
      w.event.name = 'release';
    },
  ],
  [
    'foreign event repository',
    (w) => {
      w.event.repository = { id: 999, full_name: 'other/foottrace' };
    },
  ],
  [
    'wrong published commit',
    (w) => {
      w.commit.sha = sha('4');
    },
  ],
  [
    'wrong published tree',
    (w) => {
      w.commit.tree.sha = sha('4');
    },
  ],
  [
    'head-tree mismatch from changed base',
    (w) => {
      w.headCommit.tree.sha = sha('4');
    },
  ],
  [
    'missing independently fetched head commit',
    (w) => {
      delete w.headCommit;
    },
  ],
  [
    'wrong App author',
    (w) => {
      w.pulls[0].user = { id: 100, login: 'other[bot]', type: 'Bot' };
    },
  ],
  [
    'App client ID mismatch',
    (w) => {
      w.app.metadata.client_id = 'other';
    },
  ],
  [
    'unmerged PR',
    (w) => {
      w.pulls[0].merged_at = null;
    },
  ],
  [
    'foreign head repository',
    (w) => {
      w.pulls[0].head.repo = { id: 999, full_name: 'other/foottrace' };
    },
  ],
  [
    'wrong base',
    (w) => {
      w.pulls[0].base.ref = 'next';
    },
  ],
  [
    'ordinary branch',
    (w) => {
      w.pulls[0].head.ref = 'fix/anything';
    },
  ],
  [
    'different final head',
    (w) => {
      w.pulls[0].head.sha = sha('4');
    },
  ],
  [
    'different merge',
    (w) => {
      w.pulls[0].merge_commit_sha = sha('4');
    },
  ],
  [
    'ambiguous release PRs',
    (w) => {
      w.pulls.push({ ...w.pulls[0], number: 101 });
    },
  ],
  [
    'partial PR page',
    (w) => {
      w.pullsComplete = false;
    },
  ],
  [
    'partial review page',
    (w) => {
      w.reviewsComplete = false;
    },
  ],
  [
    'unavailable reviewer permissions',
    (w) => {
      w.permissionsComplete = false;
    },
  ],
  [
    'owner association without current write permission',
    (w) => {
      w.reviewerPermissions[0].permission = 'read';
    },
  ],
  [
    'permission belongs to another user ID',
    (w) => {
      w.reviewerPermissions[0].user.id = 10;
    },
  ],
  [
    'no approving review',
    (w) => {
      w.reviews = [];
    },
  ],
  [
    'approval for older head',
    (w) => {
      w.reviews[0].commit_id = sha('4');
    },
  ],
  [
    'dismissed approval',
    (w) => {
      w.reviews[0].state = 'DISMISSED';
    },
  ],
  [
    'self approval',
    (w) => {
      w.reviews[0].user = w.pulls[0].user;
    },
  ],
  [
    'later requested changes',
    (w) => {
      w.reviews.push({ ...w.reviews[0], id: 11, state: 'CHANGES_REQUESTED', submitted_at: '2026-10-29T23:30:00Z' });
    },
  ],
];
for (const [name, change] of authorityNegatives)
  test(`authority holds: ${name}`, () => {
    const world = authorityWorld();
    change(world);
    const result = call('release-control', 'decideAuthority', world);
    assert.equal(result.authorized, false);
    assert.equal(result.mode, 'hold');
  });
test('fast path: complete latest-attempt proof matches the release tree', () => {
  assert.equal(call('release-control', 'decideCiReuse', ciWorld()).tested, true);
});
const reuseNegatives = [
  [
    'foreign workflow ID',
    (w) => {
      w.runs[0].workflow_id = 43;
    },
  ],
  [
    'same display name but wrong path',
    (w) => {
      w.runs[0].path = '.github/workflows/untrusted.yml';
    },
  ],
  [
    'foreign repository',
    (w) => {
      w.runs[0].head_repository = { id: 999, full_name: 'other/foottrace' };
    },
  ],
  [
    'wrong event',
    (w) => {
      w.runs[0].event = 'workflow_dispatch';
    },
  ],
  [
    'wrong head',
    (w) => {
      w.runs[0].head_sha = sha('4');
    },
  ],
  [
    'newer failed run',
    (w) => {
      w.runs.push({ ...w.runs[0], id: 201, conclusion: 'failure' });
    },
  ],
  [
    'latest attempt pending',
    (w) => {
      w.attempt = { ...w.attempt, status: 'in_progress', conclusion: null };
    },
  ],
  [
    'old attempt jobs',
    (w) => {
      w.jobs.forEach((j) => (j.run_attempt = 1));
    },
  ],
  [
    'partial run page',
    (w) => {
      w.runsComplete = false;
    },
  ],
  [
    'partial job page',
    (w) => {
      w.jobsComplete = false;
    },
  ],
  [
    'missing runtime gate',
    (w) => {
      w.jobs.splice(0, 1);
    },
  ],
  [
    'duplicate runtime gate',
    (w) => {
      w.jobs.push({ ...w.jobs[0], id: 4 });
    },
  ],
  [
    'skipped runtime gate',
    (w) => {
      w.jobs[0].conclusion = 'skipped';
    },
  ],
  [
    'failed runtime gate',
    (w) => {
      w.jobs[1].conclusion = 'failure';
    },
  ],
  [
    'wrong tree',
    (w) => {
      w.jobs[2].steps[0].name = `tested tree ${sha('4')}`;
    },
  ],
  [
    'two tree markers',
    (w) => {
      w.jobs[2].steps.push({ name: `tested tree ${sha('4')}`, conclusion: 'success' });
    },
  ],
  [
    'missing tree job',
    (w) => {
      w.jobs.pop();
    },
  ],
];
for (const [name, change] of reuseNegatives)
  test(`fast path declines: ${name}`, () => {
    const world = ciWorld();
    change(world);
    const result = call('release-control', 'decideCiReuse', world);
    assert.equal(result.tested, false);
    assert.equal(result.fallback, 'both-full-runtime-gates');
  });

test('proposal: different existing head never becomes overwrite authority', () => {
  const result = call('release-control', 'decideProposalState', {
    base: sha('1'),
    currentMain: sha('1'),
    expectedTree: sha('3'),
    existing: { head: sha('4'), parent: sha('5'), tree: sha('6') },
    pulls: [],
    complete: true,
  });
  assert.equal(result.action, 'hold');
  assert.equal(result.force, false);
});
test('proposal: moved main holds before any write', () => {
  assert.equal(
    call('release-control', 'decideProposalState', {
      base: sha('1'),
      currentMain: sha('4'),
      expectedTree: sha('3'),
      existing: null,
      pulls: [],
      complete: true,
    }).action,
    'hold',
  );
});
test('publish journal: an earlier reservation only permits verification', () => {
  const result = call('release-control', 'decideSubmission', {
    journal: { runId: 1, attempt: 1, sha: sha('1'), integrity: 'sha512-recorded' },
    registry: null,
    expected: { sha: sha('1'), integrity: 'sha512-recorded' },
  });
  assert.equal(result.action, 'verify-only');
  assert.equal(result.mayPublish, false);
});
test('registry: an existing version with different bytes holds', () => {
  assert.equal(
    call('release-control', 'decideSubmission', {
      journal: null,
      registry: { integrity: 'sha512-other' },
      expected: { sha: sha('1'), integrity: 'sha512-recorded' },
    }).action,
    'hold',
  );
});
test('adapter: complete pagination rejects duplicate IDs and truncated evidence', async () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
  let count = 0;
  const api = async () => ({ data: count++ === 0 ? rows : [] });
  const result = await call('release-github', 'pages', api, '/repos/footprintjs/foottrace/pulls');
  assert.equal(result.length, 100);
  assert.equal(count, 2);
  await assert.rejects(
    () => call('release-github', 'pages', async () => ({ data: rows }), '/repos/footprintjs/foottrace/pulls'),
    /incomplete-pages/,
  );
});
test('adapter: wrong main event is rejected before a write or artifact download', async () => {
  const calls = [];
  const api = async (method, path) => {
    calls.push([method, path]);
    return { data: { object: { sha: sha('4') } } };
  };
  await assert.rejects(
    () =>
      call('release-github', 'assertCurrentMain', api, {
        repository: { id: 123, full_name: 'footprintjs/foottrace' },
        sha: sha('1'),
      }),
    /main-moved/,
  );
  assert.deepEqual(calls, [['GET', '/repos/footprintjs/foottrace/git/ref/heads/main']]);
});
test('adapter: a failed reservation never grants submission and is never deleted', async () => {
  const calls = [];
  const api = async (method, path) => {
    calls.push([method, path]);
    throw new Error('ambiguous-upload');
  };
  await assert.rejects(
    () =>
      call(
        'release-github',
        'reserveAttempt',
        api,
        { upload_url: 'https://uploads.github.com/repos/footprintjs/foottrace/releases/123/assets{?name,label}' },
        { version: '1.9.0', runId: 200, runAttempt: 2, sha: sha('1'), integrity: 'sha512-recorded' },
      ),
    /ambiguous-upload/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'POST');
  assert(calls.every((c) => c[0] !== 'DELETE'));
});
test('proposal writer refuses a substituted payload before every Git write', async () => {
  const calls = [];
  const api = async (method, path) => {
    calls.push([method, path]);
    if (method === 'GET' && path.endsWith('/git/ref/heads/main')) return { data: { object: { sha: sha('1') } } };
    throw new Error('unexpected-read');
  };
  await assert.rejects(
    () =>
      call(
        'release-github',
        'writeProposal',
        api,
        { repository: { id: 123, full_name: 'footprintjs/foottrace' }, sha: sha('1') },
        { base: sha('4') },
        {},
      ),
    /proposal-base/,
  );
  assert(calls.every((c) => c[0] === 'GET'));
});
test('publisher grant requires a fresh same-run writer and exact marker bytes', () => {
  const expected = { version: '1.9.0', runId: 200, runAttempt: 2, sha: sha('1'), integrity: 'sha512-checked' };
  assert.equal(
    call('release-control', 'validatePublishGrant', {
      expected,
      marker: expected,
      grant: { fresh: true, runId: 200, runAttempt: 2, assetId: 9 },
    }).mayPublish,
    true,
  );
  for (const patch of [{ fresh: false }, { runAttempt: 1 }, { runId: 199 }, { assetId: null }])
    assert.equal(
      call('release-control', 'validatePublishGrant', {
        expected,
        marker: expected,
        grant: { fresh: true, runId: 200, runAttempt: 2, assetId: 9, ...patch },
      }).mayPublish,
      false,
    );
  assert.equal(
    call('release-control', 'validatePublishGrant', {
      expected,
      marker: { ...expected, integrity: 'sha512-other' },
      grant: { fresh: true, runId: 200, runAttempt: 2, assetId: 9 },
    }).mayPublish,
    false,
  );
});
import { authorityApiFixture } from './helpers.mjs';
test('actual API collection binds App, permission, head tree, reviews and both security jobs', async () => {
  const f = authorityApiFixture();
  const id = await call('release-github', 'collectAuthority', f.api, f.context, f.settings);
  assert.deepEqual(id, f.w.expected);
  await call('release-github', 'requireSecurity', f.api, id);
  assert(f.calls.some((c) => c.route.endsWith('/collaborators/reviewer/permission')));
  assert.equal(f.calls.filter((c) => c.route === '/repos/footprintjs/foottrace/pulls/100').length, 2);
});
for (const [name, change] of [
  ['permission refused', (f) => (f.w.reviewerPermissions[0].permission = 'read')],
  ['head has another tree', (f) => (f.w.headCommit.tree.sha = sha('4'))],
  ['configured App differs', (f) => (f.w.app.metadata.client_id = 'other')],
])
  test(`actual authority adapter holds: ${name}`, async () => {
    const f = authorityApiFixture();
    change(f);
    await assert.rejects(() => call('release-github', 'collectAuthority', f.api, f.context, f.settings), /authority-/);
    assert(f.calls.every((c) => c.method === 'GET'));
  });
test('actual security adapter never turns a skipped language into test fallback', async () => {
  const f = authorityApiFixture();
  f.jobs[0].conclusion = 'skipped';
  await assert.rejects(() => call('release-github', 'requireSecurity', f.api, f.w.expected), /security-job/);
});
test('actual CI adapter declines older producer evidence and API errors', async () => {
  const f = authorityApiFixture();
  assert.equal((await call('release-github', 'ciVerdict', f.api, f.w.expected)).tested, true);
  f.ci.jobs[0].run_attempt = 1;
  assert.equal((await call('release-github', 'ciVerdict', f.api, f.w.expected)).tested, false);
  assert.equal(
    (
      await call(
        'release-github',
        'ciVerdict',
        async () => {
          throw new Error('offline');
        },
        f.w.expected,
      )
    ).tested,
    false,
  );
});
test('security: foreign head/repository/event evidence holds even with successful jobs', async () => {
  for (const mutate of [
    (f) => (f.q.head_sha = sha('4')),
    (f) => (f.q.head_repository = { id: 999, full_name: 'other/repo' }),
    (f) => (f.q.event = 'workflow_dispatch'),
  ]) {
    const f = authorityApiFixture();
    mutate(f);
    await assert.rejects(() => call('release-github', 'requireSecurity', f.api, f.w.expected), /security-/);
  }
});
test('binary asset download remains bytes even when its file content type is JSON', async () => {
  const fetcher = async () => new Response('{"sha":"proof"}', { headers: { 'content-type': 'application/json' } });
  const api = call('release-github', 'makeApi', 'offline-test-token', fetcher);
  const result = await api('GET', '/repos/footprintjs/foottrace/releases/assets/42', {
    accept: 'application/octet-stream',
  });
  assert(Buffer.isBuffer(result.data));
  assert.equal(result.data.toString(), '{"sha":"proof"}');
});
test('API calls never forward arbitrary destinations or retry a failed write', async () => {
  let calls = 0;
  const api = call('release-github', 'makeApi', 'offline-test-token', async () => {
    calls++;
    return new Response('no', { status: 500 });
  });
  await assert.rejects(() => api('POST', 'https://example.invalid/collect', { raw: Buffer.from('x') }), /api-route/);
  assert.equal(calls, 0);
  await assert.rejects(
    () => api('POST', '/repos/footprintjs/foottrace/git/refs', { ref: 'refs/tags/v1.9.0', sha: sha('1') }),
    /github-api-failed/,
  );
  assert.equal(calls, 1);
});
import { proposalApiFixture } from './helpers.mjs';
test('actual proposal path recomputes notes and creates only a normal App branch/PR', async () => {
  const f = proposalApiFixture();
  const plan = await call('release-github', 'plan', f.api, f.context);
  assert.equal(plan.mode, 'prepare');
  assert.equal(plan.version, '1.9.0');
  const payload = await call('release-github', 'prepareProposal', f.api, f.context, plan);
  const result = await call('release-github', 'writeProposal', f.api, f.context, payload, plan);
  assert.equal(result.action, 'created');
  const writes = f.calls.filter((c) => c.method !== 'GET');
  assert(writes.every((c) => c.method === 'POST'));
  assert.equal(writes.filter((c) => c.route.endsWith('/git/refs')).length, 1);
  const commit = writes.find((c) => c.route.endsWith('/git/commits'));
  assert.deepEqual(commit.body.parents, [f.context.sha]);
  const tree = writes.find((c) => c.route.endsWith('/git/trees'));
  assert.equal(tree.body.base_tree, plan.tree);
  assert(tree.body.tree.some((r) => r.path === '.changes/metadata-query.md' && r.sha === null));
  assert.deepEqual(
    tree.body.tree.map((r) => r.path).sort(),
    [
      '.changes/metadata-query.md',
      'CHANGELOG.md',
      'README.md',
      'docs/metadata.md',
      'package-lock.json',
      'package.json',
    ].sort(),
  );
  assert.equal((await call('release-github', 'writeProposal', f.api, f.context, payload, plan)).action, 'no-op');
  assert.equal(f.calls.filter((c) => c.route.endsWith('/git/refs') && c.method === 'POST').length, 1);
});
test('actual proposal payload substitution is refused before the first API mutation', async () => {
  const f = proposalApiFixture(),
    p = await call('release-github', 'plan', f.api, f.context),
    payload = await call('release-github', 'prepareProposal', f.api, f.context, p);
  payload.prepared.updates['.github/workflows/ci.yml'] = 'bad';
  await assert.rejects(
    () => call('release-github', 'writeProposal', f.api, f.context, payload, p),
    /proposal-substitution/,
  );
  assert(f.calls.every((c) => c.method === 'GET'));
});
test('actual proposal path stops on main moving after preparation', async () => {
  const f = proposalApiFixture(),
    p = await call('release-github', 'plan', f.api, f.context),
    payload = await call('release-github', 'prepareProposal', f.api, f.context, p);
  f.moveMain();
  await assert.rejects(() => call('release-github', 'writeProposal', f.api, f.context, payload, p), /main-moved/);
  assert(f.calls.every((c) => c.method === 'GET'));
});
test('verify-only refuses pending source rather than inspecting a nonexistent next version', async () => {
  const f = proposalApiFixture();
  await assert.rejects(
    () => call('release-github', 'plan', f.api, { ...f.context, verify: true }),
    /verify-unreleased-main/,
  );
  assert(f.calls.every((c) => c.method === 'GET'));
});
test('producer admission fetches and binds the current workflow run record', async () => {
  const context = {
    repository: { id: 123, full_name: 'footprintjs/foottrace' },
    sha: sha('1'),
    runId: 200,
    runAttempt: 2,
    ref: 'refs/heads/main',
    eventName: 'push',
  };
  const run = {
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
  };
  const job = {
    id: 300,
    name: 'build',
    run_id: 200,
    run_attempt: 2,
    head_sha: context.sha,
    status: 'completed',
    conclusion: 'success',
  };
  const reads = [];
  const api = async (method, route) => {
    reads.push(route);
    return { data: route.endsWith('/actions/runs/200') ? run : { total_count: 1, jobs: [job] } };
  };
  await call('release-github', 'producerIdentity', api, context, 'build', true);
  assert(reads.includes('/repos/footprintjs/foottrace/actions/runs/200'));
  for (const [key, value] of [
    ['run_attempt', 1],
    ['head_sha', sha('4')],
    ['path', '.github/workflows/other.yml'],
    ['repository', { id: 999, full_name: 'other/repo' }],
  ]) {
    const old = run[key];
    run[key] = value;
    await assert.rejects(() => call('release-github', 'producerIdentity', api, context, 'build', true), /current-run/);
    run[key] = old;
  }
});
test('workflow outputs are admitted as one bounded UTF-16 block before any write', () => {
  assert.equal(
    call('release-control', 'outputLines', { tested: 'true', identity: '{}' }),
    'tested=true\nidentity={}\n',
  );
  assert.throws(() => call('release-control', 'outputLines', { identity: 'x'.repeat(32768) }), /output-limit/);
  assert.throws(() => call('release-control', 'outputLines', { identity: 'safe\ninjected=true' }), /output-shape/);
});
for (const permission of ['write', 'admin'])
  test(`real approval accepts exact current permission ${permission}`, () => {
    const w = authorityWorld();
    w.reviewerPermissions[0].permission = permission;
    assert.equal(call('release-control', 'decideAuthority', w).authorized, true);
  });
for (const [name, edit] of [
  [
    'ordinary review comment',
    (w) => {
      w.reviews[0].state = 'COMMENTED';
      w.reviews[0].body = 'Verdict: merge';
    },
  ],
  [
    'raw role name instead of allowed base permission',
    (w) => {
      w.reviewerPermissions[0].permission = 'maintain';
    },
  ],
  [
    'permission login mismatch',
    (w) => {
      w.reviewerPermissions[0].user.login = 'different-user';
    },
  ],
])
  test(`real approval refuses ${name}`, () => {
    const w = authorityWorld();
    edit(w);
    assert.equal(call('release-control', 'decideAuthority', w).authorized, false);
  });
