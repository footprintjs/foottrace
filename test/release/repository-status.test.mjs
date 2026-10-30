import test from 'node:test';
import assert from 'node:assert/strict';
import { call, loadReleaseSpecimen } from './helpers.mjs';
import { assertRepositoryStatus, currentReleaseState, METADATA_HEADING, METADATA_PARAGRAPH } from './status-assertions.mjs';

const fragment = '---\ntype: fixed\nbump: patch\n---\n\n- Exact unrelated later correction.\n';
const released = () => {
  const input = loadReleaseSpecimen();
  const prepared = call('release-prepare', 'prepareRelease', { ...input, date: '2026-10-30' });
  assert.equal(prepared.fromVersion, '1.8.0'); assert.equal(prepared.version, '1.9.0');
  assert.deepEqual(prepared.deletions, ['.changes/metadata-query.md']);
  assert(prepared.notes.includes('Optional `foottrace/metadata`'));
  assert(prepared.updates['CHANGELOG.md'].endsWith(input.files['CHANGELOG.md'].slice('# Changelog\n\n'.length)));
  assert.equal(prepared.updates['README.md'], input.files['README.md'].replace(METADATA_HEADING, '## Value-free trace metadata (since 1.9.0)'));
  assert.equal(prepared.updates['docs/metadata.md'], input.files['docs/metadata.md'].replace(METADATA_PARAGRAPH, 'This additive entry point is included from FootTrace 1.9.0. Existing complete-record APIs and saved records retain their prior contracts.'));
  return { files: { ...input.files, ...prepared.updates }, fragments: {} };
};

test('repository: actual checkout has consistent release status', () => {
  assertRepositoryStatus(currentReleaseState());
});
test('specimen: complete captured bytes load independently without shared mutations', () => {
  const a = loadReleaseSpecimen(), b = loadReleaseSpecimen();
  assert.deepEqual(a, b); a.files['package.json'] = 'changed'; a.fragments['metadata-query.md'] = 'changed';
  assert.deepEqual(loadReleaseSpecimen(), b); assert.notDeepEqual(a, b);
  assert.equal(JSON.parse(b.files['package.json']).version, '1.8.0');
  assert(Object.keys(JSON.parse(b.files['package-lock.json']).packages).length > 100);
});
test('lifecycle: pending, consumed and later unrelated release preserve independent obligations', () => {
  const pending = loadReleaseSpecimen(); assert.deepEqual(assertRepositoryStatus(pending), { mode: 'pending', packageVersion: '1.8.0' });
  const first = released(); assert.deepEqual(assertRepositoryStatus(first), { mode: 'released', packageVersion: '1.9.0', metadataSince: '1.9.0' });
  assert.equal(call('release-prepare', 'prepareRelease', { ...first, date: '2026-10-31' }), null);
  first.fragments['later.md'] = fragment;
  assert.equal(assertRepositoryStatus(first).mode, 'released');
  const second = call('release-prepare', 'prepareRelease', { ...first, date: '2026-10-31' });
  assert.equal(second.fromVersion, '1.9.0'); assert.equal(second.version, '1.9.1');
  assert.deepEqual(second.deletions, ['.changes/later.md']); assert.equal(second.notes, '### Fixed\n\n- Exact unrelated later correction.\n');
  assert(!Object.hasOwn(second.updates, 'README.md')); assert(!Object.hasOwn(second.updates, 'docs/metadata.md'));
  assert(second.updates['CHANGELOG.md'].endsWith(first.files['CHANGELOG.md'].slice('# Changelog\n\n'.length)));
  assert.deepEqual(assertRepositoryStatus({ files: { ...first.files, ...second.updates }, fragments: {} }), { mode: 'released', packageVersion: '1.9.1', metadataSince: '1.9.0' });
});
const replaceFile = (state, file, before, after) => { assert(state.files[file].includes(before)); state.files[file] = state.files[file].replace(before, after); };
for (const [name, make, corrupt, code] of [
  ['missing PROV', released, s => replaceFile(s, 'README.md', '## PROV-O export (since 1.6.0)', ''), 'status-prov'],
  ['changed PROV', released, s => replaceFile(s, 'README.md', '(since 1.6.0)', '(since 1.7.0)'), 'status-prov'],
  ['duplicate PROV', released, s => { s.files['README.md'] += '\n## PROV-O export (since 1.6.0)\n'; }, 'status-prov'],
  ['missing metadata heading', released, s => replaceFile(s, 'README.md', '## Value-free trace metadata (since 1.9.0)', ''), 'status-metadata-heading'],
  ['duplicate metadata heading', released, s => { s.files['README.md'] += '\n## Value-free trace metadata (since 1.9.0)\n'; }, 'status-metadata-heading'],
  ['missing metadata paragraph', released, s => replaceFile(s, 'docs/metadata.md', 'This additive entry point is included', 'Removed status'), 'status-metadata-paragraph'],
  ['duplicate metadata paragraph', released, s => { s.files['docs/metadata.md'] += '\nThis additive entry point is included from FootTrace 1.9.0. Existing complete-record APIs and saved records retain their prior contracts.\n'; }, 'status-metadata-paragraph'],
  ['contradictory paragraph', released, s => replaceFile(s, 'docs/metadata.md', 'FootTrace 1.9.0.', 'FootTrace 1.8.0.'), 'status-released-paragraph'],
  ['malformed version', released, s => replaceFile(s, 'README.md', '(since 1.9.0)', '(since 01.9.0)'), 'status-version'],
  ['future introduction', released, s => { replaceFile(s, 'README.md', '(since 1.9.0)', '(since 9.0.0)'); replaceFile(s, 'docs/metadata.md', 'FootTrace 1.9.0.', 'FootTrace 9.0.0.'); }, 'status-future-introduction'],
  ['missing history', released, s => replaceFile(s, 'CHANGELOG.md', '## 1.9.0 — 2026-10-30', '## 1.7.0 — 2026-10-30'), 'status-history-section'],
  ['duplicate history', released, s => { s.files['CHANGELOG.md'] += '\n## 1.9.0 — 2026-10-30\n'; }, 'status-history-section'],
  ['missing note', released, s => replaceFile(s, 'CHANGELOG.md', 'Optional `foottrace/metadata`', 'Omitted feature'), 'status-history-note'],
  ['duplicate note', released, s => { const note = loadReleaseSpecimen().fragments['metadata-query.md'].split('\n---\n')[1].trim(); replaceFile(s, 'CHANGELOG.md', note, note + '\n' + note); }, 'status-history-note'],
  ['stale fragment', released, s => { s.fragments = loadReleaseSpecimen().fragments; }, 'status-pending-heading'],
  ['absent pending fragment', loadReleaseSpecimen, s => { s.fragments = {}; }, 'status-released-heading'],
  ['pending changed paragraph', loadReleaseSpecimen, s => replaceFile(s, 'docs/metadata.md', METADATA_PARAGRAPH, 'This is an unreleased additive entry point. Changed text.'), 'status-pending-paragraph'],
  ['pending duplicate paragraph', loadReleaseSpecimen, s => { s.files['docs/metadata.md'] += '\n' + METADATA_PARAGRAPH + '\n'; }, 'status-metadata-paragraph'],
  ['pending wrong bump', loadReleaseSpecimen, s => { s.fragments['metadata-query.md'] = s.fragments['metadata-query.md'].replace('bump: minor', 'bump: patch'); }, 'status-pending-fragment'],
  ['restored pending markers after introduction', released, s => {
    s.fragments = loadReleaseSpecimen().fragments;
    replaceFile(s, 'README.md', '## Value-free trace metadata (since 1.9.0)', METADATA_HEADING);
    replaceFile(s, 'docs/metadata.md', 'This additive entry point is included from FootTrace 1.9.0. Existing complete-record APIs and saved records retain their prior contracts.', METADATA_PARAGRAPH);
  }, 'status-pending-history'],
  ...[['pending package missing from history', loadReleaseSpecimen], ['released package missing from history', released]].map(([name, make]) => [name, make, s => {
    const pkg = JSON.parse(s.files['package.json']), lock = JSON.parse(s.files['package-lock.json']);
    pkg.version = '2.0.0'; lock.version = '2.0.0'; lock.packages[''].version = '2.0.0';
    s.files['package.json'] = JSON.stringify(pkg); s.files['package-lock.json'] = JSON.stringify(lock);
  }, 'status-package-history']),
  ['lock mismatch', released, s => { const lock = JSON.parse(s.files['package-lock.json']); lock.version = '1.8.0'; s.files['package-lock.json'] = JSON.stringify(lock); }, 'status-package'],
  ['root lock mismatch', released, s => { const lock = JSON.parse(s.files['package-lock.json']); lock.packages[''].version = '1.8.0'; s.files['package-lock.json'] = JSON.stringify(lock); }, 'status-package'],
]) test(`repository refuses ${name}, including with unrelated pending fragment`, () => {
  const valid = make(); assertRepositoryStatus(valid); corrupt(valid); valid.fragments['later.md'] = fragment;
  assert.throws(() => assertRepositoryStatus(valid), error => error.code === code);
});
