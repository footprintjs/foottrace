'use strict';
const { TYPES, parseFragment, parseVersion, selectBump, nextVersion } = require('./release-changes.cjs');
const fail = (code) => {
  const e = new Error(code);
  e.code = code;
  throw e;
};
const heading = '## Value-free trace metadata — unreleased';
const paragraph =
  'This is an unreleased additive entry point. The package version and existing\nrecord fixtures remain unchanged until a separately reviewed release.';
function replaceOnce(text, before, after) {
  if (typeof text !== 'string' || text.split(before).length !== 2) fail('invalid-release-docs');
  return text.replace(before, after);
}
function prepareReleaseDocs({ documents, version, selectedFragments }) {
  parseVersion(version);
  if (!documents || !Array.isArray(selectedFragments)) fail('invalid-release-docs');
  const result = { ...documents };
  if (selectedFragments.includes('metadata-query.md')) {
    result['README.md'] = replaceOnce(
      documents['README.md'],
      heading,
      `## Value-free trace metadata (since ${version})`,
    );
    result['docs/metadata.md'] = replaceOnce(
      documents['docs/metadata.md'],
      paragraph,
      `This additive entry point is included from FootTrace ${version}. Existing complete-record APIs and saved records retain their prior contracts.`,
    );
  }
  return result;
}
function prepareRelease({ files, fragments, date }) {
  if (!files || !fragments || !/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0, 10) !== date)
    fail('invalid-release-input');
  const parsed = Object.keys(fragments)
    .sort()
    .map((name) => parseFragment(name, fragments[name]));
  if (!parsed.length) return null;
  let pkg, lock;
  try {
    pkg = JSON.parse(files['package.json']);
    lock = JSON.parse(files['package-lock.json']);
  } catch {
    fail('invalid-release-input');
  }
  if (
    pkg.name !== 'foottrace' ||
    lock.name !== pkg.name ||
    lock.version !== pkg.version ||
    lock.packages?.['']?.name !== pkg.name ||
    lock.packages[''].version !== pkg.version
  )
    fail('invalid-release-input');
  const fromVersion = pkg.version,
    bump = selectBump(parsed),
    version = nextVersion(pkg.version, bump);
  if (typeof files['CHANGELOG.md'] !== 'string' || !files['CHANGELOG.md'].startsWith('# Changelog\n\n'))
    fail('invalid-release-input');
  const groups = Object.keys(TYPES).flatMap((type) => {
    const notes = parsed.filter((f) => f.type === type).map((f) => f.body);
    return notes.length ? [`### ${TYPES[type]}\n\n${notes.join('\n')}\n`] : [];
  });
  const notes = groups.join('\n').trimEnd() + '\n';
  const suffix = files['CHANGELOG.md'].slice('# Changelog\n\n'.length);
  pkg.version = version;
  lock.version = version;
  lock.packages[''].version = version;
  const updates = {
    'package.json': JSON.stringify(pkg, null, 2) + '\n',
    'package-lock.json': JSON.stringify(lock, null, 2) + '\n',
    'CHANGELOG.md': `# Changelog\n\n## ${version} — ${date}\n\n${notes}\n${suffix}`,
  };
  const docs = prepareReleaseDocs({
    documents: { 'README.md': files['README.md'], 'docs/metadata.md': files['docs/metadata.md'] },
    version,
    selectedFragments: parsed.map((f) => f.name),
  });
  for (const [name, text] of Object.entries(docs)) if (text !== files[name]) updates[name] = text;
  return {
    package: pkg.name,
    fromVersion,
    version,
    bump,
    tag: `v${version}`,
    notes,
    updates,
    deletions: parsed.map((f) => `.changes/${f.name}`),
  };
}
const crypto = require('node:crypto');
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const gitObject = (kind, bytes) =>
  crypto.createHash('sha1').update(Buffer.from(`${kind} ${bytes.length}\0`)).update(bytes).digest('hex');
const intentPrefix = '.release/recovery/';
const fragmentPath = (path) =>
  typeof path === 'string' && Buffer.byteLength(path) <= 512 && /^\.changes\/[a-z0-9][a-z0-9-]*\.md$/.test(path);
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const hexDigest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
function versionOrder(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
// Copy only closed own data. Never stringify an unadmitted object/toJSON.
function fields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('recovery-intent');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some((key) => !Object.hasOwn(descriptors, key)))
    fail('recovery-intent');
  return keys.map((key) => {
    const d = descriptors[key];
    if (!Object.hasOwn(d, 'value')) fail('recovery-intent');
    return d.value;
  });
}
function dataArray(value, max) {
  if (!Array.isArray(value) || value.length > max) fail('recovery-intent');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) fail('recovery-intent');
  return Array.from({ length: value.length }, (_, i) => {
    if (!Object.hasOwn(descriptors, i) || !Object.hasOwn(descriptors[i], 'value')) fail('recovery-intent');
    return descriptors[i].value;
  });
}
function lineageData(value) {
  const [pr, head, tree, merge] = fields(value, ['pr', 'head', 'tree', 'merge']);
  if (!positive(pr) || ![head, tree, merge].every(sha)) fail('recovery-intent');
  return { pr, head, tree, merge };
}
function intentPath(version, sequence) {
  parseVersion(version);
  if (!positive(sequence) || sequence > 100) fail('recovery-intent');
  return `${intentPrefix}${version}/${String(sequence).padStart(3, '0')}.json`;
}
function admitIntent(value, repository) {
  const [schema, kind, pkg, version, sequence, repo, baseValue, originValue, predecessorValue, prior, queue] =
    fields(value, ['schema', 'kind', 'package', 'version', 'sequence', 'repository', 'base', 'origin', 'predecessor', 'previous', 'queuedFragments']);
  if (schema !== 1 || kind !== 'unpublished-recovery' || pkg !== 'foottrace') fail('recovery-intent');
  intentPath(version, sequence);
  const [id, full_name] = fields(repo, ['id', 'full_name']);
  if (!positive(id) || id !== repository.id || full_name !== repository.full_name) fail('recovery-intent');
  const [baseSha, tree] = fields(baseValue, ['sha', 'tree']);
  if (![baseSha, tree].every(sha)) fail('recovery-intent');
  const origin = lineageData(originValue), predecessor = lineageData(predecessorValue);
  let previous = null;
  if (sequence === 1) {
    if (prior !== null || JSON.stringify(origin) !== JSON.stringify(predecessor)) fail('recovery-intent');
  } else {
    const [path, sha256] = fields(prior, ['path', 'sha256']);
    if (path !== intentPath(version, sequence - 1) || !hexDigest(sha256)) fail('recovery-intent');
    previous = { path, sha256 };
  }
  let last = '';
  const queuedFragments = dataArray(queue, 100).map((entry) => {
    const [path, sha256, bytes, mode] = fields(entry, ['path', 'sha256', 'bytes', 'mode']);
    if (!fragmentPath(path) || path <= last || !hexDigest(sha256) || !positive(bytes) || bytes > 65536 || mode !== '100644')
      fail('recovery-intent');
    last = path;
    return { path, sha256, bytes, mode };
  });
  if (!queuedFragments.length) fail('recovery-intent');
  return { schema, kind, package: pkg, version, sequence, repository: { id, full_name }, base: { sha: baseSha, tree }, origin, predecessor, previous, queuedFragments };
}
function intentBytes(value, repository) {
  const data = admitIntent(value, repository), raw = Buffer.from(JSON.stringify(data) + '\n');
  if (raw.length > 65536) fail('recovery-intent');
  return raw;
}
function decodeRaw(bytes) {
  if (!Buffer.isBuffer(bytes)) fail('recovery-source');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail('recovery-source'); }
  if (!Buffer.from(text).equals(bytes)) fail('recovery-source');
  return text;
}
function admitIntentNamespace(inventory, version, repository) {
  const records = [];
  for (const [path, row] of inventory) {
    if (!path.startsWith('.release/')) continue;
    if (records.length >= 100 || row.mode !== '100644' || row.bytes.length > 65536) fail('recovery-intent');
    let value;
    try { value = JSON.parse(decodeRaw(row.bytes)); } catch { fail('recovery-intent'); }
    const data = admitIntent(value, repository);
    if (path !== intentPath(data.version, data.sequence) || versionOrder(data.version, version) > 0 || !intentBytes(data, repository).equals(row.bytes))
      fail('recovery-intent');
    records.push({ path, sha256: digest(row.bytes), data });
  }
  records.sort((a, b) => versionOrder(a.data.version, b.data.version) || a.data.sequence - b.data.sequence);
  const chains = new Map();
  for (const record of records) {
    const chain = chains.get(record.data.version) ?? [], prior = chain.at(-1);
    if (record.data.sequence !== chain.length + 1 || (prior && (record.data.previous.sha256 !== prior.sha256 ||
      JSON.stringify(record.data.origin) !== JSON.stringify(prior.data.origin)))) fail('recovery-intent');
    chain.push(record); chains.set(record.data.version, chain);
  }
  return { records, active: chains.get(version) ?? [] };
}
function fragmentQueue(inventory) {
  const result = [];
  for (const [path, row] of [...inventory].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (!path.startsWith('.changes/') || path === '.changes/README.md') continue;
    if (!fragmentPath(path) || row.mode !== '100644' || result.length >= 100) fail('fragment-path');
    parseFragment(path.slice(9), decodeRaw(row.bytes));
    result.push({ path, sha256: digest(row.bytes), bytes: row.bytes.length, mode: row.mode });
  }
  return result;
}
function requireQueueSubset(prior, current) {
  for (const row of prior) if (!current.some((item) => JSON.stringify(item) === JSON.stringify(row))) fail('recovery-queue');
}
// Git's directory ordering includes '/' on tree names. Compute the complete tree,
// rather than trusting a provider's candidate hash or a compare.files subset.
function treeOid(inventory) {
  const root = new Map();
  for (const [path, row] of inventory) {
    if (typeof path !== 'string' || Buffer.byteLength(path) > 1024 || /[\x00-\x1f\x7f\\]/.test(path) ||
      path.split('/').some((x) => !x || x === '.' || x === '..') || !sha(row.sha) || !['100644', '100755'].includes(row.mode))
      fail('recovery-source');
    const parts = path.split('/'); let directory = root;
    for (const name of parts.slice(0, -1)) {
      if (!directory.has(name)) directory.set(name, new Map());
      directory = directory.get(name);
      if (!(directory instanceof Map)) fail('recovery-source');
    }
    const leaf = parts.at(-1);
    if (directory.has(leaf)) fail('recovery-source');
    directory.set(leaf, row);
  }
  const encode = (directory) => {
    const entries = [...directory].map(([name, row]) => row instanceof Map
      ? { name, order: name + '/', mode: '40000', sha: encode(row) }
      : { name, order: name, mode: row.mode, sha: row.sha });
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.order), Buffer.from(b.order)));
    return gitObject('tree', Buffer.concat(entries.flatMap((row) => [Buffer.from(`${row.mode} ${row.name}\0`), Buffer.from(row.sha, 'hex')])));
  };
  return encode(root);
}
const processPaths = new Set([
  '.changes/release-unpublished-main-recovery.md',
  'docs/RELEASING.md', 'scripts/release-control.cjs', 'scripts/release-github.cjs', 'scripts/release-prepare.cjs',
  'test/release/helpers.mjs', 'test/release/release-control.test.mjs', 'test/release/runner.test.mjs',
  'test/release/unpublished-recovery.test.mjs', 'test/release/workflow-contract.test.mjs',
]);
const frozenPaths = new Map([
  ['.changes/release-app-private-identity.md', 'da9618a0484f0de922ed524e595d70933d2bfdae6988d04badd0f32292090075'],
  ['scripts/release-app-auth.cjs', '121bc384e468ebc2246043996e7744bee914fa78005247b810782921c824c6d1'],
  ['scripts/release-runner.cjs', '16638886696dc013a0fdc0dec0486cd3317178b410ce548d03b6d2a0bed4b015'],
  ['test/release/app-identity.test.mjs', '12b153efc17ae37e3ae386c6c52aab4535f1c5df341d94605036d25e05c7f437'],
]);
// Separately reviewed fixture-only migrations. These are exact byte transitions,
// not new writable test-path exemptions in the package-input comparison.
const fixtureTransitions = new Map([
  ['test/release/archive.test.mjs', ['825f4e9be63d2759ddf958ab4d9152e92b9bab2c92fe1ee8d92a913a340dccc8', '065e0d3b27e84b70ad8eccb6793820c508ecf39aaba3f7cf5098a0e93bbf780b']],
  ['test/release/diagnostics.test.mjs', ['b1d3f205bfe3d454fcff5bf40c0f0d097725416e09fb0fd24e392c3bb9819640', 'e537a64bdb715f3645e54aa8fc46dda35ce9b30d3da53e24824a6233dab5f6bd']],
]);
function requirePublicationClosure(original, current, admittedHistory) {
  for (const path of new Set([...original.keys(), ...current.keys()])) {
    const a = original.get(path), b = current.get(path);
    if (a && b && a.mode === b.mode && a.sha === b.sha) continue;
    if (path.startsWith('.release/')) {
      if (!a && b && admittedHistory.has(path)) continue;
      fail('recovery-payload');
    }
    if (a && !b) fail('recovery-payload');
    if (!b || b.mode !== '100644' || (a && a.mode !== '100644')) fail('recovery-payload');
    if (a && fragmentPath(path)) fail('recovery-payload');
    if (processPaths.has(path) || (!a && fragmentPath(path))) continue;
    if (a && fixtureTransitions.has(path)) {
      const [before, after] = fixtureTransitions.get(path);
      if (digest(a.bytes) === before && digest(b.bytes) === after) continue;
    }
    if (frozenPaths.has(path) && digest(b.bytes) === frozenPaths.get(path)) continue;
    if (path === '.github/workflows/publish.yml' && a) {
      const line = '          APP_PRIVATE_KEY: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}\n';
      const text = decodeRaw(b.bytes);
      if (digest(b.bytes) === '403863a0512ba92a5e29295b73e5991bfdc78cd1bd131fe4866cdb1107236c73' &&
        text.split(line).length === 4 && Buffer.from(text.split(line).join('')).equals(a.bytes)) continue;
    }
    fail('recovery-payload');
  }
}
function prepareRecovery({ repository, sha: baseSha, tree, version, origin, predecessor, previous, queue, notes }) {
  const data = { schema: 1, kind: 'unpublished-recovery', package: 'foottrace', version,
    sequence: previous ? previous.data.sequence + 1 : 1, repository, base: { sha: baseSha, tree }, origin, predecessor,
    previous: previous ? { path: previous.path, sha256: previous.sha256 } : null, queuedFragments: queue };
  const raw = intentBytes(data, repository), path = intentPath(version, data.sequence);
  return { package: 'foottrace', fromVersion: version, version, bump: null, tag: `v${version}`, notes,
    updates: { [path]: decodeRaw(raw) }, deletions: [] };
}
module.exports = { prepareReleaseDocs, prepareRelease, parseVersion, digest, gitObject, treeOid, versionOrder,
  intentPath, admitIntent, intentBytes, admitIntentNamespace, decodeRaw, fragmentQueue,
  requireQueueSubset, requirePublicationClosure, prepareRecovery };
