import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { managedReleaseFixture, proposalApiFixture, sha } from './helpers.mjs';
const require = createRequire(import.meta.url);
const runtime = require('../../scripts/release-github.cjs');
const control = require('../../scripts/release-control.cjs');

// A proposal write that moved `release/next` and stopped before its pull request:
// the stop carries its own name, and a later run takes the head up only when it is
// exactly the runner's own build. All GitHub state here is synthetic.
const LATER = '---\ntype: fixed\nbump: patch\n---\n\n- Later fix merged while the proposal waited.\n';
const REF = '/git/ref/heads/release/next', UPDATE = '/git/refs/heads/release/next';
async function prepared(f) {
  const pinned = await runtime.plan(f.api, f.context, f.options);
  return { pinned, payload: await runtime.prepareProposal(f.api, f.context, pinned, f.options) };
}
async function propose(f, api = f.api, options = f.options) {
  const { pinned, payload } = await prepared(f);
  return { pinned, payload, result: await runtime.writeProposal(api, f.context, payload, pinned, options) };
}
function addFile(f, path, text) {
  const row = f.makeInventory({ [path]: text }).get(path);
  return f.advance((inventory) => inventory.set(path, row));
}
const writes = (f) => f.calls.filter((c) => c.method !== 'GET');
const openPR = (f) => f.pulls.find((p) => p.state === 'open');
const parentsOf = (f, id) => f.commits.get(id).parents.map((p) => p.sha);
// The update is applied, but the first `stale` reads of the branch after it answer something else:
// by default the head from before the update. Waits are recorded, never slept.
function readsAfterUpdate(f, stale = Infinity, answer = f.tip) {
  const seen = { updates: 0, reads: 0, waits: [] };
  const api = async (method, route, body) => {
    const reply = await f.api(method, route, body);
    if (method === 'PATCH' && route.endsWith(UPDATE)) seen.updates++;
    else if (seen.updates && method === 'GET' && route.endsWith(REF) && seen.reads++ < stale)
      return { data: { object: { type: 'commit', sha: answer } } };
    return reply;
  };
  return { api, seen, options: { ...f.options, wait: async (ms) => { seen.waits.push(ms); } } };
}
async function stopBeforePullRequest(f) {
  const { api, seen, options } = readsAfterUpdate(f);
  await assert.rejects(() => propose(f, api, options), { code: 'proposal-ref-readback' });
  return seen;
}
// One unfinished proposal: its head is on the branch and no pull request names it.
async function unfinishedFixture() {
  const f = proposalApiFixture(), retained = f.tip, main = f.context.sha;
  await stopBeforePullRequest(f);
  const head = f.tip;
  assert.notEqual(head, retained);
  assert.equal(openPR(f), undefined);
  return { f, head, main, retained };
}

test('an update whose answer names another commit stops as proposal-ref-write', async () => {
  const f = proposalApiFixture(), retained = f.tip;
  const api = async (method, route, body) => {
    const reply = await f.api(method, route, body);
    return method === 'PATCH' && route.endsWith(UPDATE) ? { data: { object: { type: 'commit', sha: retained } } } : reply;
  };
  await assert.rejects(() => propose(f, api), { code: 'proposal-ref-write' });
  const made = writes(f);
  assert.equal(made.filter((c) => c.method === 'PATCH').length, 1, 'The update is not sent again');
  assert(!made.some((c) => c.route.endsWith('/pulls')), 'No pull request after an unconfirmed update');
  assert.notEqual(f.tip, retained, 'The partial effect stays');
  assert.equal(f.calls.at(-1).method, 'PATCH', 'Nothing is read or written after the refusal');
});

test('a branch that still shows the old head after three reads stops as proposal-ref-readback', async () => {
  const f = proposalApiFixture(), retained = f.tip;
  const seen = await stopBeforePullRequest(f);
  assert.deepEqual(seen, { updates: 1, reads: 3, waits: [1000, 1000] }, 'One update; three reads, one second apart');
  const made = writes(f);
  assert(!made.some((c) => c.route.endsWith('/pulls')), 'No pull request for a head the reads did not show');
  assert(!made.some((c) => c.method === 'DELETE'));
  assert.deepEqual(parentsOf(f, f.tip), [f.context.sha, retained], 'The head stays on the branch');
  assert.equal(f.calls.at(-1).route.endsWith(REF), true, 'Nothing is read or written after the refusal');
});

test('an update that shows on a later read goes on to its pull request', async () => {
  for (const stale of [1, 2]) {
    const f = proposalApiFixture(), { api, seen, options } = readsAfterUpdate(f, stale);
    const { result } = await propose(f, api, options);
    assert.equal(result.action, 'created');
    assert.deepEqual(seen.waits, Array(stale).fill(1000));
    assert.equal(seen.updates, 1);
    assert.equal(openPR(f).head.sha, result.head);
    assert.equal(f.tip, result.head);
  }
});

test('a read that shows another commit is kept: no wait, no second read', async () => {
  const f = proposalApiFixture(), { api, seen, options } = readsAfterUpdate(f, Infinity, sha('e'));
  await assert.rejects(() => propose(f, api, options), { code: 'proposal-ref-readback' });
  assert.deepEqual(seen, { updates: 1, reads: 1, waits: [] });
  assert(!writes(f).some((c) => c.route.endsWith('/pulls')));
});

test('a first read that shows the update never waits', async () => {
  const f = proposalApiFixture(), { api, seen, options } = readsAfterUpdate(f, 0);
  assert.equal((await propose(f, api, options)).result.action, 'created');
  assert.deepEqual(seen.waits, []);
});

test('both stops print their own code at the terminal boundary', () => {
  for (const code of ['proposal-ref-write', 'proposal-ref-readback'])
    assert.equal(runtime.refusalCode(Object.assign(new Error('synthetic'), { code })), code);
});

test('the next run on the same main opens the missing pull request and writes nothing else', async () => {
  const { f, head } = await unfinishedFixture();
  const before = writes(f).length;
  const { pinned, payload, result } = await propose(f);
  assert.deepEqual(result, { action: 'adopted', pr: openPR(f).number, head, tree: f.commits.get(head).tree.sha });
  const made = writes(f).slice(before);
  assert.deepEqual(made.map((c) => [c.method, c.route]), [['POST', '/repos/footprintjs/foottrace/pulls']],
    'No blob, tree, commit or ref update: the head is used as it stands');
  assert.equal(f.tip, head);
  const pr = openPR(f);
  assert.equal(pr.head.sha, head);
  assert.equal(pr.base.sha, f.context.sha);
  assert.deepEqual(pr.user, f.bot);
  assert.equal(made[0].body.title, `Release ${pinned.version}`);
  assert(made[0].body.body.startsWith(`Release App proposal for foottrace ${pinned.version}.\n\n${payload.prepared.notes}\n`));
  // From here it is an ordinary open proposal: a no-op, then a normal merge and publication plan.
  const settled = writes(f).length;
  assert.equal((await propose(f)).result.action, 'no-op');
  assert.equal(writes(f).length, settled);
  f.merge();
  assert.equal((await runtime.plan(f.api, f.context, f.options)).mode, 'publish');
});

test('after main moved, the unfinished head is rebuilt on the new main under a new pull request', async () => {
  const { f, head, main } = await unfinishedFixture();
  addFile(f, '.changes/later-fix.md', LATER);
  const before = writes(f).length;
  const { pinned, result } = await propose(f);
  assert.equal(result.action, 'created');
  assert.notEqual(f.context.sha, main);
  const made = writes(f).slice(before);
  assert.deepEqual(made.find((c) => c.route.endsWith('/git/commits')).body.parents, [f.context.sha, head],
    'Parent is the new main; the unfinished head stays reachable');
  const ref = made.filter((c) => c.method === 'PATCH');
  assert.equal(ref.length, 1);
  assert.equal(ref[0].route.endsWith(UPDATE), true);
  assert.equal(ref[0].body.force, false);
  assert.equal(made.filter((c) => c.method === 'POST' && c.route.endsWith('/pulls')).length, 1, 'Its first pull request');
  assert.equal(f.tip, result.head);
  // The tree is exactly what the runner computes on the new main.
  assert.equal(f.commits.get(result.head).tree.sha, result.tree);
  const tree = f.trees.get(result.tree);
  assert(![...tree.keys()].some((path) => path.startsWith('.changes/') && path !== '.changes/README.md'));
  assert.match(tree.get('CHANGELOG.md').bytes.toString(), /Later fix merged while the proposal waited/);
  assert.equal(JSON.parse(tree.get('package.json').bytes).version, pinned.version);
  const pr = openPR(f);
  assert.equal(pr.head.sha, result.head);
  assert.equal(pr.base.sha, f.context.sha);
  assert.equal((await propose(f)).result.action, 'no-op');
  // It merges, publishes and rolls over like any other proposal.
  f.merge();
  assert.equal((await runtime.plan(f.api, f.context, f.options)).mode, 'publish');
  f.publish(f.context.sha);
  addFile(f, '.changes/after.md', LATER);
  const next = await propose(f);
  assert.equal(next.result.action, 'created');
  assert.deepEqual(parentsOf(f, next.result.head), [f.context.sha, result.head]);
});

test('a rebuild that stops before its pull request is taken up in turn', async () => {
  const { f, head } = await unfinishedFixture();
  addFile(f, '.changes/later-fix.md', LATER);
  await stopBeforePullRequest(f);
  const second = f.tip;
  assert.deepEqual(parentsOf(f, second), [f.context.sha, head]);
  assert.equal(openPR(f), undefined);
  const before = writes(f).length;
  const { result } = await propose(f);
  assert.equal(result.action, 'adopted');
  assert.equal(result.head, second);
  assert.deepEqual(writes(f).slice(before).map((c) => c.method), ['POST']);
  assert.equal(openPR(f).head.sha, second);
});

test('the branch moving between the reads and the pull request stops the take-up before it', async () => {
  const { f, head } = await unfinishedFixture();
  const { pinned, payload } = await prepared(f), before = writes(f).length;
  let reads = 0;
  const api = async (method, route, body) => {
    // The first read of the branch decides; the second is the one just before the pull request.
    if (method === 'GET' && route.endsWith(REF) && ++reads === 2) f.tip = f.addCommit(f.files, [head]);
    return f.api(method, route, body);
  };
  await assert.rejects(() => runtime.writeProposal(api, f.context, payload, pinned, f.options), { code: 'proposal-existing' });
  assert.equal(reads, 2);
  assert.equal(writes(f).length, before, 'No pull request for a branch that is no longer this head');
});

const extra = (f, id) => {
  const inventory = new Map(f.trees.get(f.commits.get(id).tree.sha));
  inventory.set('src/extra.ts', f.makeInventory({ 'src/extra.ts': 'export const extra = true;\n' }).get('src/extra.ts'));
  return inventory;
};
for (const [name, code, mutate] of [
  ['other content on this main', 'proposal-head', (f, { head }) => {
    f.tip = f.addCommit(extra(f, head), parentsOf(f, head));
  }],
  ['one parent', 'proposal-head', (f, { head, main }) => {
    f.tip = f.addCommit(null, [main], f.commits.get(head).tree.sha);
  }],
  ['a second parent that is not an App merge or generation', 'proposal-head', (f, { head, main }) => {
    f.tip = f.addCommit(null, [main, f.addCommit(f.files, [main])], f.commits.get(head).tree.sha);
  }],
  ['other content on an older main', 'proposal-head', (f, { head }) => {
    f.tip = f.addCommit(extra(f, head), parentsOf(f, head));
    addFile(f, '.changes/later-fix.md', LATER);
  }],
  ['a base outside main history', 'proposal-base-moved', (f, { head, retained }) => {
    f.tip = f.addCommit(null, [f.addCommit({ 'src/index.ts': 'diverged\n' }, []), retained], f.commits.get(head).tree.sha);
  }],
  ['a pull request a maintainer closed without merging', 'proposal-existing', (f, { head }) => {
    f.pulls.push({ ...f.originalPR, id: 9002, number: 9002, merged: false, merged_at: null, merge_commit_sha: null,
      head: { ...f.originalPR.head, sha: head } });
  }],
]) test(`a head without an open pull request, with ${name}: refused as ${code} before any write`, async () => {
  const fixture = await unfinishedFixture(), { f } = fixture;
  mutate(f, fixture);
  const { pinned, payload } = await prepared(f), before = writes(f).length;
  await assert.rejects(() => runtime.writeProposal(f.api, f.context, payload, pinned, f.options), { code });
  assert.equal(writes(f).length, before);
  assert.equal(openPR(f), undefined);
});

test('an unfinished recovery proposal keeps its hold', async () => {
  const f = managedReleaseFixture(), { pinned, payload } = await prepared(f);
  assert.equal(pinned.preparationKind, 'recovery');
  const { api, options } = readsAfterUpdate(f);
  await assert.rejects(() => runtime.writeProposal(api, f.context, payload, pinned, options), { code: 'proposal-ref-readback' });
  assert.notEqual(f.tip, f.originalHead);
  const before = writes(f).length;
  await assert.rejects(() => propose(f), { code: 'proposal-existing' });
  assert.equal(writes(f).length, before);
  assert.equal(openPR(f), undefined);
});

test('decision: an unfinished head needs every piece of evidence and never forces', () => {
  const base = sha('1'), merged = sha('7'), head = sha('4'), evidence = { authored: true, accounted: true };
  const world = (patch = {}) => ({
    base, currentMain: base, expectedTree: sha('3'), complete: true, pulls: [],
    predecessor: { head: merged, closedMerged: true }, unfinished: evidence, ...patch,
  });
  const older = { head, tree: sha('6'), parents: [sha('5'), merged] };
  const current = { head, tree: sha('3'), parents: [base, merged] };
  const generation = { head, tree: sha('3'), parents: [base, sha('9')] };
  assert.deepEqual(control.decideProposalState(world({ existing: older })),
    { action: 'adopt-rebuild', force: false, parents: [base, head] });
  assert.deepEqual(control.decideProposalState(world({ existing: current })), { action: 'adopt', force: false });
  assert.deepEqual(control.decideProposalState(world({ existing: generation, prior: sha('9') })), { action: 'adopt', force: false });
  const open = [{ state: 'open', head: { sha: head }, base: { ref: 'main' } }];
  for (const existing of [older, current]) for (const patch of [
    { unfinished: undefined },
    { unfinished: null },
    { unfinished: true },
    { unfinished: { authored: false, accounted: true } },
    { unfinished: { authored: true, accounted: false } },
    { rebuild: { authored: true, accounted: true, approved: false } },
    { pulls: open },
    { currentMain: sha('2') },
    { complete: false },
    { predecessor: { head: merged, closedMerged: false } },
    { existing: { ...existing, head: merged } },
    { existing: { ...existing, parents: [existing.parents[0]] } },
  ]) assert.equal(control.decideProposalState(world({ existing, ...patch })).action, 'hold', JSON.stringify(patch));
  for (const patch of [
    { existing: { ...current, tree: sha('6') } },
    { existing: { ...current, parents: [base, sha('9')] } },
    { existing: generation, prior: merged },
    { existing: generation, prior: 'not-a-commit' },
    { existing: generation, prior: sha('8') },
    { existing: older, prior: sha('9') },
  ]) assert.equal(control.decideProposalState(world(patch)).action, 'hold', JSON.stringify(patch));
});
