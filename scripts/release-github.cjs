'use strict';
const preparation = require('./release-prepare.cjs');
const { prepareRelease } = preparation;
const control = require('./release-control.cjs');
const rcVersion = require('./release-rc-version.cjs');
const { appRequest } = require('./release-app-auth.cjs');
const fail = (code) => {
  const e = new Error(code);
  e.code = code;
  throw e;
};

// Codes are diagnostic labels, never evidence of authority. Do not inspect messages,
// stacks or arbitrary object stringification at this output boundary.
const LEGACY_CODES = new Set([
  'rc-identity',
  'rc-event',
  'rc-source',
  'rc-stable',
  'rc-proposal',
  'rc-app',
  'rc-producer',
  'rc-version',
  'rc-plan',
  'rc-tag',
  'rc-registry',
  'rc-evidence',
  'rc-phase',
  'rc-tags',
  'rc-tag-number',
  'rc-bump',
  'rc-bump-without-rc',
  'rc-release-missing',
  'rc-registry-missing',
  'rc-final-target',
  'rc-next',
  'rc-latest',
  'rc-existing-tag',
  'rc-existing-release',
  'rc-tag-create',
  'rc-release-create',
  'EEXIST',
  'api-route',
  'app-settings',
  'archive-manifest',
  'artifact-id',
  'artifact-manifest',
  'artifact-source',
  'authority-app',
  'authority-approval',
  'authority-changes-requested',
  'authority-event',
  'authority-identity',
  'authority-incomplete',
  'authority-invalid-evidence',
  'authority-plan',
  'authority-release-pr',
  'authority-review-shape',
  'authority-reviewed-tree',
  'blob',
  'build-tree',
  'checkout-sha',
  'context',
  'current-run',
  'current-run-id',
  'current-run-attempt',
  'current-run-sha',
  'current-run-repository',
  'current-run-head-repository',
  'current-run-workflow',
  'current-run-branch',
  'current-run-event',
  'current-run-ref',
  'current-run-trigger',
  'current-run-status',
  'current-run-conclusion',
  'dirty-checkout',
  'event',
  'fragment-path',
  'identity',
  'identity-changed',
  'incomplete-pages',
  'invalid-archive',
  'invalid-fragment',
  'invalid-release-docs',
  'invalid-release-input',
  'invalid-version',
  'journal-asset',
  'journal-conflict',
  'journal-grant',
  'main-moved',
  'output-limit',
  'output-path',
  'output-shape',
  'pack-identity',
  'package',
  'package-version',
  'plan-substitution',
  'pr-moved',
  'producer-attempt',
  'producer-job',
  'proposal-approved',
  'proposal-author',
  'proposal-base',
  'proposal-base-moved',
  'proposal-commit',
  'proposal-existing',
  'proposal-head',
  'proposal-plan',
  'proposal-pr',
  'proposal-ref-readback',
  'proposal-ref-write',
  'proposal-substitution',
  'proposal-tree',
  'publish-directory',
  'registry-bytes',
  'registry-conflict',
  'registry-shape',
  'registry-unavailable',
  'release-conflict',
  'release-notes',
  'release-pr',
  'release-upload-url',
  'repository',
  'reservation-ambiguous',
  'response-limit',
  'runner-output',
  'runner-summary',
  'security-job',
  'security-run',
  'source-commit',
  'source-content',
  'source-sha',
  'source-tree',
  'stage',
  'tag-conflict',
  'tag-depth',
  'tag-shape',
  'verify-unreleased-main',
  'version',
  'recovery-source',
  'recovery-intent',
  'recovery-queue',
  'recovery-payload',
  'recovery-lineage',
  'recovery-state',
  'recovery-phase',
  'recovery-ancestry',
]);
const OPERATIONS = new Set([
  'authority-main',
  'authority-merge',
  'authority-linked-prs',
  'authority-pr',
  'authority-head',
  'authority-reviews',
  'authority-permission',
  'authority-app',
  'authority-bot',
  'authority-package',
  'authority-recheck',
  'runner-context',
  'runner-checkout',
  'runner-output-encode',
  'runner-output-write',
  'runner-summary-write',
  'runner-plan',
  'runner-prepare',
  'runner-proposal',
  'runner-authority',
  'runner-verdict',
  'runner-build-manifest',
  'runner-release',
  'runner-publish',
  'runner-verify',
  'security-evidence',
  'optional',
  'github-request',
  'registry-request',
  'plan-json',
  'identity-json',
  'grant-json',
  'package-json',
  'lock-json',
  'pack-json',
  'artifact-json',
  'journal-json',
  'registry-json',
  'registry-latest-json',
  'registry-next-json',
]);
const REASONS = new Set([
  'app-auth',
  'unexpected',
  'json',
  'github-transport',
  'github-response',
  'github-body',
  'github-json',
  'registry-transport',
  'registry-body',
  'github-http-unauthorized',
  'github-http-forbidden',
  'github-http-not-found',
  'github-http-conflict',
  'github-http-invalid',
  'github-http-rate-limited',
  'github-http-server',
  'github-http-other',
]);
const CONTEXT_CODES = new Set([...OPERATIONS].flatMap((op) => [...REASONS].map((reason) => `${op}:${reason}`)));
const PRINTABLE_CODES = new Set([
  ...LEGACY_CODES,
  ...REASONS,
  ...CONTEXT_CODES,
  'release-unexpected',
  'diagnostic-operation',
]);
function ownData(value, key) {
  try {
    if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}
function refusalCode(error) {
  const archive = require('./release-archive.cjs').archiveRefusalCode(error);
  if (archive !== undefined) return archive;
  const code = ownData(error, 'code');
  return typeof code === 'string' && PRINTABLE_CODES.has(code) ? code : 'release-unexpected';
}
function diagnostic(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function contextual(error, operation) {
  if (require('./release-archive.cjs').archiveRefusalCode(error) !== undefined) return error;
  if (!OPERATIONS.has(operation)) return diagnostic('diagnostic-operation');
  const code = refusalCode(error);
  // Keep exact direct-caller contracts and already-contextualized failures intact.
  if (LEGACY_CODES.has(code) || CONTEXT_CODES.has(code) || code === 'diagnostic-operation') return error;
  const result = diagnostic(`${operation}:${REASONS.has(code) ? code : 'unexpected'}`);
  const status = ownData(error, 'status');
  if (Number.isSafeInteger(status) && status >= 100 && status <= 599) result.status = status;
  return result;
}
function withRefusalSync(operation, work) {
  if (!OPERATIONS.has(operation)) throw diagnostic('diagnostic-operation');
  try {
    return work();
  } catch (error) {
    throw contextual(error, operation);
  }
}
async function withRefusal(operation, work) {
  if (!OPERATIONS.has(operation)) throw diagnostic('diagnostic-operation');
  try {
    return await work();
  } catch (error) {
    throw contextual(error, operation);
  }
}
function parseJson(operation, bytes) {
  if (!OPERATIONS.has(operation)) throw diagnostic('diagnostic-operation');
  try {
    return JSON.parse(bytes);
  } catch {
    throw diagnostic(`${operation}:json`);
  }
}
async function registryFetch(url, fetcher) {
  try {
    return await fetcher(url, { signal: AbortSignal.timeout(30000) });
  } catch {
    throw diagnostic('registry-transport');
  }
}

const enc = encodeURIComponent;
const prefix = (context) => {
  if (context.repository?.full_name !== 'footprintjs/foottrace' || !Number.isSafeInteger(context.repository.id))
    fail('repository');
  return `/repos/${context.repository.full_name}`;
};
async function pages(api, route, key) {
  const result = [],
    seen = new Set();
  for (let page = 1; page <= 50; page++) {
    const response = await api('GET', `${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const rows = key ? response.data?.[key] : response.data;
    if (!Array.isArray(rows) || rows.length > 100) fail('incomplete-pages');
    for (const row of rows) {
      if (!Number.isSafeInteger(row.id) || seen.has(row.id)) fail('incomplete-pages');
      seen.add(row.id);
      result.push(row);
    }
    if (rows.length < 100) {
      if (key && response.data.total_count !== undefined && response.data.total_count !== result.length)
        fail('incomplete-pages');
      return result;
    }
  }
  fail('incomplete-pages');
}
async function assertCurrentMain(api, context) {
  const current = (await api('GET', `${prefix(context)}/git/ref/heads/main`)).data;
  if (current.object?.sha !== context.sha) fail('main-moved');
  return current.object.sha;
}
async function content(api, context, path) {
  if (!control.validSha(context.sha)) fail('source-sha');
  const data = (await api('GET', `${prefix(context)}/contents/${path}?ref=${context.sha}`)).data;
  if (
    data.type !== 'file' ||
    data.encoding !== 'base64' ||
    typeof data.content !== 'string' ||
    data.size > 2 * 1024 * 1024
  )
    fail('source-content');
  const bytes = Buffer.from(data.content, 'base64');
  if (bytes.length !== data.size) fail('source-content');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('source-content');
  }
}
// A view caches immutable objects only during one read phase. Every mutation phase
// creates a fresh view and repeats current-main and publication checks.
function sourceView(api, context) {
  const commits = new Map(), blobs = new Map(), inventories = new Map();
  const rawPaths = new Set(['package.json', 'package-lock.json', 'CHANGELOG.md', 'README.md', 'docs/metadata.md',
    '.github/workflows/publish.yml', 'scripts/release-app-auth.cjs', 'scripts/release-runner.cjs',
    'test/release/app-identity.test.mjs', 'test/release/archive.test.mjs', 'test/release/diagnostics.test.mjs']);
  let totalBytes = 0;
  const commit = async (id) => {
    if (!control.validSha(id)) fail('source-sha');
    if (!commits.has(id)) {
      if (commits.size >= 512) fail('recovery-source');
      const value = (await api('GET', `${prefix(context)}/git/commits/${id}`)).data;
      if (value.sha !== id || !control.validSha(value.tree?.sha) || !Array.isArray(value.parents) ||
        value.parents.length > 2 || value.parents.some((p) => !control.validSha(p.sha))) fail('source-commit');
      commits.set(id, value);
    }
    return commits.get(id);
  };
  const inventory = async (id) => {
    if (inventories.has(id)) return inventories.get(id);
    const c = await commit(id), result = new Map();
    const tree = (await api('GET', `${prefix(context)}/git/trees/${c.tree.sha}?recursive=1`)).data;
    if (tree.sha !== c.tree.sha || tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length > 4096)
      fail('source-tree');
    const seen = new Set();
    for (const row of tree.tree) {
      if (typeof row.path !== 'string' || seen.has(row.path) || !control.validSha(row.sha)) fail('source-tree');
      seen.add(row.path);
      if (row.type === 'tree' && row.mode === '040000') continue;
      if (row.type !== 'blob' || !['100644', '100755'].includes(row.mode)) fail('source-tree');
      // The complete immutable path/OID/mode inventory is the existing Git
      // source identity basis. Fetch raw bytes only for semantic admission and
      // the finite byte-transition exceptions, never a compare.files subset.
      const needsBytes = rawPaths.has(row.path) || row.path.startsWith('.changes/') || row.path.startsWith('.release/');
      if (needsBytes && !blobs.has(row.sha)) {
        const value = (await api('GET', `${prefix(context)}/git/blobs/${row.sha}`)).data;
        if (value.sha !== row.sha || value.encoding !== 'base64' || typeof value.content !== 'string' ||
          !Number.isSafeInteger(value.size) || value.size < 0 || value.size > 2 * 1024 * 1024 ||
          !/^[A-Za-z0-9+/=\r\n]*$/.test(value.content) || value.content.length > 3 * 1024 * 1024) fail('source-content');
        const bytes = Buffer.from(value.content, 'base64');
        totalBytes += bytes.length;
        if (bytes.length !== value.size || totalBytes > 128 * 1024 * 1024 ||
          preparation.gitObject('blob', bytes) !== row.sha) fail('source-content');
        blobs.set(row.sha, bytes);
      }
      result.set(row.path, { sha: row.sha, mode: row.mode, ...(needsBytes ? { bytes: blobs.get(row.sha) } : {}) });
    }
    if (preparation.treeOid(result) !== c.tree.sha) fail('source-tree');
    inventories.set(id, result);
    return result;
  };
  return { commit, inventory };
}
function packageIdentity(inventory, version) {
  const raw = (name) => {
    const row = inventory.get(name);
    if (!row || row.mode !== '100644') fail('package-version');
    return preparation.decodeRaw(row.bytes);
  };
  const pkg = parseJson('package-json', raw('package.json')),
    lock = parseJson('lock-json', raw('package-lock.json'));
  preparation.parseVersion(pkg.version);
  if (pkg.name !== 'foottrace' || lock.name !== pkg.name || lock.version !== pkg.version ||
    lock.packages?.['']?.name !== pkg.name || lock.packages[''].version !== pkg.version ||
    (version !== undefined && pkg.version !== version)) fail('package-version');
  return pkg;
}
async function sourceInput(api, context, view = sourceView(api, context)) {
  const commit = await view.commit(context.sha), inventory = await view.inventory(context.sha), files = {}, fragments = {};
  for (const path of ['package.json', 'package-lock.json', 'CHANGELOG.md', 'README.md', 'docs/metadata.md']) {
    const row = inventory.get(path);
    if (!row || row.mode !== '100644') fail('source-content');
    files[path] = preparation.decodeRaw(row.bytes);
  }
  const pkg = packageIdentity(inventory), queue = preparation.fragmentQueue(inventory);
  for (const row of queue) fragments[row.path.slice(9)] = preparation.decodeRaw(inventory.get(row.path).bytes);
  const intents = preparation.admitIntentNamespace(inventory, pkg.version, context.repository);
  const date = new Date(commit.committer?.date).toISOString().slice(0, 10);
  return { commit, inventory, files, fragments, queue, intents, date, pkg, view };
}
async function requireAncestor(api, context, from, to) {
  if (![from, to].every(control.validSha)) fail('recovery-ancestry');
  const seen = new Set(); let counts;
  for (let page = 1; page <= 10; page++) {
    const value = (await api('GET', `${prefix(context)}/compare/${from}...${to}?per_page=100&page=${page}`)).data;
    const tuple = [value.status, value.ahead_by, value.behind_by, value.total_commits];
    if (value.base_commit?.sha !== from || value.merge_base_commit?.sha !== from ||
      value.behind_by !== 0 || !Number.isSafeInteger(value.ahead_by) || value.ahead_by < 0 || value.ahead_by > 1000 ||
      value.total_commits !== value.ahead_by || !Array.isArray(value.commits) || value.commits.length > 100 ||
      (counts && JSON.stringify(counts) !== JSON.stringify(tuple))) fail('recovery-ancestry');
    counts = tuple;
    if (from === to) {
      if (page !== 1 || value.status !== 'identical' || value.ahead_by !== 0 || value.commits.length) fail('recovery-ancestry');
      return;
    }
    if (value.status !== 'ahead' || value.ahead_by === 0) fail('recovery-ancestry');
    for (const c of value.commits) {
      if (!control.validSha(c.sha) || c.sha === from || seen.has(c.sha)) fail('recovery-ancestry');
      seen.add(c.sha);
    }
    if (seen.size > value.total_commits) fail('recovery-ancestry');
    if (seen.size === value.total_commits) {
      if (value.commits.at(-1)?.sha !== to) fail('recovery-ancestry');
      return;
    }
    if (value.commits.length !== 100) fail('recovery-ancestry');
  }
  fail('recovery-ancestry');
}
async function publicBot(api, settings) {
  if (!/^[a-z0-9-]+$/.test(settings?.slug ?? '')) fail('app-settings');
  const bot = (await api('GET', `/users/${enc(settings.slug + '[bot]')}`)).data;
  if (bot.login !== settings.slug + '[bot]' || bot.type !== 'Bot' || !Number.isSafeInteger(bot.id) || bot.id <= 0)
    fail('recovery-lineage');
  return bot;
}
async function mergedLineage(api, context, view, bot, prNumber, version) {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) fail('recovery-lineage');
  const p = (await api('GET', `${prefix(context)}/pulls/${prNumber}`)).data;
  if (p.number !== prNumber || p.state !== 'closed' || !p.merged_at || p.merged !== true ||
    !control.sameRepo(p.base?.repo, context.repository) || !control.sameRepo(p.head?.repo, context.repository) ||
    p.base.ref !== 'main' || p.head.ref !== 'release/next' || p.user?.id !== bot.id ||
    p.user.type !== 'Bot' || p.user.login !== bot.login || !control.validSha(p.merge_commit_sha) ||
    !control.validSha(p.head.sha) || !control.validSha(p.base.sha)) fail('recovery-lineage');
  const h = await view.commit(p.head.sha), s = await view.commit(p.merge_commit_sha);
  if (h.tree.sha !== s.tree.sha) fail('recovery-lineage');
  packageIdentity(await view.inventory(p.head.sha), version);
  packageIdentity(await view.inventory(p.merge_commit_sha), version);
  return { pr: p.number, head: h.sha, tree: h.tree.sha, merge: s.sha };
}
async function linkedLineage(api, context, view, bot, source, version) {
  const rows = await pages(api, `${prefix(context)}/commits/${source}/pulls`);
  const matches = rows.filter((p) => p.merge_commit_sha === source && p.head?.ref === 'release/next');
  if (matches.length !== 1) fail('recovery-lineage');
  return mergedLineage(api, context, view, bot, matches[0].number, version);
}
function exactData(a, b, code = 'recovery-intent') {
  if (JSON.stringify(a) !== JSON.stringify(b)) fail(code);
}
function addedInventory(base, path, bytes) {
  if (base.has(path)) fail('recovery-intent');
  return new Map([...base, [path, { mode: '100644', sha: preparation.gitObject('blob', bytes), bytes }]]);
}
// Every active record is rebound to its immutable proposal base and App lineage.
// Valid old-version records are schema/chain checked but confer no authority.
async function activeHistory(api, context, input, bot) {
  const chain = input.intents.active;
  for (let i = 0; i < chain.length; i++) {
    const record = chain[i], d = record.data, base = await input.view.inventory(d.base.sha),
      c = await input.view.commit(d.base.sha);
    if (c.tree.sha !== d.base.tree) fail('recovery-intent');
    const baseRecords = preparation.admitIntentNamespace(base, d.version, context.repository);
    if (baseRecords.active.length !== i) fail('recovery-intent');
    for (let j = 0; j < i; j++) {
      if (baseRecords.active[j].path !== chain[j].path || baseRecords.active[j].sha256 !== chain[j].sha256) fail('recovery-intent');
    }
    exactData(preparation.fragmentQueue(base), d.queuedFragments, 'recovery-queue');
    const predecessor = await mergedLineage(api, context, input.view, bot, d.predecessor.pr, d.version);
    exactData(predecessor, d.predecessor);
    const origin = await mergedLineage(api, context, input.view, bot, d.origin.pr, d.version);
    exactData(origin, d.origin);
    await requireAncestor(api, context, predecessor.merge, d.base.sha);
    if (i) {
      preparation.requireQueueSubset(chain[i - 1].data.queuedFragments, d.queuedFragments);
      // Immediate predecessor must be the App merge of the preceding intent.
      await requireRecoveryMerge(api, context, input.view, bot, chain[i - 1], predecessor);
    }
    const original = await input.view.inventory(origin.head);
    preparation.requirePublicationClosure(original, base, new Set(baseRecords.records.map((x) => x.path)));
  }
}
async function requireRecoveryMerge(api, context, view, bot, record, lineage) {
  const d = record.data, head = await view.commit(lineage.head), merged = await view.commit(lineage.merge),
    base = await view.inventory(d.base.sha), candidate = await view.inventory(head.sha);
  exactData(head.parents.map((p) => p.sha), [d.base.sha, d.predecessor.head]);
  const expected = addedInventory(base, record.path, preparation.intentBytes(d, context.repository));
  if (preparation.treeOid(expected) !== head.tree.sha || merged.tree.sha !== head.tree.sha ||
    preparation.treeOid(candidate) !== head.tree.sha) fail('recovery-intent');
  const pr = (await api('GET', `${prefix(context)}/pulls/${lineage.pr}`)).data;
  if (pr.base.sha !== d.base.sha) fail('recovery-lineage');
  await requireAncestor(api, context, d.base.sha, lineage.merge);
}
// `movedBase` admits an open proposal whose recorded base is older than main; the
// caller must then account for that base and the head before any decision.
// `unfinished` admits a head that no pull request from `release/next` into main names,
// in any state: a proposal write that moved the ref and stopped before the pull request.
// The caller must then show the head to be the runner's own work before any decision,
// and that no pull request names any rebuild under it either (`listed`).
async function retainedProposal(api, context, view, bot, version, { movedBase = false, unfinished = false } = {}) {
  const base = prefix(context), ref = await optional(api, `${base}/git/ref/heads/release/next`);
  const pulls = await pages(api, `${base}/pulls?state=open&head=footprintjs:release/next&base=main`);
  if (!ref || ref.object?.type !== 'commit' || !control.validSha(ref.object.sha) || pulls.length > 1) fail('proposal-existing');
  const head = await view.commit(ref.object.sha);
  if (pulls.length) {
    const p = pulls[0];
    if (p.state !== 'open' || p.head?.sha !== head.sha || !control.validSha(p.base?.sha) ||
      (p.base.sha !== context.sha && !movedBase) ||
      p.head.ref !== 'release/next' || p.base.ref !== 'main' ||
      !control.sameRepo(p.head.repo, context.repository) || !control.sameRepo(p.base.repo, context.repository)) fail('proposal-existing');
    if (p.user?.id !== bot.id || p.user.type !== 'Bot' || p.user.login !== bot.login) fail('proposal-author');
    return { head, open: p };
  }
  const closed = await pages(api, `${base}/pulls?state=closed&head=footprintjs:release/next&base=main`);
  const matches = closed.filter((p) => p.head?.sha === head.sha && p.merged_at);
  if (unfinished && matches.length === 0) {
    // Here the absence of a pull request permits a write, so it is read from ONE listing of
    // every state: a pull request that is closed between the two listings above is in neither
    // of them, and it is in this one. A proposal a maintainer closed keeps its hold.
    const listed = await pages(api, `${base}/pulls?state=all&head=footprintjs:release/next&base=main`);
    if (!listed.some((p) => p.head?.sha === head.sha)) return { head, unfinished: true, listed };
  }
  if (matches.length !== 1) fail('proposal-existing');
  const predecessor = await mergedLineage(api, context, view, bot, matches[0].number, version);
  if (predecessor.head !== head.sha) fail('proposal-existing');
  await requireAncestor(api, context, predecessor.merge, context.sha);
  return { head, predecessor };
}
// The tree a NEXT proposal must hold: the source inventory plus the prepared release.
function proposalTree(inventory, prepared) {
  const candidate = new Map(inventory);
  for (const [path, text] of Object.entries(prepared.updates)) {
    const bytes = Buffer.from(text);
    candidate.set(path, { bytes, mode: '100644', sha: preparation.gitObject('blob', bytes) });
  }
  for (const path of prepared.deletions) candidate.delete(path);
  return preparation.treeOid(candidate);
}
// A base the route built on must still be in current main's history.
async function accountedBase(api, context, sha) {
  try {
    await requireAncestor(api, context, sha, context.sha);
  } catch (e) {
    if (ownData(e, 'code') === 'recovery-ancestry') fail('proposal-base-moved');
    throw e;
  }
}
const MAX_PROPOSAL_GENERATIONS = 8;
// Walks back from a proposal commit to the App release merge it rolled over. Each
// generation that is not a merged App head must be exactly what this runner builds
// at its own first parent, an older main; its second parent is the generation
// before it. A commit pushed by hand, or any other content, cannot satisfy that.
// `unnamed` is every pull request from `release/next` into main, given when the walk
// serves an unfinished head: no generation in that chain may ever have had a pull
// request. A proposal that was closed keeps its hold when a later head was built on it.
async function proposalLineage(api, context, view, bot, version, start, unnamed) {
  const closed = await pages(api, `${prefix(context)}/pulls?state=closed&head=footprintjs:release/next&base=main`);
  let id = start;
  for (let depth = 0; depth <= MAX_PROPOSAL_GENERATIONS; depth++) {
    const merged = closed.filter((p) => p.head?.sha === id && p.merged_at);
    if (merged.length > 1) fail('proposal-existing');
    if (merged.length === 1) {
      const predecessor = await mergedLineage(api, context, view, bot, merged[0].number, version);
      if (predecessor.head !== id) fail('proposal-existing');
      await requireAncestor(api, context, predecessor.merge, context.sha);
      return predecessor;
    }
    if (depth === MAX_PROPOSAL_GENERATIONS) break;
    if (unnamed?.some((p) => p.head?.sha === id)) fail('proposal-existing');
    const generation = await view.commit(id), parents = generation.parents.map((p) => p.sha);
    if (parents.length !== 2 || parents[0] === context.sha) fail('proposal-head');
    await accountedBase(api, context, parents[0]);
    const input = await sourceInput(api, { ...context, sha: parents[0] }, view);
    if (input.pkg.version !== version) fail('proposal-base-moved');
    let prepared;
    try {
      prepared = prepareRelease({ files: input.files, fragments: input.fragments, date: input.date });
    } catch {
      fail('proposal-head');
    }
    if (proposalTree(input.inventory, prepared) !== generation.tree.sha) fail('proposal-head');
    id = parents[1];
  }
  fail('proposal-base-moved');
}
// An approval names one head. Rebuilding under it would leave a reviewed-looking
// PR on unreviewed bytes, so any approval on the open proposal holds the rebuild.
async function requireUnapproved(api, context, open) {
  const reviews = await pages(api, `${prefix(context)}/pulls/${open.number}/reviews`);
  if (reviews.some((r) => r.state === 'APPROVED')) fail('proposal-approved');
}
async function recoveryPreparation(api, context, input, bot) {
  await activeHistory(api, context, input, bot);
  const prior = input.intents.active.at(-1), retained = await retainedProposal(api, context, input.view, bot, input.pkg.version);
  // An exact open recovery head describes its predecessor inside the new record.
  let predecessor = retained.predecessor;
  if (retained.open) {
    const candidate = await input.view.inventory(retained.head.sha), records = preparation.admitIntentNamespace(candidate, input.pkg.version, context.repository);
    const record = records.active.at(-1);
    if (!record || record.data.sequence !== (prior?.data.sequence ?? 0) + 1) fail('proposal-existing');
    predecessor = await mergedLineage(api, context, input.view, bot, record.data.predecessor.pr, input.pkg.version);
  }
  const origin = prior?.data.origin ?? predecessor;
  if (prior) {
    await requireRecoveryMerge(api, context, input.view, bot, prior, predecessor);
    preparation.requireQueueSubset(prior.data.queuedFragments, input.queue);
  }
  const original = await input.view.inventory(origin.head);
  preparation.requirePublicationClosure(original, input.inventory, new Set(input.intents.records.map((x) => x.path)));
  if (!input.queue.length) fail('recovery-queue');
  const prepared = preparation.prepareRecovery({ repository: context.repository, sha: context.sha,
    tree: input.commit.tree.sha, version: input.pkg.version, origin, predecessor, previous: prior,
    queue: input.queue, notes: await sourceReleaseNotes(api, context, input.pkg.version) });
  const [[path, text]] = Object.entries(prepared.updates), expectedTree = preparation.treeOid(addedInventory(input.inventory, path, Buffer.from(text)));
  if (retained.open) {
    exactData(retained.head.parents.map((p) => p.sha), [context.sha, predecessor.head], 'proposal-existing');
    if (retained.head.tree.sha !== expectedTree) fail('proposal-existing');
  }
  return { prepared, expectedTree, predecessor, retained };
}
async function currentRecovery(api, context, input, bot) {
  const record = input.intents.active.at(-1);
  if (!record) return false;
  await activeHistory(api, context, input, bot);
  const lineage = await linkedLineage(api, context, input.view, bot, context.sha, input.pkg.version);
  await requireRecoveryMerge(api, context, input.view, bot, record, lineage);
  exactData(input.queue, record.data.queuedFragments, 'recovery-queue');
  preparation.requirePublicationClosure(await input.view.inventory(record.data.origin.head), input.inventory,
    new Set(input.intents.records.map((x) => x.path)));
  return true;
}
async function requireRecoverySource(api, context, identity, options) {
  // Ordinary releases retain their original authority/grant contracts. A complete
  // immutable tree decides whether additional recovery-data obligations exist;
  // neither a plan flag nor artifact omission can suppress those obligations.
  const tree = (await api('GET', `${prefix(context)}/git/trees/${identity.tree}?recursive=1`)).data;
  if (tree.sha !== identity.tree || tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length > 4096)
    fail('source-tree');
  const paths = new Set();
  for (const row of tree.tree) {
    if (typeof row.path !== 'string' || Buffer.byteLength(row.path) > 1024 || /[\x00-\x1f\x7f\\]/.test(row.path) ||
      row.path.split('/').some((part) => !part || part === '.' || part === '..') || paths.has(row.path) || !control.validSha(row.sha) ||
      !((row.type === 'blob' && ['100644', '100755'].includes(row.mode)) ||
        (row.type === 'tree' && row.mode === '040000'))) fail('source-tree');
    paths.add(row.path);
  }
  if (![...paths].some((path) => path.startsWith('.release/'))) return false;
  const input = await sourceInput(api, context);
  if (input.commit.tree.sha !== identity.tree || input.pkg.version !== identity.version) fail('identity-changed');
  if (input.intents.active.length) await currentRecovery(api, context, input, await publicBot(api, options.settings));
  await assertCurrentMain(api, context);
  return input.intents.active.length > 0;
}
async function rcTagRefs(api, context) {
  // GitHub's matching-refs endpoint returns the complete matching array; it has
  // no pagination parameters. Ref names, not response order, select RC numbers.
  const rows = (await api('GET', prefix(context) + '/git/matching-refs/tags/v')).data;
  if (!Array.isArray(rows) || rows.length > 4096) fail('rc-tags');
  const seen = new Set();
  for (const row of rows) {
    if (typeof row?.ref !== 'string' || !row.ref.startsWith('refs/tags/v') ||
        seen.has(row.ref) || !['commit', 'tag'].includes(row.object?.type) ||
        !control.validSha(row.object.sha)) fail('rc-tags');
    seen.add(row.ref);
  }
  return [...seen];
}
async function rcSource(api, context, pinned, phase, options) {
  if (context.rc !== true || context.verify === true || context.eventName !== 'workflow_dispatch' ||
      context.ref !== 'refs/heads/main' || !['initial', 'publish'].includes(phase)) fail('rc-event');
  await assertCurrentMain(api, context);
  const input = await sourceInput(api, context);
  if (input.intents.active.length) await activeHistory(api, context, input, await publicBot(api, options.settings));
  const pulls = await pages(api, prefix(context) + '/pulls?state=open&head=footprintjs:release/next&base=main');
  if (pulls.length) fail('rc-proposal');
  const publication = await publicationState(api, context, input, options);
  if (publication.state !== 'published' || publication.latest !== input.pkg.version) fail('rc-stable');
  const selectedVersion = phase === 'initial' ?
    rcVersion.candidateVersion(input.pkg.version, context.bump, await rcTagRefs(api, context)) : undefined,
    version = pinned?.version ?? selectedVersion;
  if (rcVersion.candidateCore(version) !== rcVersion.targetVersion(input.pkg.version, context.bump) ||
      (phase === 'initial' && selectedVersion !== version)) fail('rc-plan');
  const expected = { mode: 'rc', repository: context.repository, sourceSha: context.sha,
    tree: input.commit.tree.sha, package: input.pkg.name, fromVersion: input.pkg.version,
    version, tag: 'v' + version };
  const tag = await peeledTag(api, context, expected.tag), registry = await registryVersion(version, options.fetcher);
  if (phase === 'initial' ? tag !== null : tag !== context.sha) fail('rc-tag');
  if (phase === 'initial' && registry !== null) fail('rc-registry');
  await assertCurrentMain(api, context);
  return { expected, input, publication, pulls, selectedVersion, tag, registry };
}

function requireFinalRcTarget(current, target, refs) {
  let newest = null;
  for (const ref of refs) {
    if (!/^refs\/tags\/v[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$/.test(ref)) continue;
    const core = rcVersion.candidateCore(ref.slice('refs/tags/v'.length));
    if (preparation.versionOrder(core, current) > 0 &&
        (newest === null || preparation.versionOrder(core, newest) > 0)) newest = core;
  }
  if (newest !== null && target !== newest) fail('rc-final-target');
}

async function plan(api, context, options = {}) {
  if (context.rc !== true && context.bump && context.bump !== 'none') fail('rc-bump-without-rc');
  if (!['push', 'workflow_dispatch'].includes(context.eventName) || context.ref !== 'refs/heads/main' || !control.validSha(context.sha)) fail('event');
  const repo = (await api('GET', prefix(context))).data;
  if (!control.sameRepo(repo, context.repository)) fail('repository');
  await assertCurrentMain(api, context);
  if (context.rc === true) {
    const { expected, input } = await rcSource(api, context, null, 'initial', options);
    return { mode: 'rc', repository: context.repository, sha: context.sha, tree: expected.tree,
      version: expected.version, fromVersion: expected.fromVersion, package: expected.package, date: input.date };
  }
  const input = await sourceInput(api, context);
  if (input.intents.active.length) await activeHistory(api, context, input, await publicBot(api, options.settings));
  const classification = await publicationState(api, context, input, options);
  let mode, preparationKind;
  if (context.verify === true || classification.state === 'pending') mode = 'verify';
  else if (classification.state === 'published') {
    if (input.queue.length) { mode = 'prepare'; preparationKind = 'next'; }
    else mode = 'verify';
  } else if (classification.state === 'absent') {
    if (input.intents.active.length) {
      // A later process-only main can continue the chain; only an actual current
      // recovery merge may publish. No missing linked-PR read is caught as absence.
      const last = input.intents.active.at(-1);
      const linked = await pages(api, `${prefix(context)}/commits/${context.sha}/pulls`);
      const current = linked.filter((p) => p.merge_commit_sha === context.sha && p.head?.ref === 'release/next');
      if (current.length > 1) fail('recovery-lineage');
      if (current.length === 1) {
        const bot = await publicBot(api, options.settings);
        await currentRecovery(api, context, input, bot); mode = 'publish';
      } else {
        if (last.data.base.sha === context.sha) fail('recovery-intent');
        await recoveryPreparation(api, context, input, await publicBot(api, options.settings));
        mode = 'prepare'; preparationKind = 'recovery';
      }
    } else if (input.queue.length) {
      await recoveryPreparation(api, context, input, await publicBot(api, options.settings));
      mode = 'prepare'; preparationKind = 'recovery';
    } else mode = 'publish';
  } else fail('recovery-state');
  const prepared = preparationKind === 'next' ? prepareRelease({ files: input.files, fragments: input.fragments, date: input.date }) : null;
  if (prepared) requireFinalRcTarget(input.pkg.version, prepared.version, await rcTagRefs(api, context));
  await assertCurrentMain(api, context);
  return { mode, ...(preparationKind ? { preparationKind } : {}), repository: context.repository, sha: context.sha,
    tree: input.commit.tree.sha, version: prepared?.version ?? input.pkg.version, package: input.pkg.name, date: input.date };
}
async function prepareProposal(api, context, pinned, options = {}) {
  const fresh = await plan(api, context, options);
  exactData(fresh, pinned, 'proposal-plan');
  if (pinned.mode !== 'prepare' || !['next', 'recovery'].includes(pinned.preparationKind)) fail('proposal-plan');
  const input = await sourceInput(api, context);
  let prepared;
  if (pinned.preparationKind === 'next') prepared = prepareRelease({ files: input.files, fragments: input.fragments, date: input.date });
  else prepared = (await recoveryPreparation(api, context, input, await publicBot(api, options.settings))).prepared;
  if (!prepared || prepared.version !== pinned.version || input.commit.tree.sha !== pinned.tree || input.date !== pinned.date) fail('proposal-plan');
  await assertCurrentMain(api, context);
  return { base: context.sha, tree: pinned.tree, repository: context.repository, prepared };
}
async function collectApp(api, settings) {
  if (!/^[a-z0-9-]+$/.test(settings.slug ?? '') || typeof settings.clientId !== 'string' || !settings.clientId)
    fail('app-settings');
  const metadata = await withRefusal(
    'authority-app',
    async () => (await api('GET', `/apps/${enc(settings.slug)}`)).data,
  );
  const bot = await withRefusal(
    'authority-bot',
    async () => (await api('GET', `/users/${enc(settings.slug + '[bot]')}`)).data,
  );
  return { expectedClientId: settings.clientId, expectedSlug: settings.slug, metadata, bot };
}

async function collectRcAuthority(api, context, pinned, role, options = {}) {
  if (!['authority', 'release', 'publish'].includes(role)) fail('rc-phase');
  const phase = role === 'publish' ? 'publish' : 'initial',
    w = await rcSource(api, context, pinned, phase, options), e = w.expected;
  const freshPlan = { mode: 'rc', repository: context.repository, sha: context.sha, tree: e.tree,
    version: e.version, fromVersion: e.fromVersion, package: e.package, date: w.input.date };
  exactData(freshPlan, pinned, 'rc-plan');
  const app = await collectApp(api, options.settings),
    producer = await producerIdentity(api, context, role);
  const result = control.decideRcAuthority({ expected: e, bump: context.bump,
    event: { name: context.eventName, ref: context.ref, sha: context.sha, repository: context.repository },
    sourceCommit: w.input.commit, sourcePackage: w.input.pkg,
    publication: w.publication, pullsComplete: true, pulls: w.pulls, app,
    runId: context.runId, runAttempt: context.runAttempt, producer,
    selectedVersion: w.selectedVersion, tag: w.tag, registry: w.registry }, phase);
  if (!result.authorized) fail(result.reason);
  await requireSecurity(api, e);
  await assertCurrentMain(api, context);
  return { identity: result.identity, registry: w.registry };
}

async function collectAuthority(api, context, settings) {
  await withRefusal('authority-main', () => assertCurrentMain(api, context));
  const base = prefix(context),
    commit = await withRefusal(
      'authority-merge',
      async () => (await api('GET', `${base}/git/commits/${context.sha}`)).data,
    );
  const linked = await withRefusal('authority-linked-prs', () => pages(api, `${base}/commits/${context.sha}/pulls`));
  const candidates = linked.filter((p) => p.head?.ref === 'release/next' && p.merge_commit_sha === context.sha);
  if (candidates.length !== 1) fail('release-pr');
  const p = await withRefusal(
    'authority-pr',
    async () => (await api('GET', `${base}/pulls/${candidates[0].number}`)).data,
  );
  const headCommit = await withRefusal(
    'authority-head',
    async () => (await api('GET', `${base}/git/commits/${p.head.sha}`)).data,
  );
  const reviews = await withRefusal('authority-reviews', () => pages(api, `${base}/pulls/${p.number}/reviews`)),
    reviewerPermissions = [];
  for (const user of new Map(reviews.filter((r) => r.user?.type === 'User').map((r) => [r.user.id, r.user])).values()) {
    const permission = await withRefusal(
      'authority-permission',
      async () => (await api('GET', `${base}/collaborators/${enc(user.login)}/permission`)).data,
    );
    reviewerPermissions.push(permission);
  }
  const app = await collectApp(api, settings);
  const pkg = await withRefusal('authority-package', async () =>
    parseJson('package-json', await content(api, context, 'package.json')),
  );
  const expected = {
    repository: context.repository,
    baseRef: 'main',
    headRef: 'release/next',
    mergeSha: context.sha,
    headSha: p.head.sha,
    tree: commit.tree.sha,
    package: pkg.name,
    version: pkg.version,
    tag: `v${pkg.version}`,
    pr: p.number,
  };
  const world = {
    expected,
    event: { name: context.eventName, ref: context.ref, sha: context.sha, repository: context.repository },
    commit,
    headCommit,
    app,
    pullsComplete: true,
    reviewsComplete: true,
    permissionsComplete: true,
    pulls: [p],
    reviews,
    reviewerPermissions,
  };
  const result = control.decideAuthority(world);
  if (!result.authorized) fail(`authority-${result.reason}`);
  // The final mutable PR view must still bind the same exact reviewed head.
  const fresh = await withRefusal(
    'authority-recheck',
    async () => (await api('GET', `${base}/pulls/${p.number}`)).data,
  );
  if (fresh.head?.sha !== p.head.sha || fresh.merge_commit_sha !== context.sha || !fresh.merged_at) fail('pr-moved');
  return expected;
}
async function workflowEvidence(api, identity, file) {
  if (identity.mode === 'rc' && !control.validSha(identity.sourceSha)) fail('security-run');
  const base = prefix(identity), rc = identity.mode === 'rc',
    source = rc ? identity.sourceSha : identity.headSha, event = rc ? 'push' : 'pull_request',
    workflow = (await api('GET', `${base}/actions/workflows/${file}`)).data;
  const runs = await pages(
    api,
    `${base}/actions/workflows/${workflow.id}/runs?event=${event}&head_sha=${source}${rc ? '&branch=main' : ''}`,
    'workflow_runs',
  );
  const selected = runs
    .filter(
      (r) =>
        r.head_sha === source &&
        r.event === event &&
        control.sameRepo(r.head_repository, identity.repository) &&
        (!rc || (r.head_branch === 'main' && control.sameRepo(r.repository, identity.repository))),
    )
    .sort((a, b) => b.id - a.id)[0];
  if (!selected) return { workflow, runs, runsComplete: true, jobs: [], jobsComplete: true };
  if (rc && (!Number.isSafeInteger(selected.run_attempt) || selected.run_attempt <= 0)) fail('security-run');
  const attempt = (await api('GET', `${base}/actions/runs/${selected.id}/attempts/${selected.run_attempt}`)).data;
  const jobs = await pages(api, `${base}/actions/runs/${selected.id}/attempts/${selected.run_attempt}/jobs`, 'jobs');
  return { workflow, runs, attempt, jobs, runsComplete: true, jobsComplete: true };
}
async function ciVerdict(api, identity) {
  try {
    return control.decideCiReuse({ expected: identity, ...(await workflowEvidence(api, identity, 'ci.yml')) });
  } catch {
    return { tested: false, fallback: 'both-full-runtime-gates', reason: 'evidence-unavailable' };
  }
}
async function requireSecurity(api, identity) {
  return withRefusal('security-evidence', async () => {
    const w = await workflowEvidence(api, identity, 'codeql.yml'), rc = identity.mode === 'rc',
      source = rc ? identity.sourceSha : identity.headSha,
      r = (rc ? w.runs.filter((r) => r.head_sha === source && r.event === 'push' &&
        r.head_branch === 'main' && control.sameRepo(r.repository, identity.repository) &&
        control.sameRepo(r.head_repository, identity.repository)) : [...w.runs]).sort((a, b) => b.id - a.id)[0];
    if (
      w.workflow.path !== '.github/workflows/codeql.yml' ||
      !r ||
      r.head_sha !== source ||
      r.event !== (rc ? 'push' : 'pull_request') ||
      (rc && (r.head_branch !== 'main' || !control.sameRepo(r.repository, identity.repository) ||
        !control.validSha(source) || w.attempt?.head_sha !== source ||
        w.attempt?.event !== 'push' || w.attempt?.head_branch !== 'main' ||
        !control.sameRepo(w.attempt?.repository, identity.repository) ||
        !control.sameRepo(w.attempt?.head_repository, identity.repository))) ||
      !control.sameRepo(r.head_repository, identity.repository) ||
      r.workflow_id !== w.workflow.id ||
      r.path !== w.workflow.path ||
      !control.success(r) ||
      !control.success(w.attempt) ||
      w.attempt.id !== r.id ||
      w.attempt.run_attempt !== r.run_attempt
    )
      fail('security-run');
    for (const name of ['Analyze (javascript-typescript)', 'Analyze (actions)']) {
      const jobs = w.jobs.filter((j) => j.name === name);
      if (
        jobs.length !== 1 ||
        !control.success(jobs[0]) ||
        jobs[0].run_id !== r.id ||
        jobs[0].run_attempt !== r.run_attempt ||
        (rc && jobs[0].head_sha !== source)
      )
        fail('security-job');
    }
    return { runId: r.id, attempt: r.run_attempt };
  });
}
async function reserveAttempt(api, release, marker) {
  if (
    !/^https:\/\/uploads\.github\.com\/repos\/footprintjs\/foottrace\/releases\/\d+\/assets\{\?name,label\}$/.test(
      release.upload_url ?? '',
    )
  )
    fail('release-upload-url');
  const url = release.upload_url.replace('{?name,label}', `?name=${enc(`publish-attempt-${marker.version}.json`)}`);
  const bytes = Buffer.from(JSON.stringify(marker) + '\n');
  const r = await api('POST', url, { raw: bytes, contentType: 'application/json' });
  if (typeof marker.version === 'string' && marker.version.includes('-rc.') && r.status !== 201) fail('reservation-ambiguous');
  if (r.data?.state !== 'uploaded' || r.data.size !== bytes.length || (!Number.isSafeInteger(r.data.id) || r.data.id <= 0))
    fail('reservation-ambiguous');
  return { assetId: r.data.id, fresh: true };
}
async function optional(api, route) {
  try {
    return (await api('GET', route)).data;
  } catch (e) {
    if (ownData(e, 'status') === 404) return null;
    throw contextual(e, 'optional');
  }
}
// GitHub can take a moment to show a ref update in its own reads. The branch is read at most
// three times, one second apart, and only while it still shows the head from before the update:
// that answer says the update is not visible yet. Any other answer is an observation of something
// else; it is returned at once and never read again, so it cannot be replaced by a later read.
async function readUpdatedRef(api, context, from, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  for (let n = 0; ; n++) {
    const current = (await api('GET', `${prefix(context)}/git/ref/heads/release/next`)).data;
    if (n === 2 || current.object?.sha !== from) return current;
    await wait(1000);
  }
}
async function proposalPreflight(api, context, payload, pinned, options) {
  if (payload?.base !== context.sha || !control.sameRepo(payload.repository, context.repository)) fail('proposal-base');
  const rebuilt = await prepareProposal(api, context, pinned, options);
  exactData(payload, rebuilt, 'proposal-substitution');
  const input = await sourceInput(api, context), bot = await publicBot(api, options.settings);
  const expectedTree = proposalTree(input.inventory, rebuilt.prepared);
  let retained, predecessor, prior, rebuild, unfinished;
  if (pinned.preparationKind === 'recovery') {
    // A recovery record binds its own base; a moved base needs the next record.
    const recovery = await recoveryPreparation(api, context, input, bot);
    retained = recovery.retained; predecessor = recovery.predecessor;
    if (expectedTree !== recovery.expectedTree) fail('proposal-tree');
  } else {
    retained = await retainedProposal(api, context, input.view, bot, input.pkg.version, { movedBase: true, unfinished: true });
    predecessor = retained.predecessor;
    if (retained.unfinished) {
      // An earlier run moved the branch and stopped before the pull request. The head is
      // taken up only as the runner's own work, shown by its bytes and its parents, never
      // because an earlier run wrote it.
      const parents = retained.head.parents.map((p) => p.sha);
      if (parents.length !== 2) fail('proposal-head');
      if (parents[0] === context.sha) {
        // Built on this main: it must be exactly this run's proposal; only the pull request is missing.
        if (retained.head.tree.sha !== expectedTree) fail('proposal-head');
        predecessor = await proposalLineage(api, context, input.view, bot, input.pkg.version, parents[1], retained.listed);
        if (parents[1] !== predecessor.head) prior = parents[1];
      } else {
        // Built on an older main, which must be in current main's history: rebuild it on this
        // main, keeping it as second parent so the branch still only fast-forwards.
        predecessor = await proposalLineage(api, context, input.view, bot, input.pkg.version, retained.head.sha, retained.listed);
      }
      unfinished = { authored: true, accounted: true };
    }
    if (retained.open) {
      await accountedBase(api, context, retained.open.base.sha);
      const parents = retained.head.parents.map((p) => p.sha);
      if (parents.length === 1 && parents[0] === context.sha) {
        // Preserve the explicitly supported legacy exact-open NEXT proposal.
        // Its already existing head is data, never a new rollover authority.
        const state = control.decideProposalState({ base: context.sha, currentMain: context.sha, expectedTree,
          existing: { head: retained.head.sha, tree: retained.head.tree.sha, parent: parents[0] },
          pulls: [retained.open], complete: true });
        if (state.action !== 'no-op') fail('proposal-existing');
        await assertCurrentMain(api, context);
        return { rebuilt, expectedTree, predecessor: null, retained, state, bot };
      }
      if (parents.length !== 2) fail('proposal-head');
      if (parents[0] === context.sha) {
        // Built on this main: an exact head is a no-op, whether it rolled over an
        // App merge directly or rebuilt an earlier generation of this proposal.
        predecessor = await proposalLineage(api, context, input.view, bot, input.pkg.version, parents[1]);
        if (parents[1] !== predecessor.head) prior = parents[1];
      } else {
        // Main moved under the open proposal: rebuild it on this main, keeping the
        // old head as second parent so the branch still only fast-forwards.
        await requireUnapproved(api, context, retained.open);
        predecessor = await proposalLineage(api, context, input.view, bot, input.pkg.version, retained.head.sha);
        rebuild = { authored: true, accounted: true, approved: false };
      }
    }
  }
  if (predecessor.head === context.sha) fail('proposal-existing');
  const state = control.decideProposalState({ base: context.sha, currentMain: context.sha, expectedTree,
    existing: { head: retained.head.sha, tree: retained.head.tree.sha, parents: retained.head.parents.map((p) => p.sha) },
    pulls: retained.open ? [retained.open] : [], complete: true,
    predecessor: { head: predecessor.head, closedMerged: true },
    ...(prior ? { prior } : {}), ...(rebuild ? { rebuild } : {}), ...(unfinished ? { unfinished } : {}) });
  if (!['rollover', 'no-op', 'rebuild', 'adopt', 'adopt-rebuild'].includes(state.action)) fail('proposal-existing');
  await assertCurrentMain(api, context);
  return { rebuilt, expectedTree, predecessor, retained, state, bot };
}
function proposalBody(version, notes) {
  return `Release App proposal for foottrace ${version}.\n\n${notes}\nAfter Claude's independent merge verdict for this exact head is recorded publicly and all current runtime/tested-tree/CodeQL checks pass, reconcile main/head/tested tree. The owner may submit personally or explicitly authorize Codex or Claude to submit the real GitHub APPROVED review on this final head through the owner's existing authorized User account, distinct from the App author, with current API permission write or admin. A delegated review names the submitting agent and the owner's explicit authorization. Standing FootTrace authorization remains sufficient within its stated scope; a changed head still requires fresh independent review, current checks and a fresh approval. An exchange verdict or comment is not that approval. No independent review is waived. No workflow auto-approval is added. This App-authored PR does not publish until normally merged and the Release App route verifies its authority. Owner App installation and npm trusted-publisher setup remain prerequisites; see docs/RELEASING.md.`;
}
async function writeProposal(api, context, payload, pinned, options = {}) {
  // The App writer's readable role repeats ALL publication/lineage/closure reads
  // before the FIRST blob/tree mutation. A planning-token 404 grants no write.
  const before = await proposalPreflight(api, context, payload, pinned, options),
    { rebuilt, expectedTree, bot } = before, base = prefix(context);
  if (before.state.action === 'no-op') return { action: 'no-op', pr: before.retained.open.number };
  // rollover: [main, merged App head] for a new PR; rebuild: [main, open head] for the open PR;
  // adopt-rebuild: [main, unfinished head] for a new PR; adopt: the unfinished head as it stands.
  const action = before.state.action, rebuild = action === 'rebuild', adopt = action === 'adopt';
  let head;
  if (adopt) {
    // The head is already on the branch and is exactly this run's proposal: nothing is written
    // to Git. The preflight has just read main; the branch is read once more, as it is after a
    // ref update, so the pull request is opened for this head or not at all.
    head = before.retained.head.sha;
    const current = (await api('GET', `${base}/git/ref/heads/release/next`)).data;
    if (current.object?.sha !== head) fail('proposal-existing');
  } else {
    const parents = before.state.parents;
    exactData(parents, [context.sha, action === 'rollover' ? before.predecessor.head : before.retained.head.sha], 'proposal-existing');
    const entries = [];
    for (const [path, content] of Object.entries(rebuilt.prepared.updates)) {
      const blob = (await api('POST', `${base}/git/blobs`, { content, encoding: 'utf-8' })).data;
      if (blob.sha !== preparation.gitObject('blob', Buffer.from(content))) fail('blob');
      entries.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    for (const path of rebuilt.prepared.deletions) entries.push({ path, mode: '100644', type: 'blob', sha: null });
    const tree = (await api('POST', `${base}/git/trees`, { base_tree: pinned.tree, tree: entries })).data;
    if (tree.sha !== expectedTree) fail('proposal-tree');
    const commit = (await api('POST', `${base}/git/commits`, {
      message: `chore: release ${pinned.version}`, tree: expectedTree, parents,
    })).data;
    if (!control.validSha(commit.sha)) fail('proposal-commit');
    const actual = (await api('GET', `${base}/git/commits/${commit.sha}`)).data;
    if (actual.sha !== commit.sha || actual.tree?.sha !== expectedTree) fail('proposal-commit');
    exactData(actual.parents?.map((p) => p.sha), parents, 'proposal-commit');
    const fresh = await proposalPreflight(api, context, payload, pinned, options);
    if (fresh.state.action !== before.state.action || fresh.retained.head.sha !== before.retained.head.sha ||
      fresh.retained.open?.number !== before.retained.open?.number || fresh.expectedTree !== expectedTree) fail('proposal-existing');
    // Provider-enforced FF preserves ancestry. It is deliberately not a CAS or
    // exclusivity claim; any partial effect/error is retained, never rolled back.
    // The two observations of the write carry their own names: the answer to the update,
    // and the read of the branch after it. The update is never sent twice. A refusal here
    // can leave the head on the branch with no pull request; a later run takes it up on
    // its own evidence (`retainedProposal`, unfinished).
    const updated = (await api('PATCH', `${base}/git/refs/heads/release/next`, { sha: commit.sha, force: false })).data;
    if (updated.object?.sha !== commit.sha) fail('proposal-ref-write');
    await assertCurrentMain(api, context);
    const current = await readUpdatedRef(api, context, before.retained.head.sha, options.wait);
    if (current.object?.sha !== commit.sha) fail('proposal-ref-readback');
    head = commit.sha;
  }
  const content = { title: `Release ${pinned.version}`, body: proposalBody(pinned.version, rebuilt.prepared.notes) };
  const pr = rebuild
    ? (await api('PATCH', `${base}/pulls/${before.retained.open.number}`, content)).data
    : (await api('POST', `${base}/pulls`, { ...content, head: 'release/next', base: 'main' })).data;
  const requireCurrent = (value) => {
    // A rebuilt PR keeps its number; GitHub may report its base as of an earlier
    // sync, and later runs account for that base before any decision.
    if (!Number.isSafeInteger(value.number) || value.number <= 0 || value.number !== pr.number || value.state !== 'open' ||
      (rebuild && value.number !== before.retained.open.number) ||
      value.head?.sha !== head || (!rebuild && value.base?.sha !== context.sha) ||
      value.user?.id !== bot.id || value.user.type !== 'Bot' || value.user.login !== bot.login ||
      !control.sameRepo(value.head?.repo, context.repository) || !control.sameRepo(value.base?.repo, context.repository) ||
      value.head.ref !== 'release/next' || value.base.ref !== 'main') fail('proposal-pr');
  };
  // A returned inconsistency is permanent evidence for this attempt. Never
  // erase it because a subsequent read happens to look healthy again.
  requireCurrent(pr);
  const created = (await api('GET', `${base}/pulls/${pr.number}`)).data;
  requireCurrent(created);
  // The approval read and the ref advance cannot be one step. An Approve that
  // landed between them now sits on a superseded head: name it rather than
  // return a clean rebuild. Publication still binds approval to the exact head.
  if (rebuild) {
    const reviews = await pages(api, `${base}/pulls/${pr.number}/reviews`);
    if (reviews.some((r) => r.state === 'APPROVED' && r.commit_id !== head)) fail('proposal-approved');
  }
  await assertCurrentMain(api, context);
  const finalRef = (await api('GET', `${base}/git/ref/heads/release/next`)).data;
  if (finalRef.object?.sha !== head) fail('proposal-existing');
  await assertCurrentMain(api, context);
  return { action: rebuild ? 'rebuilt' : adopt ? 'adopted' : 'created', pr: pr.number, head, tree: expectedTree };
}
async function producerIdentity(api, context, name, completed = false) {
  const run = (await api('GET', `${prefix(context)}/actions/runs/${context.runId}`)).data;
  // Keep the original predicate order and short-circuit at the first refusal.
  if (run.id !== context.runId) fail('current-run-id');
  if (run.run_attempt !== context.runAttempt) fail('current-run-attempt');
  if (run.head_sha !== context.sha) fail('current-run-sha');
  if (!control.sameRepo(run.repository, context.repository)) fail('current-run-repository');
  if (!control.sameRepo(run.head_repository, context.repository)) fail('current-run-head-repository');
  if (run.path !== '.github/workflows/publish.yml') fail('current-run-workflow');
  if (run.head_branch !== 'main') fail('current-run-branch');
  if (run.event !== context.eventName) fail('current-run-event');
  if (context.ref !== 'refs/heads/main') fail('current-run-ref');
  if (!['push', 'workflow_dispatch'].includes(run.event)) fail('current-run-trigger');
  if (run.status !== 'in_progress') fail('current-run-status');
  if (run.conclusion !== null) fail('current-run-conclusion');
  const jobs = await pages(
    api,
    `${prefix(context)}/actions/runs/${context.runId}/attempts/${context.runAttempt}/jobs`,
    'jobs',
  );
  const chosen = jobs.filter((j) => j.name === name);
  if (chosen.length !== 1) fail('producer-job');
  const job = chosen[0];
  if (
    job.run_id !== context.runId ||
    job.run_attempt !== context.runAttempt ||
    job.head_sha !== context.sha ||
    (completed && !control.success(job))
  )
    fail('producer-attempt');
  return job;
}
async function readArtifact(api, context, pinned, artifactId, role) {
  const { readArtifactZip } = require('./release-archive.cjs');
  if (!Number.isSafeInteger(artifactId) || artifactId <= 0) fail('artifact-id');
  const artifact = (await api('GET', `${prefix(context)}/actions/artifacts/${artifactId}`)).data;
  const producer = await producerIdentity(api, context, role, true);
  const expected = {
    repositoryId: context.repository.id,
    runId: context.runId,
    runAttempt: context.runAttempt,
    jobId: producer.id,
    jobName: role,
    artifactId,
    artifactName: `foottrace-${context.repository.id}-${context.runId}-${context.runAttempt}-${role}`,
    sourceSha: context.sha,
    tree: pinned.tree,
    package: pinned.package,
    version: pinned.version,
  };
  // Reject the API envelope before downloading any artifact bytes.
  const preflight = { ...expected };
  if (
    !control.validateArtifactBinding({
      expected,
      artifact,
      producer: { ...producer, uploadArtifactId: artifactId },
      manifest: preflight,
    }).valid
  )
    fail('artifact-source');
  const downloaded = (await api('GET', `${prefix(context)}/actions/artifacts/${artifactId}/zip`)).data;
  const members = readArtifactZip(
    Buffer.from(downloaded),
    role === 'prepare' ? ['manifest.json', 'proposal.json'] : ['manifest.json', 'package.tgz'],
  );
  const manifest = parseJson('artifact-json', members['manifest.json'].toString('utf8'));
  if (
    !control.validateArtifactBinding({
      expected,
      artifact,
      producer: { ...producer, uploadArtifactId: artifactId },
      manifest,
    }).valid
  )
    fail('artifact-manifest');
  return { manifest, members };
}
async function peeledTag(api, context, tag) {
  let ref = await optional(api, `${prefix(context)}/git/ref/tags/${enc(tag)}`);
  if (!ref) return null;
  let object = ref.object;
  for (let i = 0; i < 5; i++) {
    if (object?.type === 'commit' && control.validSha(object.sha)) return object.sha;
    if (object?.type !== 'tag' || !control.validSha(object.sha)) fail('tag-shape');
    object = (await api('GET', `${prefix(context)}/git/tags/${object.sha}`)).data.object;
  }
  fail('tag-depth');
}
async function sourceReleaseNotes(api, context, version) {
  if (typeof version === 'string' && version.includes('-rc.')) {
    rcVersion.candidateCore(version);
    if (!control.validSha(context.sha)) fail('rc-source');
    return 'Release candidate ' + version + ' from ' + context.sha + '.\n';
  }
  const changelog = await content(api, context, 'CHANGELOG.md');
  const lines = changelog.split('\n');
  const sections = lines.map((line, index) => ({ line, index })).filter((row) => row.line.startsWith('## '));
  const prefix = `## ${version} — `;
  const matching = sections.filter((row) => row.line.startsWith(prefix));
  if (!changelog.startsWith('# Changelog\n\n') || matching.length !== 1 || sections[0] !== matching[0])
    fail('release-notes');
  const date = matching[0].line.slice(prefix.length);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(new Date(date).getTime()) ||
    new Date(date).toISOString().slice(0, 10) !== date
  )
    fail('release-notes');
  const end = sections[1]?.index ?? lines.length;
  const body = lines
    .slice(matching[0].index + 1, end)
    .join('\n')
    .trim();
  if (!body) fail('release-notes');
  return body + '\n';
}
function requireReleaseNotes(release, context, tag, notes) {
  const prerelease = tag.includes('-rc.');
  if (prerelease) rcVersion.candidateCore(tag.slice(1));
  if (
    !release ||
    release.tag_name !== tag ||
    release.target_commitish !== context.sha ||
    release.body !== notes ||
    release.draft !== false ||
    release.prerelease !== prerelease
  )
    fail('release-conflict');
}
async function releaseState(api, context, identity, archive, registry) {
  const rc = identity.mode === 'rc';
  await assertCurrentMain(api, context);
  const base = prefix(context),
    name = `publish-attempt-${identity.version}.json`;
  const marker = {
    version: identity.version,
    runId: context.runId,
    runAttempt: context.runAttempt,
    sha: context.sha,
    integrity: archive.integrity,
  };
  const existingTag = await peeledTag(api, context, identity.tag);
  if (rc && existingTag !== null) fail('rc-existing-tag');
  if (existingTag && existingTag !== context.sha) fail('tag-conflict');
  let release = await optional(api, `${base}/releases/tags/${enc(identity.tag)}`);
  if (rc && release !== null) fail('rc-existing-release');
  if (rc && registry !== null) fail('rc-registry');
  const notes = await sourceReleaseNotes(api, context, identity.version);
  if (release) requireReleaseNotes(release, context, identity.tag, notes);
  const assets = release ? await pages(api, `${base}/releases/${release.id}/assets`) : [];
  const matching = assets.filter((a) => a.name === name);
  if (matching.length > 1) fail('journal-conflict');
  const decision = control.decideSubmission({ journal: matching[0] ?? null, registry, expected: marker });
  if (decision.action === 'hold') fail('registry-conflict');
  if (decision.action === 'verify-only')
    return { fresh: false, assetId: matching[0]?.id ?? null, runId: context.runId, runAttempt: context.runAttempt };
  await assertCurrentMain(api, context);
  if (!existingTag) {
    const reply = await api('POST', `${base}/git/refs`, { ref: `refs/tags/${identity.tag}`, sha: context.sha });
    if (rc && reply.status !== 201) fail('rc-tag-create');
    const created = reply.data;
    if (rc && (created?.ref !== 'refs/tags/' + identity.tag ||
        created.object?.type !== 'commit' || created.object.sha !== context.sha)) fail('rc-tag-create');
  }
  if (rc) {
    await assertCurrentMain(api, context);
    if ((await peeledTag(api, context, identity.tag)) !== context.sha) fail('tag-conflict');
  }
  if (!release) {
    const reply = await api('POST', `${base}/releases`, {
        tag_name: identity.tag,
        target_commitish: context.sha,
        name: identity.tag,
        body: notes,
        draft: false,
        prerelease: rc,
        ...(rc ? { make_latest: 'false' } : {}),
      });
    if (rc && reply.status !== 201) fail('rc-release-create');
    release = reply.data;
  }
  if (rc) {
    requireReleaseNotes(release, context, identity.tag, notes);
    if (!Number.isSafeInteger(release.id) || release.id <= 0 ||
        release.upload_url !== 'https://uploads.github.com' + base + '/releases/' + release.id + '/assets{?name,label}')
      fail('release-upload-url');
    await assertCurrentMain(api, context);
  }
  const reserved = await reserveAttempt(api, release, marker);
  return { ...reserved, runId: context.runId, runAttempt: context.runAttempt };
}
async function publishGrant(api, context, identity, archive, grant) {
  await assertCurrentMain(api, context);
  if (!Number.isSafeInteger(grant.assetId)) fail('journal-asset');
  if (identity.mode === 'rc') {
    const release = await optional(api, prefix(context) + '/releases/tags/' + enc(identity.tag));
    if (!Number.isSafeInteger(release?.id) || release.id <= 0) fail('release-conflict');
    requireReleaseNotes(release, context, identity.tag, await sourceReleaseNotes(api, context, identity.version));
    const assets = await pages(api, prefix(context) + '/releases/' + release.id + '/assets');
    if (assets.filter(a => a.id === grant.assetId && a.name === 'publish-attempt-' + identity.version + '.json').length !== 1)
      fail('journal-grant');
  }
  const asset = (await api('GET', `${prefix(context)}/releases/assets/${grant.assetId}`)).data;
  if (asset.name !== `publish-attempt-${identity.version}.json` || asset.state !== 'uploaded' || asset.size > 4096)
    fail('journal-asset');
  const raw = (
    await api('GET', `${prefix(context)}/releases/assets/${grant.assetId}`, { accept: 'application/octet-stream' })
  ).data;
  const marker = identity.mode === 'rc' ? markerData(Buffer.from(raw), identity.version, context.sha, asset.size) :
    parseJson('journal-json', Buffer.from(raw).toString('utf8'));
  const expected = {
    version: identity.version,
    runId: context.runId,
    runAttempt: context.runAttempt,
    sha: context.sha,
    integrity: archive.integrity,
  };
  if (!control.validatePublishGrant({ expected, marker, grant }).mayPublish) fail('journal-grant');
  if ((await peeledTag(api, context, identity.tag)) !== context.sha) fail('tag-conflict');
  return true;
}
async function responseBytes(response, max = 24 * 1024 * 1024, failure = 'github-body') {
  try {
    if (Number(response.headers.get('content-length') ?? 0) > max) fail('response-limit');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > max) fail('response-limit');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (refusalCode(error) === 'response-limit') throw error;
    throw diagnostic(failure === 'registry-body' ? 'registry-body' : 'github-body');
  }
}
function makeApi(token, fetcher = fetch, appIdentity) {
  return async (method, route, body) => {
    try {
      if (
        !(
          route.startsWith('/repos/footprintjs/foottrace/') ||
          route === '/repos/footprintjs/foottrace' ||
          route.startsWith('/apps/') ||
          route.startsWith('/users/') ||
          route.startsWith('https://uploads.github.com/repos/footprintjs/foottrace/releases/')
        )
      )
        fail('api-route');
      const headers = {
        authorization: `Bearer ${token}`,
        accept: body?.accept ?? 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      };
      const options = { method, headers, signal: AbortSignal.timeout(30000) };
      let url = route.startsWith('https:') ? route : `https://api.github.com${route}`;
      if (route.startsWith('/apps/')) {
        const request = appRequest(appIdentity, method, route, body);
        url = request.url;
        headers.authorization = request.authorization;
        options.redirect = request.redirect;
      }
      if (body?.raw) {
        headers['content-type'] = body.contentType;
        options.body = body.raw;
      } else if (body && !body.accept) {
        headers['content-type'] = 'application/json';
        options.body = JSON.stringify(body);
      }
      let response;
      try {
        response = await fetcher(url, options);
      } catch {
        throw diagnostic('github-transport');
      }
      if (!response || typeof response.ok !== 'boolean') throw diagnostic('github-response');
      if (!response.ok) {
        const status = response.status;
        if (!Number.isInteger(status) || status < 100 || status > 599) throw diagnostic('github-response');
        const specific = new Map([
          [401, 'unauthorized'],
          [403, 'forbidden'],
          [404, 'not-found'],
          [409, 'conflict'],
          [422, 'invalid'],
          [429, 'rate-limited'],
        ]);
        const category = specific.get(status) ?? (status >= 500 ? 'server' : 'other');
        const error = diagnostic(`github-http-${category}`, 'github-api-failed');
        error.status = status;
        throw error;
      }
      const bytes = await responseBytes(response);
      const isJson =
        body?.accept !== 'application/octet-stream' &&
        !route.endsWith('/zip') &&
        response.headers.get('content-type')?.includes('json');
      if (!isJson) return { data: bytes, status: response.status };
      try {
        return { data: JSON.parse(bytes.toString('utf8')), status: response.status };
      } catch {
        throw diagnostic('github-json');
      }
    } catch (error) {
      if (refusalCode(error) !== 'release-unexpected') throw error;
      throw contextual(error, 'github-request');
    }
  };
}
async function registryVersion(version, fetcher = fetch) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    try { rcVersion.candidateCore(version); } catch { fail('version'); }
  }
  const response = await registryFetch(`https://registry.npmjs.org/foottrace/${version}`, fetcher);
  if (response.status === 404) return null;
  if (!response.ok || response.status !== 200) fail('registry-unavailable');
  const value = parseJson(
    'registry-json',
    (await responseBytes(response, 2 * 1024 * 1024, 'registry-body')).toString('utf8'),
  );
  if (value.name !== 'foottrace' || value.version !== version || typeof value.dist?.integrity !== 'string')
    fail('registry-shape');
  return { ...value.dist, version: value.version };
}
function markerData(bytes, expectedVersion, source, size) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== size || bytes.length > 4096) fail('journal-conflict');
  const value = parseJson('journal-json', preparation.decodeRaw(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'integrity,runAttempt,runId,sha,version' ||
    value.version !== expectedVersion || value.sha !== source ||
    !Number.isSafeInteger(value.runId) || value.runId <= 0 || !Number.isSafeInteger(value.runAttempt) || value.runAttempt <= 0 ||
    typeof value.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value.integrity)) fail('journal-conflict');
  return value;
}
// Current helpers inspect a historical data source. This never retargets current
// authority/reservation/grant functions and does not execute historical helpers.
async function publicationState(api, context, input, { fetcher = fetch, settings } = {}) {
  const version = input.pkg.version, tag = `v${version}`, base = prefix(context),
    registry = await registryVersion(version, fetcher), source = await peeledTag(api, context, tag),
    release = await optional(api, `${base}/releases/tags/${enc(tag)}`);
  if (!source && !release) {
    if (registry) fail('recovery-state');
    await requireUnpublishedLatest(version, fetcher);
    return { state: 'absent', version };
  }
  if (!source || !release || !Number.isSafeInteger(release.id) || release.id <= 0) fail('recovery-state');
  const historical = { ...context, sha: source }, sourceInventory = await input.view.inventory(source);
  packageIdentity(sourceInventory, version);
  const bot = await publicBot(api, settings), lineage = await linkedLineage(api, context, input.view, bot, source, version);
  if (lineage.merge !== source) fail('recovery-lineage');
  await requireAncestor(api, context, source, context.sha);
  const notes = await sourceReleaseNotes(api, historical, version);
  requireReleaseNotes(release, historical, tag, notes);
  const assets = await pages(api, `${base}/releases/${release.id}/assets`),
    markers = assets.filter((a) => a.name === `publish-attempt-${version}.json`);
  if (markers.length !== 1 || markers[0].state !== 'uploaded' || !Number.isSafeInteger(markers[0].size) ||
    markers[0].size < 1 || markers[0].size > 4096) fail('journal-conflict');
  const raw = Buffer.from((await api('GET', `${base}/releases/assets/${markers[0].id}`, { accept: 'application/octet-stream' })).data),
    marker = markerData(raw, version, source, markers[0].size);
  if (!registry) return { state: 'pending', reason: 'pending-registry', version, sha: source };
  if (registry.integrity !== marker.integrity || !/^[a-f0-9]{40}$/.test(registry.shasum ?? '') ||
    registry.tarball !== `https://registry.npmjs.org/foottrace/-/foottrace-${version}.tgz`) fail('registry-conflict');
  const response = await registryFetch(registry.tarball, fetcher);
  if (!response.ok || response.status !== 200) fail('registry-unavailable');
  const archive = require('./release-archive.cjs').inspectArchive(await responseBytes(response, 16 * 1024 * 1024, 'registry-body'),
    { package: 'foottrace', version });
  if (archive.integrity !== marker.integrity || archive.shasum !== registry.shasum) fail('registry-bytes');
  const latestResponse = await registryFetch('https://registry.npmjs.org/foottrace/latest', fetcher);
  if (!latestResponse.ok || latestResponse.status !== 200) fail('registry-unavailable');
  const latest = parseJson('registry-latest-json', (await responseBytes(latestResponse, 2 * 1024 * 1024, 'registry-body')).toString('utf8'));
  if (latest.name !== 'foottrace') fail('registry-shape');
  const order = preparation.versionOrder(latest.version, version);
  if (order > 0) fail('recovery-state');
  return { state: order < 0 ? 'pending' : 'published', reason: order < 0 ? 'pending-latest' : 'verified',
    version, latest: latest.version, sha: source, tree: (await input.view.commit(source)).tree.sha,
    integrity: archive.integrity, shasum: archive.shasum, sha256: archive.sha256,
    provenance: registry.attestations ?? null, provenanceCryptographicallyVerified: false,
    docs: 'No separate FootTrace docs deployment is configured.' };
}
async function requireUnpublishedLatest(version, fetcher) {
  const response = await registryFetch('https://registry.npmjs.org/foottrace/latest', fetcher);
  if (!response.ok || response.status !== 200) fail('registry-unavailable');
  const latest = parseJson('registry-latest-json', (await responseBytes(response, 2 * 1024 * 1024, 'registry-body')).toString('utf8'));
  if (latest.name !== 'foottrace' || preparation.versionOrder(latest.version, version) >= 0) fail('recovery-state');
}
async function verifyPublished(api, context, pinned, fetcher = fetch,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const rc = pinned.mode === 'rc';
  if (rc) {
    rcVersion.candidateCore(pinned.version);
    preparation.parseVersion(pinned.fromVersion);
  }
  // Verification grants no effects: a later attempt may verify this run's
  // pinned source after main advances. Absence never permits a repeated write.
  const present = async (read) => {
    for (let n = 0; n < (rc ? 3 : 1); n++) {
      const value = await read();
      if (value !== null) return value;
      if (rc && n < 2) await wait(1000);
    }
    return null;
  };
  const rcTags = async (absenceCode) => {
    const responses = [];
    for (const tag of ['latest', 'next'])
      responses.push(await registryFetch('https://registry.npmjs.org/foottrace/' + tag, fetcher));
    const decode = async (response, tag) => {
      if (tag === 'next' && response.status === 404) return null;
      if (!response.ok || response.status !== 200) fail('registry-unavailable');
      const value = parseJson(
        'registry-' + tag + '-json',
        (await responseBytes(response, 2 * 1024 * 1024, 'registry-body')).toString('utf8'),
      );
      if (value.name !== 'foottrace') fail('registry-shape');
      return value;
    };
    const latest = await decode(responses[0], 'latest');
    // An RC on latest is the strongest failure, including when next is absent.
    if (latest.version !== pinned.fromVersion) fail('rc-latest');
    const next = await decode(responses[1], 'next');
    if (absenceCode) fail(absenceCode);
    if (next?.version !== pinned.version) fail('rc-next');
    return { latest, next };
  };
  const tag = 'v' + pinned.version,
    base = prefix(context),
    release = await present(() => optional(api, base + '/releases/tags/' + enc(tag)));
  if (!release) {
    if (rc) await rcTags('rc-release-missing');
    return { state: 'pending-release' };
  }
  const notes = await sourceReleaseNotes(api, context, pinned.version);
  requireReleaseNotes(release, context, tag, notes);
  if ((await peeledTag(api, context, tag)) !== context.sha) fail('release-conflict');
  const assets = await pages(api, base + '/releases/' + release.id + '/assets'),
    markers = assets.filter((a) => a.name === 'publish-attempt-' + pinned.version + '.json');
  if (markers.length !== 1 || markers[0].state !== 'uploaded' || markers[0].size > 4096) fail('journal-conflict');
  const markerBytes = Buffer.from(
      (await api('GET', base + '/releases/assets/' + markers[0].id, { accept: 'application/octet-stream' })).data),
    marker = rc ? markerData(markerBytes, pinned.version, context.sha, markers[0].size) :
      parseJson('journal-json', markerBytes.toString('utf8'));
  if (rc && marker.runId !== context.runId) fail('journal-conflict');
  if (marker.sha !== context.sha || marker.version !== pinned.version) fail('journal-conflict');
  const registry = await present(() => registryVersion(pinned.version, fetcher));
  if (!registry) {
    if (rc) await rcTags('rc-registry-missing');
    return { state: 'pending-registry' };
  }
  if (
    registry.integrity !== marker.integrity ||
    registry.tarball !== 'https://registry.npmjs.org/foottrace/-/foottrace-' + pinned.version + '.tgz'
  )
    fail('registry-conflict');
  const response = await registryFetch(registry.tarball, fetcher);
  if (!response.ok) fail('registry-unavailable');
  const archive = require('./release-archive.cjs').inspectArchive(
    await responseBytes(response, 16 * 1024 * 1024, 'registry-body'), { package: 'foottrace', version: pinned.version });
  if (archive.integrity !== marker.integrity || archive.shasum !== registry.shasum) fail('registry-bytes');
  let latest, next;
  if (rc) ({ latest, next } = await rcTags());
  else {
    const response = await registryFetch('https://registry.npmjs.org/foottrace/latest', fetcher);
    if (!response.ok) fail('registry-unavailable');
    latest = parseJson('registry-latest-json',
      (await responseBytes(response, 2 * 1024 * 1024, 'registry-body')).toString('utf8'));
  }
  return {
    state: rc ? 'verified' : latest.version === pinned.version ? 'verified' : 'pending-latest',
    ...(rc ? { next: next.version } : {}),
    version: pinned.version, latest: latest.version, sha: context.sha,
    integrity: archive.integrity, shasum: archive.shasum, sha256: archive.sha256,
    provenance: registry.attestations ?? null, provenanceCryptographicallyVerified: false,
    docs: 'No separate FootTrace docs deployment is configured.',
  };
}
function environmentContext(env) {
  const context = {
    repository: { id: Number(env.REPO_ID), full_name: env.REPO_NAME },
    sha: env.SOURCE_SHA,
    ref: env.SOURCE_REF,
    eventName: env.EVENT_NAME,
    runId: Number(env.RUN_ID),
    runAttempt: Number(env.RUN_ATTEMPT),
    verify: env.VERIFY_ONLY === 'true',
    rc: env.RC === 'true',
    bump: env.RC_BUMP,
  };
  prefix(context);
  if (!context.rc && context.bump && context.bump !== 'none') fail('rc-bump-without-rc');
  if (
    !control.validSha(context.sha) ||
    !Number.isSafeInteger(context.runId) ||
    context.runId <= 0 ||
    !Number.isSafeInteger(context.runAttempt) ||
    context.runAttempt <= 0
  )
    fail('context');
  return context;
}
async function runStage(stage, { api, context, env, io, fetcher = fetch }) {
  const pinned = env.PLAN_JSON ? parseJson('plan-json', env.PLAN_JSON) : null;
  const identity = env.IDENTITY_JSON ? parseJson('identity-json', env.IDENTITY_JSON) : null;
  const settings = { slug: env.APP_SLUG, clientId: env.APP_CLIENT_ID };
  const phaseOptions = { settings, fetcher };
  const bound = () => {
    if (!pinned || pinned.sha !== context.sha || !control.sameRepo(pinned.repository, context.repository))
      fail('plan-substitution');
  };
  const freshAuthority = async () => {
    if (pinned.mode === 'rc') {
      const fresh = await collectRcAuthority(api, context, pinned, stage, phaseOptions);
      exactData(fresh.identity, identity, 'identity-changed');
      return fresh.registry;
    }
    const fresh = await collectAuthority(api, context, settings);
    if (JSON.stringify(fresh) !== JSON.stringify(identity)) fail('identity-changed');
    await requireSecurity(api, fresh);
  };
  if (stage === 'plan') {
    const p = await plan(api, context, phaseOptions);
    return { plan: JSON.stringify(p), mode: p.mode };
  }
  bound();
  if (stage === 'prepare') {
    const proposal = await prepareProposal(api, context, pinned, phaseOptions),
      job = await producerIdentity(api, context, 'prepare');
    io.write('release-artifact/proposal.json', Buffer.from(JSON.stringify(proposal) + '\n'));
    io.write(
      'release-artifact/manifest.json',
      Buffer.from(
        JSON.stringify({
          repositoryId: context.repository.id,
          runId: context.runId,
          runAttempt: context.runAttempt,
          jobId: job.id,
          sourceSha: context.sha,
          tree: pinned.tree,
          package: pinned.package,
          version: pinned.version,
        }) + '\n',
      ),
    );
    return {};
  }
  if (stage === 'proposal') {
    const artifact = await readArtifact(api, context, pinned, Number(env.ARTIFACT_ID), 'prepare');
    return {
      proposal: JSON.stringify(
        await writeProposal(
          api,
          context,
          parseJson('artifact-json', artifact.members['proposal.json'].toString('utf8')),
          pinned,
          phaseOptions,
        ),
      ),
    };
  }
  if (stage === 'authority') {
    if (pinned.mode === 'rc') {
      const { identity: id } = await collectRcAuthority(api, context, pinned, 'authority', phaseOptions);
      return { identity: JSON.stringify(id), authorized: 'true' };
    }
    const id = await collectAuthority(api, context, settings);
    if (id.tree !== pinned.tree || id.version !== pinned.version) fail('authority-plan');
    await requireSecurity(api, id);
    await requireRecoverySource(api, context, id, phaseOptions);
    return { identity: JSON.stringify(id), authorized: 'true' };
  }
  if (stage === 'verdict') {
    if (pinned.mode === 'rc') {
      if (identity?.mode !== 'rc' || identity.sourceSha !== context.sha ||
          identity.tree !== pinned.tree || identity.version !== pinned.version) fail('identity');
      return { tested: 'false' };
    }
    if (!identity || identity.mergeSha !== context.sha || identity.tree !== pinned.tree) fail('identity');
    return { tested: String((await ciVerdict(api, identity)).tested) };
  }
  if (stage === 'build-manifest') {
    if (io.gitTree() !== pinned.tree) fail('build-tree');
    io.requireClean();
    const pkg = parseJson('package-json', io.read('package.json')),
      lock = parseJson('lock-json', io.read('package-lock.json')),
      sourceVersion = pinned.mode === 'rc' ? pinned.fromVersion : pinned.version;
    if (
      pkg.name !== pinned.package ||
      pkg.version !== sourceVersion ||
      lock.version !== pkg.version ||
      lock.packages?.[''].version !== pkg.version
    )
      fail('package-version');
    const pack = parseJson('pack-json', io.read('pack.json'));
    if (!Array.isArray(pack) || pack.length !== 1 || pack[0].filename !== `foottrace-${pinned.version}.tgz`)
      fail('pack-identity');
    const bytes = io.read(pack[0].filename),
      archive = require('./release-archive.cjs').inspectArchive(bytes, {
        package: pinned.package,
        version: pinned.version,
        sourceManifest: pkg,
      }),
      job = await producerIdentity(api, context, 'build');
    io.write('release-artifact/package.tgz', bytes);
    io.write(
      'release-artifact/manifest.json',
      Buffer.from(
        JSON.stringify({
          repositoryId: context.repository.id,
          runId: context.runId,
          runAttempt: context.runAttempt,
          jobId: job.id,
          sourceSha: context.sha,
          tree: pinned.tree,
          package: pinned.package,
          version: pinned.version,
          sha256: archive.sha256,
          integrity: archive.integrity,
          shasum: archive.shasum,
        }) + '\n',
      ),
    );
    return {};
  }
  if (stage === 'release' || stage === 'publish') {
    const firstRegistry = await freshAuthority();
    const artifact = await readArtifact(api, context, pinned, Number(env.ARTIFACT_ID), 'build'),
      bytes = artifact.members['package.tgz'],
      archive = require('./release-archive.cjs').inspectArchive(bytes, {
        package: pinned.package,
        version: pinned.version,
        sourceManifest: parseJson('package-json', await content(api, context, 'package.json')),
      });
    if (
      artifact.manifest.integrity !== archive.integrity ||
      artifact.manifest.sha256 !== archive.sha256 ||
      artifact.manifest.shasum !== archive.shasum
    )
      fail('archive-manifest');
    let registry = await registryVersion(pinned.version, fetcher);
    if (pinned.mode === 'rc') {
      const lastRegistry = await freshAuthority();
      // A later absence must not erase an already observed publication.
      for (const observed of [firstRegistry, registry, lastRegistry]) if (observed !== null) {
        if (observed?.version !== pinned.version || observed.integrity !== archive.integrity) fail('registry-conflict');
        registry = observed;
      }
    }
    if (stage === 'release') {
      if (pinned.mode !== 'rc' && await requireRecoverySource(api, context, identity, phaseOptions)) {
        if (!registry) await requireUnpublishedLatest(pinned.version, fetcher);
      }
      const grant = await releaseState(api, context, identity, archive, registry);
      return { grant: JSON.stringify(grant), fresh: String(grant.fresh) };
    }
    const grant = parseJson('grant-json', env.GRANT_JSON ?? 'null');
    // Rebind recovery source independently of any plan flag. The unchanged
    // current-attempt grant and registry checks below own submission authority.
    if (pinned.mode !== 'rc' && await requireRecoverySource(api, context, identity, phaseOptions)) {
      if (!registry) await requireUnpublishedLatest(pinned.version, fetcher);
    }
    await publishGrant(api, context, identity, archive, grant);
    if (registry) {
      if (registry.integrity !== archive.integrity) fail('registry-conflict');
      return { submit: 'false' };
    }
    const file = io.publishFile(context.runId, context.runAttempt);
    io.write(file, bytes);
    return { submit: 'true', file, npmtag: rcVersion.distributionTag(archive.version) };
  }
  if (stage === 'verify') {
    // The publication workflow verifies its own exact current-source release
    // with the existing strict target/marker check. A standalone verify plan
    // uses the complete historical data witness; neither path grants submission.
    if (pinned.mode === 'publish' || pinned.mode === 'rc')
      return { verification: JSON.stringify(await verifyPublished(api, context, pinned, fetcher)) };
    if (pinned.mode !== 'verify') fail('recovery-phase');
    const input = await sourceInput(api, context);
    if (input.commit.tree.sha !== pinned.tree || input.pkg.version !== pinned.version) fail('plan-substitution');
    const result = await publicationState(api, context, input, phaseOptions);
    await assertCurrentMain(api, context);
    return { verification: JSON.stringify({ ...result, state: result.reason ?? 'pending-release' }) };
  }
  fail('stage');
}
module.exports = {
  refusalCode,
  withRefusal,
  withRefusalSync,
  sourceReleaseNotes,
  requireReleaseNotes,
  makeApi,
  registryVersion,
  verifyPublished,
  environmentContext,
  runStage,
  optional,
  writeProposal,
  producerIdentity,
  readArtifact,
  peeledTag,
  releaseState,
  publishGrant,
  pages,
  assertCurrentMain,
  content,
  sourceInput,
  plan,
  prepareProposal,
  collectAuthority,
  collectRcAuthority,
  workflowEvidence,
  ciVerdict,
  requireSecurity,
  rcSource,
  rcTagRefs,
  reserveAttempt,
  sourceView,
  requireAncestor,
  publicationState,
  activeHistory,
  recoveryPreparation,
  currentRecovery,
  proposalPreflight,
  requireRecoverySource,
};
