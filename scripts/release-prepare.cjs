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
module.exports = { prepareReleaseDocs, prepareRelease };
