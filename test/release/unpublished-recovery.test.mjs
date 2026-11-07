import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { loadReleaseSpecimen, sha } from './helpers.mjs';
const require = createRequire(import.meta.url);
const runner = require('../../scripts/release-runner.cjs');
const preparation = require('../../scripts/release-prepare.cjs');
const runtime = require('../../scripts/release-github.cjs');

// Explicit synthetic managed-release model, derived from immutable specimen data.
// It is not a claim that these IDs or historical reservations existed on GitHub.
function pendingVersionFixture() {
  const repository = { id: 123, full_name: 'footprintjs/foottrace' };
  const M = sha('1'), H = sha('3'), S = sha('5');
  const { files } = loadReleaseSpecimen();
  const pkg = JSON.parse(files['package.json']), lock = JSON.parse(files['package-lock.json']);
  pkg.version = lock.version = lock.packages[''].version = '1.10.0';
  files['package.json'] = JSON.stringify(pkg, null, 2) + '\n';
  files['package-lock.json'] = JSON.stringify(lock, null, 2) + '\n';
  files['CHANGELOG.md'] = '# Changelog\n\n## 1.10.0 — 2026-11-01\n\n### Added\n\n- Existing package contents.\n';
  files['README.md'] = 'Synthetic immutable package README.\n';
  files['docs/metadata.md'] = 'Synthetic immutable metadata documentation.\n';
  files['src/index.ts'] = 'export const existing = true;\n';
  const original = { ...files };
  files['.changes/helper-fix.md'] = '---\ntype: fixed\nbump: patch\n---\n\n- Repair release preparation.\n';
  const blob = (text) => createHash('sha1').update(Buffer.from(`blob ${Buffer.byteLength(text)}\0${text}`)).digest('hex');
  const tree = (values) => Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([path, text]) => ({ path, type: 'blob', mode: '100644', sha: blob(text), size: Buffer.byteLength(text) }));
  const inventory = (values) => new Map(tree(values).map((row) => [row.path, { ...row, bytes: Buffer.from(values[row.path]) }]));
  const TM = preparation.treeOid(inventory(files)), TH = preparation.treeOid(inventory(original));
  const bot = { id: 99, login: 'release-app[bot]', type: 'Bot' };
  const predecessor = { id: 1000, number: 100, state: 'closed', merged: true,
    merged_at: '2026-11-01T00:00:00Z', merge_commit_sha: S, user: bot,
    base: { ref: 'main', sha: sha('6'), repo: repository },
    head: { ref: 'release/next', sha: H, repo: repository } };
  const calls = [], base = '/repos/footprintjs/foottrace';
  const absent = () => { throw Object.assign(new Error('not-found'), { status: 404 }); };
  const api = async (method, route, body) => {
    calls.push({ method, route, body });
    assert.equal(method, 'GET', 'Planning never mutates remote state');
    if (route === base) return { data: repository };
    if (route.endsWith('/git/ref/heads/main')) return { data: { object: { type: 'commit', sha: M } } };
    if (route.endsWith('/git/ref/heads/release/next')) return { data: { object: { type: 'commit', sha: H } } };
    if (route.includes('/git/ref/tags/') || route.includes('/releases/tags/')) return absent();
    if (route.endsWith('/git/commits/' + M)) return { data: { sha: M, tree: { sha: TM }, parents: [{ sha: S }], committer: { date: '2026-11-01T00:00:00Z' } } };
    if (route.endsWith('/git/commits/' + H) || route.endsWith('/git/commits/' + S)) return { data: { sha: route.split('/').at(-1), tree: { sha: TH }, parents: [{ sha: sha('6') }], committer: { date: '2026-11-01T00:00:00Z' } } };
    if (route.includes('/git/trees/')) {
      const id = route.split('/git/trees/')[1].split('?')[0];
      assert([TM, TH].includes(id));
      return { data: { sha: id, truncated: false, tree: tree(id === TM ? files : original) } };
    }
    if (route.includes('/contents/')) {
      const path = decodeURIComponent(route.split('/contents/')[1].split('?')[0]);
      const ref = new URL('https://api.github.com' + route).searchParams.get('ref');
      const values = ref === M ? files : [H, S].includes(ref) ? original : null;
      assert(values && Object.hasOwn(values, path), 'Admitted immutable content reference');
      const bytes = Buffer.from(values[path]);
      return { data: { type: 'file', encoding: 'base64', content: bytes.toString('base64'), size: bytes.length } };
    }
    if (route.includes('/git/blobs/')) {
      const id = route.split('/git/blobs/')[1];
      const value = Object.values({ ...original, ...files }).find((text) => blob(text) === id);
      assert.equal(typeof value, 'string');
      const bytes = Buffer.from(value);
      return { data: { sha: id, encoding: 'base64', size: bytes.length, content: bytes.toString('base64') } };
    }
    if (route.startsWith('/users/')) return { data: bot };
    if (route.includes('/compare/')) return { data: { status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1,
      base_commit: { sha: S }, merge_base_commit: { sha: S }, commits: [{ sha: M, parents: [{ sha: S }] }] } };
    if (route.includes('/pulls/100')) return { data: predecessor };
    if (route.includes('/pulls?') || route.includes('/commits/')) return { data: route.includes('state=open') ? [] : [predecessor] };
    assert.fail(`Unexpected synthetic read: ${route}`);
  };
  const fetcher = async (url, options) => {
    assert(!options?.method || options.method === 'GET');
    assert.equal(new URL(url).origin, 'https://registry.npmjs.org');
    if (url === 'https://registry.npmjs.org/foottrace/1.10.0') return new Response('{"error":"not found"}', { status: 404 });
    if (url === 'https://registry.npmjs.org/foottrace/latest') return Response.json({ name: 'foottrace', version: '1.8.0' });
    assert.fail(`Unexpected synthetic registry read: ${url}`);
  };
  return { api, fetcher, calls, M, H, S, TM, TH, files, original, predecessor, repository, bot, inventory,
    options: { fetcher, settings: { slug: 'release-app', clientId: 'public-client-id' } },
    context: { repository, sha: M, ref: 'refs/heads/main', eventName: 'push', runId: 500, runAttempt: 1 },
    env: { REPO_ID: '123', REPO_NAME: repository.full_name, SOURCE_SHA: M,
    SOURCE_REF: 'refs/heads/main', EVENT_NAME: 'push', RUN_ID: '500', RUN_ATTEMPT: '1',
    APP_SLUG: 'release-app', APP_CLIENT_ID: 'public-client-id', GITHUB_OUTPUT: '/offline/output' } };
}

test('unpublished current version is recovered before a queued patch is consumed', async () => {
  const f = pendingVersionFixture(), outputs = [];
  const result = await runner.runCli(['plan'], { env: f.env, api: f.api, fetcher: f.fetcher,
    io: { head: () => f.M, appendOutput: (_path, text) => outputs.push(text) } });
  const plan = JSON.parse(result.plan);
  assert.equal(result.mode, 'prepare');
  assert.equal(plan.version, '1.10.0', 'The unpublished version must precede the queued patch');
  assert.equal(plan.preparationKind, 'recovery');
  assert.equal(outputs.length, 1);
  assert(f.calls.every((x) => x.method === 'GET'));
});

import { managedReleaseFixture } from './helpers.mjs';
async function prepareAndWrite(f) {
  const pinned = await runtime.plan(f.api, f.context, f.options);
  const payload = await runtime.prepareProposal(f.api, f.context, pinned, f.options);
  const result = await runtime.writeProposal(f.api, f.context, payload, pinned, f.options);
  return { pinned, payload, result };
}
function noWrites(f) { assert(f.calls.every((c) => c.method === 'GET')); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function edit(f, path, value, mode = '100644') {
  f.advance((map) => { const bytes = Buffer.from(value); map.set(path, { bytes, mode, sha: preparation.gitObject('blob', bytes) }); });
}
async function publication(f, api = f.api, options = f.options) {
  return runtime.publicationState(api, f.context, await runtime.sourceInput(api, f.context), options);
}

test('complete recovery lifecycle: intent-only candidate, real nonforce request, no-op and current merge', async () => {
  const f = managedReleaseFixture(), beforeMain = f.context.sha, retained = f.tip;
  const { pinned, payload, result } = await prepareAndWrite(f);
  assert.equal(pinned.preparationKind, 'recovery'); assert.equal(pinned.version, '1.10.0');
  const keys = Object.keys(payload.prepared.updates); assert.deepEqual(keys, ['.release/recovery/1.10.0/001.json']);
  assert.deepEqual(payload.prepared.deletions, []); assert.equal(payload.prepared.bump, null);
  const intent = JSON.parse(payload.prepared.updates[keys[0]]);
  assert.equal(intent.base.sha, beforeMain); assert.equal(intent.predecessor.head, retained);
  assert.equal(intent.origin.head, f.originalHead); assert.equal(intent.queuedFragments.length, 1);
  const writes = f.calls.filter((c) => c.method !== 'GET');
  assert.deepEqual(writes.map((c) => c.method), ['POST', 'POST', 'POST', 'PATCH', 'POST']);
  assert.deepEqual(writes[2].body.parents, [beforeMain, retained]); assert.equal(writes[3].body.force, false);
  const count = writes.length;
  assert.equal((await runtime.writeProposal(f.api, f.context, payload, pinned, f.options)).action, 'no-op');
  assert.equal(f.calls.filter((c) => c.method !== 'GET').length, count);
  const merged = f.merge(); assert.notEqual(merged, beforeMain);
  const next = await runtime.plan(f.api, f.context, f.options);
  assert.equal(next.mode, 'publish'); assert.equal(next.version, '1.10.0');
  assert.notEqual(intent.base.sha, merged, 'Saved base describes the proposal, not its later merge');
  const map = f.trees.get(f.commits.get(merged).tree.sha), originalMap = f.trees.get(f.commits.get(beforeMain).tree.sha);
  assert.equal(map.size, originalMap.size + 1);
  for (const [path, row] of originalMap) assert.deepEqual(map.get(path), row, path);
  assert.equal(result.tree, f.commits.get(merged).tree.sha);
});

test('R4 continuation preserves I1 as admitted history and adds only I2; publication then ordinary next retains both', async () => {
  const f = managedReleaseFixture(); await prepareAndWrite(f); f.merge();
  const firstMap = f.trees.get(f.commits.get(f.context.sha).tree.sha), first = firstMap.get('.release/recovery/1.10.0/001.json');
  edit(f, 'docs/RELEASING.md', 'Process-only later correction.\n');
  edit(f, '.changes/second-fix.md', '---\ntype: fixed\nbump: patch\n---\n\n- Later process correction.\n');
  const second = await prepareAndWrite(f);
  assert.deepEqual(Object.keys(second.payload.prepared.updates), ['.release/recovery/1.10.0/002.json']);
  const data = JSON.parse(Object.values(second.payload.prepared.updates)[0]);
  assert.equal(data.previous.sha256, preparation.digest(first.bytes)); assert.equal(data.origin.head, f.originalHead);
  f.merge();
  const current = f.trees.get(f.commits.get(f.context.sha).tree.sha);
  assert.deepEqual(current.get('.release/recovery/1.10.0/001.json'), first);
  assert.equal((await runtime.plan(f.api, f.context, f.options)).mode, 'publish');
  f.publish(f.context.sha);
  const next = await prepareAndWrite(f); assert.equal(next.pinned.preparationKind, 'next'); assert.equal(next.pinned.version, '1.10.1');
  assert(!Object.keys(next.payload.prepared.updates).some((p) => p.startsWith('.release/')));
  assert.deepEqual(next.payload.prepared.deletions, ['.changes/helper-fix.md', '.changes/second-fix.md']);
  f.merge();
  const after = f.trees.get(f.commits.get(f.context.sha).tree.sha);
  assert.deepEqual(after.get('.release/recovery/1.10.0/001.json'), first);
  assert(after.has('.release/recovery/1.10.0/002.json'));
  const plan = await runtime.plan(f.api, f.context, f.options);
  assert.equal(plan.version, '1.10.1'); assert.equal(plan.mode, 'publish', 'Old intents are inert for the new current version');
});

for (const [name, mutate] of [
  ['runtime byte', (f) => edit(f, 'src/index.ts', 'export const unconsumed = true;\n')],
  ['new unknown build helper', (f) => edit(f, 'scripts/new-build.cjs', 'unsafe\n')],
  ['new configuration', (f) => edit(f, '.npmrc', 'ignore-scripts=false\n')],
  ['packed README', (f) => edit(f, 'README.md', 'unconsumed package README\n')],
  ['package lifecycle hook', (f) => { const value = JSON.parse(f.files['package.json']); value.scripts.build = 'node new-build'; edit(f, 'package.json', JSON.stringify(value)); }],
  ['protected executable mode', (f) => edit(f, 'src/index.ts', f.files['src/index.ts'], '100755')],
  ['protected deletion', (f) => f.advance((m) => m.delete('src/index.ts'))],
]) test(`payload closure refuses ${name} before any write`, async () => {
  const f = managedReleaseFixture(); mutate(f);
  await assert.rejects(() => prepareAndWrite(f), { code: 'recovery-payload' }); noWrites(f);
});

for (const [name, mutate] of [
  ['lost retained tip', (f) => { f.tip = null; }],
  ['unknown retained tip', (f) => { f.tip = f.addCommit(f.files, [f.context.sha]); }],
  ['wrong Bot', (f) => { f.originalPR.user = { id: 999, login: 'other[bot]', type: 'Bot' }; }],
  ['wrong repo', (f) => { f.originalPR.head = { ...f.originalPR.head, repo: { id: 1, full_name: 'another/repo' } }; }],
  ['unmerged predecessor', (f) => { f.originalPR.merged = false; }],
  ['ambiguous predecessor', (f) => { f.pulls.push({ ...f.originalPR, id: 9999, number: 999 }); }],
]) test(`lineage refuses ${name} without effects`, async () => {
  const f = managedReleaseFixture(); mutate(f);
  await assert.rejects(() => prepareAndWrite(f)); noWrites(f);
});

test('open proposal cannot be regenerated around a moved base or changed queue', async () => {
  const f = managedReleaseFixture(); await prepareAndWrite(f); const count = f.calls.filter((c) => c.method !== 'GET').length;
  edit(f, '.changes/moved.md', '---\ntype: fixed\nbump: patch\n---\n\n- Moved queue.\n');
  await assert.rejects(() => prepareAndWrite(f), { code: 'proposal-existing' });
  assert.equal(f.calls.filter((c) => c.method !== 'GET').length, count);
});
test('queued prior fragments cannot disappear or change during continuation', async () => {
  for (const remove of [true, false]) {
    const f = managedReleaseFixture(); await prepareAndWrite(f); f.merge();
    f.advance((m) => { if (remove) m.delete('.changes/helper-fix.md'); else { const bytes = Buffer.from('---\ntype: fixed\nbump: patch\n---\n\n- Changed meaning.\n'); m.set('.changes/helper-fix.md', { bytes, mode: '100644', sha: preparation.gitObject('blob', bytes) }); } });
    const count = f.calls.filter((c) => c.method !== 'GET').length;
    await assert.rejects(() => prepareAndWrite(f), { code: 'recovery-queue' });
    assert.equal(f.calls.filter((c) => c.method !== 'GET').length, count);
  }
});

test('privileged writer reclassifies a newly visible partial release before FIRST blob', async () => {
  const f = managedReleaseFixture(), pinned = await runtime.plan(f.api, f.context, f.options), payload = await runtime.prepareProposal(f.api, f.context, pinned, f.options);
  f.tags.set('v1.10.0', f.originalMerge);
  await assert.rejects(() => runtime.writeProposal(f.api, f.context, payload, pinned, f.options), { code: 'recovery-state' }); noWrites(f);
});
test('registry phase drift never promotes a stale prepare artifact', async () => {
  const f = managedReleaseFixture(), pinned = await runtime.plan(f.api, f.context, f.options), payload = await runtime.prepareProposal(f.api, f.context, pinned, f.options);
  f.publish(f.originalMerge);
  await assert.rejects(() => runtime.writeProposal(f.api, f.context, payload, pinned, f.options), { code: 'proposal-plan' }); noWrites(f);
});
test('metadata errors and permission ambiguity refuse rather than becoming absence', async () => {
  for (const status of [401, 403, 429, 500]) {
    const f = managedReleaseFixture(); const api = async (m, r, b) => { if (r.includes('/releases/tags/')) throw Object.assign(new Error('private'), { status }); return f.api(m, r, b); };
    await assert.rejects(() => runtime.plan(api, f.context, f.options)); noWrites(f);
  }
});
test('publication witness reads historical S while executing current M and validates bytes, tag, PR, notes and latest', async () => {
  const f = managedReleaseFixture({ published: true }); assert.notEqual(f.context.sha, f.originalMerge);
  const value = await publication(f); assert.equal(value.state, 'published'); assert.equal(value.sha, f.originalMerge);
  assert.equal(value.provenanceCryptographicallyVerified, false); assert.equal(value.integrity.startsWith('sha512-'), true);
  const p = await runtime.plan(f.api, f.context, f.options); assert.equal(p.preparationKind, 'next'); assert.equal(p.version, '1.10.1');
  assert(f.calls.some((c) => c.route.includes('/contents/CHANGELOG.md?ref=' + f.originalMerge)));
  noWrites(f);
});
for (const [name, mutate] of [
  ['missing tag', (f) => f.tags.clear()],
  ['literal target mismatch', (f) => { f.releases.get('v1.10.0').target_commitish = 'main'; }],
  ['wrong notes', (f) => { f.releases.get('v1.10.0').body += 'different'; }],
  ['draft', (f) => { f.releases.get('v1.10.0').draft = true; }],
  ['missing marker', (f) => { f.releases.get('v1.10.0').assets = []; }],
  ['duplicate marker', (f) => { const r = f.releases.get('v1.10.0'); r.assets.push({ ...r.assets[0], id: 22 }); }],
  ['partial marker', (f) => { f.releases.get('v1.10.0').assets[0].state = 'new'; }],
  ['marker declared length', (f) => { f.releases.get('v1.10.0').assets[0].size++; }],
  ['marker extra authority field', (f) => { const a = f.releases.get('v1.10.0').assets[0]; a.raw = Buffer.from(JSON.stringify({ ...JSON.parse(a.raw), mayPublish: true })); a.size = a.raw.length; }],
  ['marker unsafe run', (f) => { const a = f.releases.get('v1.10.0').assets[0]; a.raw = Buffer.from(JSON.stringify({ ...JSON.parse(a.raw), runId: 0 })); a.size = a.raw.length; }],
  ['tarball URL', (f) => { f.registry.get('1.10.0').metadata.dist.tarball = 'https://untrusted.invalid/archive'; }],
  ['archive bytes', (f) => { f.registry.get('1.10.0').bytes = Buffer.from('not an archive'); }],
  ['registry integrity', (f) => { f.registry.get('1.10.0').metadata.dist.integrity = 'sha512-' + 'A'.repeat(86) + '=='; }],
  ['latest above current', (f) => { f.latest = '1.11.0'; }],
]) test(`historical witness refuses ${name}`, async () => {
  const f = managedReleaseFixture({ published: true }); mutate(f);
  await assert.rejects(() => runtime.plan(f.api, f.context, f.options)); noWrites(f);
});
test('valid marker plus registry404 is verification only, never a new recovery or submission', async () => {
  const f = managedReleaseFixture(); f.publish(f.originalMerge, true);
  const p = await runtime.plan(f.api, f.context, f.options); assert.equal(p.mode, 'verify'); assert.equal(p.preparationKind, undefined);
  assert.equal((await publication(f)).reason, 'pending-registry'); noWrites(f);
});
test('lagging latest is verification only and latest unavailability refuses', async () => {
  const f = managedReleaseFixture({ published: true }); f.latest = '1.8.0';
  assert.equal((await runtime.plan(f.api, f.context, f.options)).mode, 'verify');
  const fetcher = async (url, opts) => url.endsWith('/latest') ? new Response('{}', { status: 404 }) : f.fetcher(url, opts);
  await assert.rejects(() => runtime.plan(f.api, f.context, { ...f.options, fetcher }), { code: 'registry-unavailable' }); noWrites(f);
});

test('canonical intent admission copies only own data and atomically refuses malformed suffix/history', async () => {
  const f = managedReleaseFixture(), p = await runtime.plan(f.api, f.context, f.options), payload = await runtime.prepareProposal(f.api, f.context, p, f.options);
  const [path, text] = Object.entries(payload.prepared.updates)[0], data = JSON.parse(text), inventory = new Map();
  const admit = (raw, name = path) => preparation.admitIntentNamespace(new Map([[name, { mode: '100644', bytes: raw }]]), '1.10.0', f.repository);
  assert.equal(admit(Buffer.from(text)).active.length, 1);
  for (const raw of [Buffer.from('\ufeff' + text), Buffer.from(text.trim()), Buffer.from(text.replace('"schema":1', '"schema":1,"schema":1')),
    Buffer.from(JSON.stringify(data, null, 2) + '\n'), Buffer.from('{"unknown":1}'), Buffer.from([0xff]), Buffer.alloc(65537, 32)])
    assert.throws(() => admit(raw));
  assert.throws(() => admit(Buffer.from(text), path.replace('/001.', '/002.')));
  for (const mutate of [
    (d) => { d.repository.id++; }, (d) => { d.sequence = 2; }, (d) => { d.extra = true; },
    (d) => { d.queuedFragments[0].bytes = 0; }, (d) => { d.queuedFragments[0].mode = '100755'; },
    (d) => { d.queuedFragments.push(d.queuedFragments[0]); }, (d) => { d.base.sha = 'bad'; },
    (d) => { d.previous = { path, sha256: 'a'.repeat(64) }; },
  ]) { const d = clone(data); mutate(d); assert.throws(() => preparation.intentBytes(d, f.repository)); }
  const accessor = clone(data); Object.defineProperty(accessor, 'schema', { get: () => assert.fail('Accessor invoked') });
  assert.throws(() => preparation.intentBytes(accessor, f.repository), { code: 'recovery-intent' });
  const inherited = Object.create(data); assert.throws(() => preparation.intentBytes(inherited, f.repository));
  inventory.set(path, { mode: '100644', bytes: Buffer.from(text) }); inventory.set('.release/recovery/1.10.0/bad.json', { mode: '100644', bytes: Buffer.from('{}') });
  assert.throws(() => preparation.admitIntentNamespace(inventory, '1.10.0', f.repository));
});

test('compare ancestry enforces complete bounded identities, counts, order endpoint and duplicate refusal', async () => {
  const f = managedReleaseFixture(), from = sha('a'), to = sha('b');
  const base = { status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1, base_commit: { sha: from }, merge_base_commit: { sha: from }, commits: [{ sha: to }] };
  await runtime.requireAncestor(async () => ({ data: base }), f.context, from, to);
  for (const delta of [ { base_commit: { sha: sha('c') } }, { merge_base_commit: { sha: sha('c') } }, { behind_by: 1 },
    { ahead_by: 2 }, { total_commits: 1001, ahead_by: 1001 }, { commits: [] }, { commits: [{ sha: from }] }, { status: 'diverged' },
    { total_commits: 2, ahead_by: 2, commits: [{ sha: to }, { sha: to }] } ])
    await assert.rejects(() => runtime.requireAncestor(async () => ({ data: { ...base, ...delta } }), f.context, from, to), { code: 'recovery-ancestry' });
  await runtime.requireAncestor(async () => ({ data: { ...base, status: 'identical', ahead_by: 0, total_commits: 0, commits: [] } }), f.context, from, from);
});

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import pathModule from 'node:path';
test('actual isolated Git FF preserves squash-era release ancestry and refuses divergent advance', () => {
  const dir = mkdtempSync(pathModule.join(tmpdir(), 'ft-recovery-git-')), local = pathModule.join(dir, 'objects.git'), remote = pathModule.join(dir, 'remote.git');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' };
  delete env.GH_TOKEN; delete env.GITHUB_TOKEN; delete env.APP_PRIVATE_KEY;
  const git = (args, input = '') => execFileSync('git', args, { env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }).trim();
  try {
    git(['init', '--bare', '--quiet', local]); git(['init', '--bare', '--quiet', remote]);
    const blob = git(['--git-dir', local, 'hash-object', '-w', '--stdin'], 'existing\n');
    const tree = git(['--git-dir', local, 'mktree'], `100644 blob ${blob}\tfile\n`);
    assert.equal(preparation.treeOid(new Map([['file', { sha: blob, mode: '100644' }]])), tree);
    const commit = (parents, message) => git(['--git-dir', local, 'commit-tree', tree, ...parents.flatMap((sha) => ['-p', sha])], message);
    const b = commit([], 'base'), h = commit([b], 'original release'), s = commit([b], 'squash merge'), m = commit([s], 'process-only fix'), n = commit([m, h], 'reviewed recovery'), d = commit([h], 'divergent writer');
    git(['--git-dir', local, 'push', remote, `${h}:refs/heads/release/next`]);
    git(['--git-dir', local, 'push', remote, `${n}:refs/heads/release/next`]);
    assert.equal(git(['--git-dir', remote, 'rev-parse', 'refs/heads/release/next']), n);
    git(['--git-dir', remote, 'merge-base', '--is-ancestor', h, n]);
    assert.deepEqual(git(['--git-dir', remote, 'show', '-s', '--format=%P', n]).split(' '), [m, h]);
    git(['--git-dir', local, 'push', remote, `${d}:refs/heads/diverged`]);
    const rejected = spawnSync('git', ['--git-dir', local, 'push', remote, `${n}:refs/heads/diverged`], { env, encoding: 'utf8', timeout: 5000 });
    assert.notEqual(rejected.status, 0); assert.equal(rejected.signal, null); assert.match(rejected.stderr, /rejected/);
    assert.equal(git(['--git-dir', remote, 'rev-parse', 'refs/heads/diverged']), d);
    // An already ancestral tip is accepted; this witnesses FF, never CAS/exclusion.
    git(['--git-dir', local, 'push', remote, `${h}:refs/heads/ancestral`]);
    git(['--git-dir', local, 'push', remote, `${n}:refs/heads/ancestral`]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('each partial proposal write failure stops exactly there without rollback or automatic retry', async () => {
  for (let stop = 1; stop <= 5; stop++) {
    const f = managedReleaseFixture(), pinned = await runtime.plan(f.api, f.context, f.options), payload = await runtime.prepareProposal(f.api, f.context, pinned, f.options);
    let writes = 0; const observed = [];
    const api = async (m, r, b) => {
      if (m !== 'GET') {
        observed.push({ method: m, route: r }); writes++;
        if (writes === stop) {
          // The provider can perform this effect and then lose the response.
          await f.api(m, r, b); throw Object.assign(new Error('synthetic-response-loss'), { code: 'response-limit' });
        }
      }
      return f.api(m, r, b);
    };
    await assert.rejects(() => runtime.writeProposal(api, f.context, payload, pinned, f.options), { code: 'response-limit' });
    assert.equal(writes, stop); assert.equal(observed.length, stop);
    assert(observed.every((x) => ['POST', 'PATCH'].includes(x.method)));
    if (stop === 4) { assert.notEqual(f.tip, f.originalHead); assert.equal(f.pulls.filter((p) => p.state === 'open').length, 0); }
    if (stop === 5) assert.equal(f.pulls.filter((p) => p.state === 'open').length, 1, 'Lost PR response retains the real partial effect');
  }
});

test('divergent retained tip after object creation stops before ref mutation and preserves created evidence', async () => {
  const f = managedReleaseFixture(), p = await runtime.plan(f.api, f.context, f.options), payload = await runtime.prepareProposal(f.api, f.context, p, f.options);
  let created = false;
  const api = async (m, r, b) => {
    const value = await f.api(m, r, b);
    if (m === 'POST' && r.endsWith('/git/commits')) { created = true; f.tip = f.addCommit(f.files, [f.originalHead]); }
    return value;
  };
  await assert.rejects(() => runtime.writeProposal(api, f.context, payload, p, f.options), { code: 'proposal-existing' });
  assert(created); assert(!f.calls.some((x) => x.method === 'PATCH'));
});

test('recovery source guard derives obligations from immutable tree, not a plan flag', async () => {
  const f = managedReleaseFixture(); await prepareAndWrite(f); f.merge();
  const c = f.commits.get(f.context.sha), identity = { tree: c.tree.sha, version: '1.10.0' };
  await runtime.requireRecoverySource(f.api, f.context, identity, f.options);
  const head = f.commits.get(f.tip), saved = head.parents; head.parents = [{ sha: sha('c') }];
  await assert.rejects(() => runtime.requireRecoverySource(f.api, f.context, identity, f.options), { code: 'recovery-intent' });
  head.parents = saved;
});

for (const [name, change, code] of [
  ['truncated tree', (d) => ({ ...d, truncated: true }), 'source-tree'],
  ['duplicate tree path', (d) => ({ ...d, tree: [...d.tree, d.tree[0]] }), 'source-tree'],
  ['wrong tree identity', (d) => ({ ...d, sha: sha('a') }), 'source-tree'],
]) test(`raw source rejects ${name}`, async () => {
  const f = managedReleaseFixture(), api = async (m, r, b) => { const value = await f.api(m, r, b); return r.includes('/git/trees/') ? { data: change(value.data) } : value; };
  await assert.rejects(() => runtime.plan(api, f.context, f.options), { code }); noWrites(f);
});
for (const [name, change] of [
  ['wrong blob identity', (d) => ({ ...d, sha: sha('b') })],
  ['wrong declared bytes', (d) => ({ ...d, size: d.size + 1 })],
  ['changed blob bytes', (d) => ({ ...d, content: Buffer.from('bad').toString('base64'), size: 3 })],
  ['oversized blob', (d) => ({ ...d, size: 3 * 1024 * 1024 })],
]) test(`raw source rejects ${name}`, async () => {
  const f = managedReleaseFixture(), api = async (m, r, b) => { const value = await f.api(m, r, b); return r.includes('/git/blobs/') ? { data: change(value.data) } : value; };
  await assert.rejects(() => runtime.plan(api, f.context, f.options), { code: 'source-content' }); noWrites(f);
});

test('R4 closure protects original intent history and all already admitted main records', async () => {
  const f = managedReleaseFixture(), p = await runtime.plan(f.api, f.context, f.options), payload = await runtime.prepareProposal(f.api, f.context, p, f.options),
    [name, text] = Object.entries(payload.prepared.updates)[0], bytes = Buffer.from(text), row = { sha: preparation.gitObject('blob', bytes), bytes, mode: '100644' },
    original = new Map(), current = new Map([[name, row]]), admitted = new Set([name]);
  preparation.requirePublicationClosure(original, current, admitted);
  assert.throws(() => preparation.requirePublicationClosure(original, current, new Set()), { code: 'recovery-payload' });
  const alteredBytes = Buffer.from(text.replace('"sequence":1', '"sequence":2')),
    altered = { sha: preparation.gitObject('blob', alteredBytes), bytes: alteredBytes, mode: '100644' };
  assert.throws(() => preparation.requirePublicationClosure(current, new Map([[name, altered]]), admitted), { code: 'recovery-payload' });
  assert.throws(() => preparation.requirePublicationClosure(current, original, admitted), { code: 'recovery-payload' });
});

test('indistinguishable fully erased marker worlds have identical observed classifications; no invisible-history detector', async () => {
  const a = managedReleaseFixture(), b = managedReleaseFixture();
  // b's privileged erasure is hypothetical and deliberately unobservable here.
  assert.deepEqual(await runtime.plan(a.api, a.context, a.options), await runtime.plan(b.api, b.context, b.options));
  noWrites(a); noWrites(b);
});

test('historical verifier compares the actual valid archive digest, not just metadata', async () => {
  const f = managedReleaseFixture({ published: true }), { gunzipSync, gzipSync } = require('node:zlib'), item = f.registry.get('1.10.0'), raw = gunzipSync(item.bytes);
  const at = raw.indexOf(Buffer.from('synthetic')); assert(at > 0); raw[at] = 'p'.charCodeAt(0); item.bytes = gzipSync(raw);
  // Header checksums cover headers, not file bodies. This is a valid different archive.
  require('../../scripts/release-archive.cjs').inspectArchive(item.bytes, { package: 'foottrace', version: '1.10.0' });
  await assert.rejects(() => runtime.plan(f.api, f.context, f.options), { code: 'registry-bytes' }); noWrites(f);
});
test('ancestry multi-page reads keep fixed source/counts and exact terminal target', async () => {
  const f = managedReleaseFixture(), from = sha('a'), to = sha('b'), rows = Array.from({ length: 100 }, (_, i) => ({ sha: (i + 1).toString(16).padStart(40, '0') }));
  const api = async (_m, route) => ({ data: { status: 'ahead', ahead_by: 101, behind_by: 0, total_commits: 101, base_commit: { sha: from }, merge_base_commit: { sha: from }, commits: route.endsWith('page=1') ? rows : [{ sha: to }] } });
  await runtime.requireAncestor(api, f.context, from, to);
  for (const delta of [{ base_commit: { sha: sha('c') } }, { commits: [{ sha: sha('c') }] }, { total_commits: 102, ahead_by: 102 }, { commits: [rows[0]] }]) {
    const changed = async (m, r) => { const value = await api(m, r); return r.endsWith('page=2') ? { data: { ...value.data, ...delta } } : value; };
    await assert.rejects(() => runtime.requireAncestor(changed, f.context, from, to), { code: 'recovery-ancestry' });
  }
});
test('non-200 registry success-like responses are unknown, never absence', async () => {
  const f = managedReleaseFixture(), fetcher = async () => new Response('{}', { status: 201 });
  await assert.rejects(() => runtime.plan(f.api, f.context, { ...f.options, fetcher }), { code: 'registry-unavailable' }); noWrites(f);
});

test('absent current version with equal/newer latest or unknown latest holds before recovery writes', async () => {
  for (const latest of ['1.10.0', '1.11.0']) {
    const f = managedReleaseFixture(); f.latest = latest;
    await assert.rejects(() => prepareAndWrite(f), { code: 'recovery-state' }); noWrites(f);
  }
  const f = managedReleaseFixture(), fetcher = async (url) => url.endsWith('/latest') ? new Response('{}', { status: 404 }) : f.fetcher(url);
  await assert.rejects(() => runtime.plan(f.api, f.context, { ...f.options, fetcher }), { code: 'registry-unavailable' }); noWrites(f);
});

async function legacyOpen(f, damage) {
  const context = { ...f.context }, pinned = await runtime.plan(f.api, context, f.options), payload = await runtime.prepareProposal(f.api, context, pinned, f.options), inventory = new Map(f.trees.get(f.commits.get(context.sha).tree.sha));
  for (const [path, value] of Object.entries(payload.prepared.updates)) { const bytes = Buffer.from(value); inventory.set(path, { bytes, mode: '100644', sha: preparation.gitObject('blob', bytes) }); }
  for (const path of payload.prepared.deletions) inventory.delete(path);
  if (damage === 'tree') { const bytes = Buffer.from('Extra unreviewed package content.\n'); inventory.set('README.md', { bytes, mode: '100644', sha: preparation.gitObject('blob', bytes) }); }
  const head = f.addCommit(inventory, [context.sha]); f.tip = head;
  const pr = { ...f.originalPR, id: 9001, number: 9001, state: 'open', merged: false, merged_at: null, merge_commit_sha: null,
    base: { ref: 'main', sha: context.sha, repo: f.repository }, head: { ref: 'release/next', sha: head, repo: f.repository } };
  if (damage === 'base') pr.base.sha = sha('c');
  if (damage === 'head') pr.head.sha = f.originalHead;
  if (damage === 'bot') pr.user = { id: 999, type: 'Bot', login: 'different[bot]' };
  f.pulls.push(pr);
  return { context, pinned, payload };
}
test('review S1: exact legacy one-parent NEXT proposal is a zero-write no-op', async () => {
  const f = managedReleaseFixture({ published: true }), x = await legacyOpen(f); let result;
  await assert.doesNotReject(async () => { result = await runtime.writeProposal(f.api, x.context, x.payload, x.pinned, f.options); });
  assert.equal(result.action, 'no-op'); assert.equal(result.pr, 9001); noWrites(f);
});
// A recorded base outside main history and a foreign author carry their own names.
for (const [damage, code] of [['tree', 'proposal-existing'], ['base', 'proposal-base-moved'], ['head', 'proposal-existing'], ['bot', 'proposal-author']])
  test(`review S1: legacy no-op refuses wrong ${damage} without writes`, async () => {
  const f = managedReleaseFixture({ published: true }), x = await legacyOpen(f, damage);
  await assert.rejects(() => runtime.writeProposal(f.api, x.context, x.payload, x.pinned, f.options), { code }); noWrites(f);
});
for (const [damage, code] of [
  ['response-base', 'proposal-pr'], ['response-closed', 'proposal-pr'], ['returned-new-base', 'proposal-pr'],
  ['main-moved', 'main-moved'], ['ref-moved', 'proposal-existing'], ['head-moved', 'proposal-pr'], ['fresh-closed', 'proposal-pr'], ['final-read-error', null],
]) test(`review S2: post-create ${damage} refuses and preserves every partial effect`, async () => {
  const f = managedReleaseFixture(), context = { ...f.context }, pinned = await runtime.plan(f.api, context, f.options), payload = await runtime.prepareProposal(f.api, context, pinned, f.options);
  let created = false;
  const api = async (method, route, body) => {
    if (created && damage === 'final-read-error' && method === 'GET') throw Object.assign(new Error('synthetic-final-read'), { status: 403 });
    const value = await f.api(method, route, body);
    if (method === 'POST' && route.endsWith('/pulls')) {
      created = true; const response = { data: clone(value.data) };
      if (damage === 'response-base') response.data.base.sha = sha('c');
      if (damage === 'response-closed') response.data.state = 'closed';
      if (damage === 'fresh-closed') value.data.state = 'closed';
      if (damage === 'main-moved' || damage === 'returned-new-base') {
        edit(f, 'docs/RELEASING.md', 'Concurrent process change.\n');
        if (damage === 'returned-new-base') response.data.base.sha = f.context.sha;
      }
      if (damage === 'ref-moved' || damage === 'head-moved') {
        const other = f.addCommit(f.files, [f.tip]);
        if (damage === 'ref-moved') f.tip = other; else value.data.head.sha = other;
      }
      return response;
    }
    return value;
  };
  await assert.rejects(() => runtime.writeProposal(api, context, payload, pinned, f.options), code ? { code } : (error) => error.status === 403);
  assert(created); assert.equal(f.pulls.length, 2, 'Created PR remains, even when a later observation refuses');
  const writes = f.calls.filter((c) => c.method !== 'GET');
  assert.equal(writes.length, 5); assert(!writes.some((c) => c.method === 'DELETE'));
  assert.equal(writes.filter((c) => c.method === 'PATCH').length, 1, 'No retry or forced repair');
});


test('review S2: a final PR response naming another number is refused without repair', async () => {
  const f = managedReleaseFixture(), context = { ...f.context }, pinned = await runtime.plan(f.api, context, f.options), payload = await runtime.prepareProposal(f.api, context, pinned, f.options); let created = false;
  const api = async (m, r, b) => { const value = await f.api(m, r, b); if (m === 'POST' && r.endsWith('/pulls')) created = true;
    else if (created && m === 'GET' && /\/pulls\/\d+$/.test(r)) { const changed = clone(value.data); changed.number++; return { data: changed }; } return value; };
  await assert.rejects(() => runtime.writeProposal(api, context, payload, pinned, f.options), { code: 'proposal-pr' });
  assert.equal(f.pulls.length, 2); assert.equal(f.calls.filter((c) => c.method !== 'GET').length, 5);
});
