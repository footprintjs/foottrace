import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { proposalApiFixture, sha } from './helpers.mjs';
const require = createRequire(import.meta.url);
const runtime = require('../../scripts/release-github.cjs');
const control = require('../../scripts/release-control.cjs');

// Main moving under an open App proposal: the route rebuilds that proposal on the
// new main, or refuses with a named code. All GitHub state here is synthetic.
const LATER = '---\ntype: fixed\nbump: patch\n---\n\n- Later fix merged while the proposal waited.\n';
async function propose(f) {
  const pinned = await runtime.plan(f.api, f.context, f.options);
  const payload = await runtime.prepareProposal(f.api, f.context, pinned, f.options);
  return { pinned, payload, result: await runtime.writeProposal(f.api, f.context, payload, pinned, f.options) };
}
function addFile(f, path, text) {
  const row = f.makeInventory({ [path]: text }).get(path);
  return f.advance((inventory) => inventory.set(path, row));
}
const writes = (f) => f.calls.filter((c) => c.method !== 'GET');
const openPR = (f) => f.pulls.find((p) => p.state === 'open');
// An open proposal built on the first main, then one ordinary merge to main.
async function movedFixture() {
  const f = proposalApiFixture();
  const first = await propose(f);
  assert.equal(first.result.action, 'created');
  const oldBase = f.context.sha, oldHead = f.tip;
  addFile(f, '.changes/later-fix.md', LATER);
  return { f, first, oldBase, oldHead };
}

test('an open App proposal one merge behind main is rebuilt on the new main', async () => {
  const { f, first, oldBase, oldHead } = await movedFixture();
  const before = writes(f).length;
  const { pinned, payload, result } = await propose(f);
  assert.equal(result.action, 'rebuilt');
  assert.equal(result.pr, first.result.pr, 'The same PR carries the rebuilt head');
  const made = writes(f).slice(before);
  assert(made.every((c) => !c.route.endsWith('/pulls') || c.method !== 'POST'), 'No second release PR');
  assert(made.every((c) => !/\/(?:reviews|merges?|dispatches)(?:$|[/?])/.test(c.route)));
  const commit = made.find((c) => c.route.endsWith('/git/commits'));
  assert.deepEqual(commit.body.parents, [f.context.sha, oldHead], 'Parent is the new main; the old head stays reachable');
  assert.notEqual(f.context.sha, oldBase);
  const ref = made.filter((c) => c.method === 'PATCH' && c.route.endsWith('/git/refs/heads/release/next'));
  assert.equal(ref.length, 1);
  assert.equal(ref[0].body.force, false);
  assert.equal(f.tip, result.head);
  // The tree is exactly what the runner computes on the new main.
  assert.equal(f.commits.get(result.head).tree.sha, result.tree);
  const tree = f.trees.get(result.tree);
  assert(![...tree.keys()].some((path) => path.startsWith('.changes/') && path !== '.changes/README.md'));
  assert.match(tree.get('CHANGELOG.md').bytes.toString(), /Later fix merged while the proposal waited/);
  assert.equal(JSON.parse(tree.get('package.json').bytes).version, pinned.version);
  const pr = openPR(f);
  assert.equal(pr.head.sha, result.head);
  assert.equal(pr.title, `Release ${pinned.version}`);
  assert(pr.body.startsWith(`Release App proposal for foottrace ${pinned.version}.\n\n${payload.prepared.notes}\n`));
  // A later run on the same main is a read-only no-op, even with a stale PR base.
  assert.equal(pr.base.sha, oldBase);
  const settled = writes(f).length;
  assert.equal((await propose(f)).result.action, 'no-op');
  assert.equal(writes(f).length, settled);
});

test('a rebuilt proposal rebuilds again, then merges and rolls over normally', async () => {
  const { f } = await movedFixture();
  const second = await propose(f);
  assert.equal(second.result.action, 'rebuilt');
  addFile(f, 'docs/later.md', 'Later documentation.\n');
  const third = await propose(f);
  assert.equal(third.result.action, 'rebuilt');
  assert.deepEqual(f.commits.get(third.result.head).parents.map((p) => p.sha), [f.context.sha, second.result.head]);
  f.merge();
  assert.equal((await runtime.plan(f.api, f.context, f.options)).mode, 'publish');
  f.publish(f.context.sha);
  addFile(f, '.changes/after.md', LATER);
  const next = await propose(f);
  assert.equal(next.result.action, 'created');
  assert.deepEqual(f.commits.get(next.result.head).parents.map((p) => p.sha), [f.context.sha, third.result.head]);
});

for (const [name, code, mutate] of [
  ['a proposal the App did not author', 'proposal-author', (f) => {
    openPR(f).user = { id: 7, login: 'someone', type: 'User' };
  }],
  ['a head pushed by hand', 'proposal-head', (f, { oldHead }) => {
    const head = f.commits.get(oldHead), inventory = new Map(f.trees.get(head.tree.sha));
    inventory.set('src/extra.ts', f.makeInventory({ 'src/extra.ts': 'export const extra = true;\n' }).get('src/extra.ts'));
    const pushed = f.addCommit(inventory, head.parents.map((p) => p.sha));
    f.tip = pushed; openPR(f).head = { ...openPR(f).head, sha: pushed };
  }],
  ['a head whose second parent is not an App merge or generation', 'proposal-head', (f, { oldBase, oldHead }) => {
    const head = f.commits.get(oldHead), stray = f.addCommit(f.files, [oldBase]);
    const pushed = f.addCommit(null, [oldBase, stray], head.tree.sha);
    f.tip = pushed; openPR(f).head = { ...openPR(f).head, sha: pushed };
  }],
  ['an Approve review on the older head', 'proposal-approved', (f, { oldHead }) => {
    openPR(f).reviews = [{ id: 1, state: 'APPROVED', commit_id: oldHead, user: { id: 8, login: 'reviewer', type: 'User' } }];
  }],
  ['a recorded base outside main history', 'proposal-base-moved', (f) => {
    openPR(f).base = { ...openPR(f).base, sha: f.addCommit({ 'src/index.ts': 'diverged\n' }, []) };
  }],
  ['a head built on a base outside main history', 'proposal-base-moved', (f, { oldHead }) => {
    const head = f.commits.get(oldHead), diverged = f.addCommit({ 'src/index.ts': 'diverged\n' }, []);
    const pushed = f.addCommit(null, [diverged, head.parents[1].sha], head.tree.sha);
    f.tip = pushed; openPR(f).head = { ...openPR(f).head, sha: pushed };
  }],
]) test(`main moved under ${name}: refused as ${code} before any write`, async () => {
  const fixture = await movedFixture(), { f } = fixture;
  mutate(f, fixture);
  const before = writes(f).length;
  const pinned = await runtime.plan(f.api, f.context, f.options);
  const payload = await runtime.prepareProposal(f.api, f.context, pinned, f.options);
  await assert.rejects(() => runtime.writeProposal(f.api, f.context, payload, pinned, f.options), { code });
  assert.equal(writes(f).length, before);
});

test('decision: a rebuild needs every piece of evidence and never forces', () => {
  const world = (patch = {}) => ({
    base: sha('1'), currentMain: sha('1'), expectedTree: sha('3'), complete: true,
    existing: { head: sha('4'), tree: sha('6'), parents: [sha('5'), sha('7')] },
    pulls: [{ state: 'open', head: { sha: sha('4') }, base: { ref: 'main' } }],
    predecessor: { head: sha('7'), closedMerged: true },
    rebuild: { authored: true, accounted: true, approved: false }, ...patch,
  });
  assert.deepEqual(control.decideProposalState(world()), { action: 'rebuild', force: false, parents: [sha('1'), sha('4')] });
  for (const patch of [
    { rebuild: { authored: false, accounted: true, approved: false } },
    { rebuild: { authored: true, accounted: false, approved: false } },
    { rebuild: { authored: true, accounted: true, approved: true } },
    { rebuild: null },
    { existing: { head: sha('4'), tree: sha('6'), parents: [sha('1'), sha('7')] } },
    { pulls: [{ state: 'open', head: { sha: sha('8') }, base: { ref: 'main' } }] },
    { pulls: [] },
    { currentMain: sha('2') },
    { prior: sha('9') },
  ]) assert.equal(control.decideProposalState(world(patch)).action, 'hold', JSON.stringify(patch));
});
