import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
export const root = fileURLToPath(new URL('../../', import.meta.url));
export const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

/** Exact historical input; no fallback to the mutable checkout. Fresh objects per call. */
export function loadReleaseSpecimen() {
  const directory = new URL('./fixtures/pre-metadata-release/', import.meta.url);
  const manifestBytes = readFileSync(new URL('manifest.json', directory));
  assert.equal(createHash('sha256').update(manifestBytes).digest('hex'), '73d3c28e7e9b268a911a3cec9ea1c5e29d634100e4d0206264e0f6582baefc4d', 'Historical fixture manifest changed');
  const manifest = JSON.parse(manifestBytes), files = {};
  const names = ['package.json', 'package-lock.json', 'CHANGELOG.md', 'README.md', 'docs/metadata.md', '.changes/metadata-query.md'];
  assert.deepEqual(Object.keys(manifest.files).sort(), [...names].sort());
  assert.equal(manifest.sourceCommit, 'df87b324377b24802732023120a87242b9b94aa8');
  for (const name of names) {
    const path = new URL(name, directory), info = lstatSync(path), bytes = readFileSync(path), pinned = manifest.files[name];
    assert(info.isFile() && !info.isSymbolicLink()); assert.equal(info.mode & 0o777, pinned.mode);
    assert.equal(bytes.length, pinned.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), pinned.sha256);
    assert.equal(createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex'), pinned.gitBlob);
    files[name] = bytes.toString('utf8');
  }
  const fragments = { 'metadata-query.md': files['.changes/metadata-query.md'] };
  delete files['.changes/metadata-query.md'];
  return { files, fragments };
}

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
    [`/repos/footprintjs/foottrace/git/trees/${w.expected.tree}?recursive=1`, { sha: w.expected.tree, truncated: false, tree: [] }],
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
// Complete synthetic managed-publication model. No IDs/receipts here assert that
// a real historical publication existed; immutable legacy specimens stay exact.
export function managedReleaseFixture({ version = '1.10.0', published = false, metadata = false } = {}) {
  const pure = require('../../scripts/release-prepare.cjs');
  const repository = { id: 123, full_name: 'footprintjs/foottrace' },
    bot = { id: 99, login: 'release-app[bot]', type: 'Bot' }, base = '/repos/footprintjs/foottrace';
  const { files: initial, fragments } = loadReleaseSpecimen();
  const pkg = JSON.parse(initial['package.json']), lock = JSON.parse(initial['package-lock.json']);
  pkg.version = lock.version = lock.packages[''].version = version;
  initial['package.json'] = JSON.stringify(pkg, null, 2) + '\n';
  initial['package-lock.json'] = JSON.stringify(lock, null, 2) + '\n';
  initial['CHANGELOG.md'] = `# Changelog\n\n## ${version} — 2026-11-01\n\n### Added\n\n- Existing package contents.\n`;
  initial['src/index.ts'] = 'export const existing = true;\n';
  const commits = new Map(), trees = new Map(), blobs = new Map(), pulls = [], releases = new Map(), tags = new Map(), registry = new Map(), calls = [];
  let nextPR = 100, latest = '1.8.0', tip, remoteMain;
  const makeInventory = (files) => new Map(Object.entries(files).map(([path, value]) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const row = { bytes, mode: '100644', sha: pure.gitObject('blob', bytes) };
    blobs.set(row.sha, bytes); return [path, row];
  }));
  const storeTree = (inventory) => {
    for (const row of inventory.values()) { assert.equal(pure.gitObject('blob', row.bytes), row.sha); blobs.set(row.sha, row.bytes); }
    const id = pure.treeOid(inventory); trees.set(id, new Map(inventory)); return id;
  };
  const addCommit = (files, parents = [], treeId) => {
    const tree = treeId ?? storeTree(files instanceof Map ? files : makeInventory(files));
    const bytes = Buffer.from(`tree ${tree}\n${parents.map((p) => `parent ${p}\n`).join('')}author Model <model@example.invalid> 1793491200 +0000\ncommitter Model <model@example.invalid> 1793491200 +0000\n\nSynthetic ${commits.size}\n`);
    const id = pure.gitObject('commit', bytes);
    commits.set(id, { sha: id, tree: { sha: tree }, parents: parents.map((sha) => ({ sha })), committer: { date: '2026-11-01T00:00:00Z' } });
    return id;
  };
  const root = addCommit(initial), originalHead = addCommit(initial, [root]), originalMerge = addCommit(initial, [root, originalHead]);
  const makePR = (head, source, merged = false) => ({ id: nextPR + 1000, number: nextPR++, state: merged ? 'closed' : 'open',
    merged, merged_at: merged ? '2026-11-01T00:00:00Z' : null, merge_commit_sha: source, user: { ...bot },
    base: { ref: 'main', sha: merged ? root : context.sha, repo: repository }, head: { ref: 'release/next', sha: head, repo: repository } });
  // context exists before the first unmerged PR is created.
  const context = { repository, sha: originalMerge, ref: 'refs/heads/main', eventName: 'push', runId: 500, runAttempt: 1 };
  const originalPR = makePR(originalHead, originalMerge, true); pulls.push(originalPR); tip = originalHead;
  const queued = { ...initial, [metadata ? '.changes/metadata-query.md' : '.changes/helper-fix.md']:
    metadata ? fragments['metadata-query.md'] : '---\ntype: fixed\nbump: patch\n---\n\n- Repair release preparation.\n' };
  context.sha = addCommit(queued, [originalMerge]);
  const missing = () => { throw Object.assign(new Error('synthetic-not-found'), { status: 404 }); };
  const ancestors = (id, seen = new Set()) => {
    if (seen.has(id)) return seen; seen.add(id);
    for (const p of commits.get(id)?.parents ?? []) ancestors(p.sha, seen);
    return seen;
  };
  const api = async (method, route, body) => {
    calls.push({ method, route, body });
    const url = new URL('https://api.github.com' + route), path = url.pathname;
    if (method === 'GET') {
      if (path === base) return { data: repository };
      if (path.endsWith('/git/ref/heads/main')) return { data: { object: { type: 'commit', sha: remoteMain ?? context.sha } } };
      if (path.endsWith('/git/matching-refs/tags/v')) return { data: [...tags].map(([tag, source]) => ({ ref: 'refs/tags/' + tag, object: { type: 'commit', sha: source } })) };
      if (path.endsWith('/git/ref/heads/release/next')) return tip ? { data: { object: { type: 'commit', sha: tip } } } : missing();
      if (path.includes('/git/ref/tags/')) { const value = tags.get(decodeURIComponent(path.split('/').at(-1))); return value ? { data: { object: { type: 'commit', sha: value } } } : missing(); }
      if (path.includes('/releases/tags/')) { const value = releases.get(decodeURIComponent(path.split('/').at(-1))); return value ? { data: value } : missing(); }
      if (path.includes('/git/commits/')) return { data: commits.get(path.split('/').at(-1)) ?? assert.fail('Unknown immutable commit') };
      if (path.includes('/git/trees/')) {
        const id = path.split('/').at(-1), inventory = trees.get(id); assert(inventory, id);
        return { data: { sha: id, truncated: false, tree: [...inventory].map(([path, row]) => ({ path, mode: row.mode, sha: row.sha, type: 'blob', size: row.bytes.length })) } };
      }
      if (path.includes('/git/blobs/')) {
        const id = path.split('/').at(-1), bytes = blobs.get(id); assert(bytes, id);
        return { data: { sha: id, encoding: 'base64', size: bytes.length, content: bytes.toString('base64') } };
      }
      if (path.includes('/contents/')) {
        const file = decodeURIComponent(path.split('/contents/')[1]), c = commits.get(url.searchParams.get('ref')),
          row = trees.get(c?.tree.sha)?.get(file); assert(row, file);
        return { data: { type: 'file', encoding: 'base64', content: row.bytes.toString('base64'), size: row.bytes.length } };
      }
      if (path.startsWith('/users/')) return { data: { ...bot } };
      if (path.includes('/compare/')) {
        const [from, to] = path.split('/compare/')[1].split('...'), old = ancestors(from), all = ancestors(to), ordered = [], seen = new Set();
        const visit = (id) => { if (old.has(id) || seen.has(id)) return; seen.add(id); for (const p of commits.get(id).parents) visit(p.sha); ordered.push({ sha: id }); };
        visit(to); const page = Number(url.searchParams.get('page'));
        return { data: { status: from === to ? 'identical' : all.has(from) ? 'ahead' : 'diverged', ahead_by: ordered.length,
          behind_by: all.has(from) ? 0 : 1, total_commits: ordered.length, base_commit: { sha: from }, merge_base_commit: { sha: all.has(from) ? from : root },
          commits: ordered.slice((page - 1) * 100, page * 100) } };
      }
      if (/\/commits\/[a-f0-9]{40}\/pulls$/.test(path)) return { data: pulls.filter((p) => p.merge_commit_sha === path.split('/').at(-2)) };
      if (/\/pulls\/\d+\/reviews$/.test(path)) return { data: (pulls.find((p) => p.number === Number(path.split('/').at(-2))) ?? assert.fail('Unknown PR')).reviews ?? [] };
      if (/\/pulls\/\d+$/.test(path)) return { data: pulls.find((p) => p.number === Number(path.split('/').at(-1))) ?? assert.fail('Unknown PR') };
      if (path.endsWith('/pulls')) { const state = url.searchParams.get('state'); return { data: pulls.filter((p) => state === 'all' || p.state === state) }; }
      if (/\/releases\/\d+\/assets$/.test(path)) return { data: [...releases.values()].find((r) => r.id === Number(path.split('/').at(-2)))?.assets ?? [] };
      if (/\/releases\/assets\/\d+$/.test(path)) return { data: [...releases.values()].flatMap((r) => r.assets).find((a) => a.id === Number(path.split('/').at(-1))).raw };
    }
    if (method === 'POST') {
      if (path.endsWith('/git/blobs')) { const bytes = Buffer.from(body.content); const id = pure.gitObject('blob', bytes); blobs.set(id, bytes); return { data: { sha: id } }; }
      if (path.endsWith('/git/trees')) {
        const inventory = new Map(trees.get(body.base_tree)); assert(trees.has(body.base_tree));
        for (const row of body.tree) { if (row.sha === null) inventory.delete(row.path); else inventory.set(row.path, { ...row, bytes: blobs.get(row.sha) }); }
        return { data: { sha: storeTree(inventory) } };
      }
      if (path.endsWith('/git/commits')) return { data: { sha: addCommit(null, body.parents, body.tree) } };
      if (path.endsWith('/pulls')) { const p = makePR(tip, null); pulls.push(p); return { data: p }; }
    }
    if (method === 'PATCH' && path.endsWith('/git/refs/heads/release/next')) {
      assert.equal(body.force, false); assert(ancestors(body.sha).has(tip), 'Provider FF contract'); tip = body.sha;
      // An open PR follows its branch; its reported base is left as of creation.
      for (const p of pulls) if (p.state === 'open' && p.head.ref === 'release/next') p.head = { ...p.head, sha: tip };
      return { data: { object: { type: 'commit', sha: tip } } };
    }
    if (method === 'PATCH' && /\/pulls\/\d+$/.test(path)) {
      const p = pulls.find((p) => p.number === Number(path.split('/').at(-1))) ?? assert.fail('Unknown PR');
      assert.deepEqual(Object.keys(body).sort(), ['body', 'title']); Object.assign(p, body);
      return { data: p };
    }
    assert.fail(`Unexpected synthetic ${method} ${route}`);
  };
  const fetcher = async (url) => {
    assert.equal(new URL(url).origin, 'https://registry.npmjs.org');
    if (url === 'https://registry.npmjs.org/foottrace/latest') return Response.json({ name: 'foottrace', version: latest });
    for (const [v, value] of registry) {
      if (url === `https://registry.npmjs.org/foottrace/${v}`) return Response.json(value.metadata);
      if (url === value.metadata.dist.tarball) return new Response(value.bytes);
    }
    return new Response('{}', { status: 404 });
  };
  const publish = (source, pending = false) => {
    const inventory = trees.get(commits.get(source).tree.sha), pkg = JSON.parse(inventory.get('package.json').bytes), v = pkg.version;
    const bytes = syntheticPackageArchive(v), info = require('../../scripts/release-archive.cjs').inspectArchive(bytes, { package: 'foottrace', version: v });
    const raw = Buffer.from(JSON.stringify({ version: v, runId: 10, runAttempt: 1, sha: source, integrity: info.integrity }));
    const changelog = inventory.get('CHANGELOG.md').bytes.toString(),
      notes = changelog.split('\n').slice(4).join('\n').split('\n## ')[0].trim() + '\n'; // top section only
    const ids = 20 + 2 * releases.size; // distinct per synthetic release
    tags.set(`v${v}`, source); releases.set(`v${v}`, { id: ids, tag_name: `v${v}`, target_commitish: source, body: notes, draft: false, prerelease: false,
      assets: [{ id: ids + 1, name: `publish-attempt-${v}.json`, size: raw.length, state: 'uploaded', raw }] });
    if (!pending) { registry.set(v, { bytes, metadata: { name: 'foottrace', version: v, dist: { integrity: info.integrity, shasum: info.shasum, tarball: `https://registry.npmjs.org/foottrace/-/foottrace-${v}.tgz` } } }); latest = v; }
  };
  if (published) publish(originalMerge);
  const model = { api, calls, context, fetcher, options: { fetcher, settings: { slug: 'release-app', clientId: 'public-client-id' } },
    files: queued, blobs, commits, trees, pulls, tags, releases, registry, repository, bot, originalHead, originalMerge, originalPR,
    get tip() { return tip; }, set tip(value) { tip = value; }, get latest() { return latest; }, set latest(value) { latest = value; },
    addCommit, makeInventory, publish,
    merge: () => {
      const p = pulls.find((p) => p.state === 'open'); assert(p);
      const merged = addCommit(null, [context.sha, p.head.sha], commits.get(p.head.sha).tree.sha);
      p.base.sha = context.sha; p.state = 'closed'; p.merged = true; p.merged_at = '2026-11-01T00:00:00Z'; p.merge_commit_sha = merged;
      context.sha = merged; return merged;
    },
    advance: (change) => { const inventory = new Map(trees.get(commits.get(context.sha).tree.sha)); change(inventory); context.sha = addCommit(inventory, [context.sha]); return context.sha; },
    moveMain: () => { remoteMain = sha('4'); },
  };
  return model;
}
export function syntheticPackageArchive(version, manifest = { name: 'foottrace', version }) {
  const members = { 'package/package.json': JSON.stringify(manifest), 'package/dist/index.js': 'export const synthetic = true;\n' }, chunks = [];
  for (const [name, value] of Object.entries(members)) {
    const bytes = Buffer.from(value), header = Buffer.alloc(512);
    header.write(name, 0); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136);
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
    header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return require('node:zlib').gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
export function proposalApiFixture() {
  return managedReleaseFixture({ version: '1.8.0', published: true, metadata: true });
}
export function actualControlArgv(stage) {
  const yaml = read('.github/workflows/publish.yml');
  const command = `        run: node scripts/release-runner.cjs ${stage}`;
  const matches = yaml.split('\n').filter((line) => line === command);
  assert.equal(matches.length, 1, `Missing/ambiguous actual readable stage ${stage}`);
  return [stage];
}
let syntheticAppKeys;
export async function executeWorkflowStage(stage, { env, api, fetcher }) {
  const { runCli } = require('../../scripts/release-runner.cjs');
  let output = '',
    failure = null,
    summary = '';
  const writes = [];
  const context = {
    ...env,
    GITHUB_OUTPUT: '/offline/outputs',
    GITHUB_STEP_SUMMARY: '/offline/summary',
    RUNNER_TEMP: '/offline/temp',
    GH_TOKEN: 'offline-test-token',
  };
  if (['authority', 'release', 'publish'].includes(stage)) {
    const yaml = read('.github/workflows/publish.yml'), start = yaml.indexOf(`  ${stage}:\n`),
      rest = yaml.slice(start + `  ${stage}:\n`.length), next = /^  [a-z][a-z-]*:\n/m.exec(rest),
      block = rest.slice(0, next?.index ?? rest.length);
    assert(start >= 0);
    assert.match(block, /APP_PRIVATE_KEY: \$\{\{ secrets\.RELEASE_APP_PRIVATE_KEY \}\}/);
    syntheticAppKeys ??= generateKeyPairSync('rsa', { modulusLength: 2048 });
    context.APP_PRIVATE_KEY = syntheticAppKeys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  }
  const fetch = async (url, options = {}) => {
    if (url.startsWith('https://registry.npmjs.org/')) return fetcher(url, options);
    const parsed = new URL(url);
    let route = parsed.hostname === 'uploads.github.com' ? url : parsed.pathname + parsed.search;
    if (url === 'https://api.github.com/app') {
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.body, undefined);
      const token = options.headers.authorization;
      assert(typeof token === 'string' && token.startsWith('Bearer '), 'App JWT required');
      const parts = token.slice(7).split('.');
      assert.equal(parts.length, 3);
      assert.deepEqual(JSON.parse(Buffer.from(parts[0], 'base64url')), { alg: 'RS256', typ: 'JWT' });
      assert.equal(JSON.parse(Buffer.from(parts[1], 'base64url')).iss, context.APP_CLIENT_ID);
      assert(verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), syntheticAppKeys.publicKey,
        Buffer.from(parts[2], 'base64url')), 'Independent synthetic App signature verification');
      route = `/apps/${context.APP_SLUG}`;
    } else {
      assert(options.headers.authorization === `Bearer ${context.GH_TOKEN}`, 'Workflow token stays on other API routes');
    }
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
        status: response.status ?? 200,
        headers: { 'content-type': Buffer.isBuffer(response.data) ? 'application/octet-stream' : 'application/json' },
      });
    } catch (e) {
      if (e.status) return new Response('', { status: e.status });
      throw e;
    }
  };
  const io = {
    head: () => context.SOURCE_SHA,
    read: () => assert.fail('Unexpected project read'),
    gitTree: () => assert.fail('Unexpected build tree read'),
    requireClean: () => assert.fail('Unexpected build cleanliness command'),
    publishFile: (run, attempt) => `/offline/temp/foottrace-publish-${run}-${attempt}/package.tgz`,
    write: (name, bytes) => writes.push({ name, bytes }),
    appendOutput: (file, bytes) => {
      assert.equal(file, context.GITHUB_OUTPUT);
      output += bytes;
    },
    appendSummary: (file, bytes) => {
      assert.equal(file, context.GITHUB_STEP_SUMMARY);
      summary += bytes;
    },
  };
  try {
    await runCli(actualControlArgv(stage), { env: context, io, fetcher: fetch });
  } catch (error) {
    // Match the real runner's terminal boundary; raw codes/messages are not
    // necessarily the diagnostic the CLI prints (including owned archive keys).
    failure = require('../../scripts/release-github.cjs').refusalCode(error);
  }
  return { output, failure, exit: failure ? 1 : 0, writes, summary };
}

// Whole synthetic ZIP writer shared by native archive and RC end-to-end subjects.
export function artifactZip(entries) {
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
