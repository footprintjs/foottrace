import test from 'node:test';
import assert from 'node:assert/strict';
import { call, read } from './helpers.mjs';
const fragment = (type = 'fixed', bump = 'patch', body = '- Correct release behavior.') =>
  `---\ntype: ${type}\nbump: ${bump}\n---\n\n${body}\n`;
test('fragments: the existing metadata note retains its explicit minor bump', () => {
  const parsed = call('release-changes', 'parseFragment', 'metadata-query.md', read('.changes/metadata-query.md'));
  assert.equal(parsed.type, 'added');
  assert.equal(parsed.bump, 'minor');
  assert.match(parsed.body, /Optional `foottrace\/metadata`/);
});
for (const [name, text] of [
  ['inherited type', fragment('__proto__')],
  ['constructor type', fragment('constructor')],
  ['inherited bump', fragment('fixed', 'toString')],
  ['empty body', fragment('fixed', 'patch', '')],
  ['duplicate type', '---\ntype: fixed\ntype: added\nbump: patch\n---\n\n- Text.\n'],
  ['unknown field', '---\ntype: fixed\nbump: patch\ncommand: nope\n---\n\n- Text.\n'],
])
  test(`fragments refuse: ${name}`, () => {
    // Require the helper first, so missing implementation is recorded as red,
    // never mistaken for a successful malformed-fragment refusal.
    const valid = call('release-changes', 'parseFragment', 'valid.md', fragment());
    assert.equal(valid.bump, 'patch');
    assert.throws(
      () => call('release-changes', 'parseFragment', 'bad.md', text),
      (e) => e.code === 'invalid-fragment',
    );
  });
test('fragments: strongest bump wins without lowering metadata minor', () => {
  assert.equal(
    call('release-changes', 'selectBump', [
      { type: 'fixed', bump: 'patch' },
      { type: 'added', bump: 'minor' },
    ]),
    'minor',
  );
});
test('fragments: no fragments produce no release', () => assert.equal(call('release-changes', 'selectBump', []), null));
test('version: patch/minor/major increments remain deterministic', () => {
  assert.equal(call('release-changes', 'nextVersion', '1.8.0', 'patch'), '1.8.1');
  assert.equal(call('release-changes', 'nextVersion', '1.8.0', 'minor'), '1.9.0');
  assert.equal(call('release-changes', 'nextVersion', '1.8.0', 'major'), '2.0.0');
});
test('current README corrects published PROV without premature metadata release', () => {
  const text = read('README.md');
  assert(text.includes('## PROV-O export (since 1.6.0)'));
  assert(text.includes('## Value-free trace metadata — unreleased'));
  assert(read('docs/metadata.md').includes('This is an unreleased additive entry point.'));
});
test('release docs: only exact metadata markers change to the computed version', () => {
  const documents = { 'README.md': read('README.md'), 'docs/metadata.md': read('docs/metadata.md') };
  const result = call('release-prepare', 'prepareReleaseDocs', {
    documents,
    version: '1.9.0',
    selectedFragments: ['metadata-query.md'],
  });
  assert.equal(
    result['README.md'],
    documents['README.md'].replace(
      '## Value-free trace metadata — unreleased',
      '## Value-free trace metadata (since 1.9.0)',
    ),
  );
  assert.equal(
    result['docs/metadata.md'],
    documents['docs/metadata.md'].replace(
      'This is an unreleased additive entry point. The package version and existing\nrecord fixtures remain unchanged until a separately reviewed release.',
      'This additive entry point is included from FootTrace 1.9.0. Existing complete-record APIs and saved records retain their prior contracts.',
    ),
  );
});
test('release docs: unselected metadata fragment leaves all status text intact', () => {
  const documents = { 'README.md': read('README.md'), 'docs/metadata.md': read('docs/metadata.md') };
  assert.deepEqual(
    call('release-prepare', 'prepareReleaseDocs', {
      documents,
      version: '1.8.1',
      selectedFragments: ['release-app.md'],
    }),
    documents,
  );
});
for (const mode of ['missing', 'duplicate'])
  test(`release docs refuse ${mode} marker`, () => {
    const documents = { 'README.md': read('README.md'), 'docs/metadata.md': read('docs/metadata.md') };
    call('release-prepare', 'prepareReleaseDocs', {
      documents,
      version: '1.9.0',
      selectedFragments: ['metadata-query.md'],
    });
    const marker = '## Value-free trace metadata — unreleased';
    documents['README.md'] =
      mode === 'missing'
        ? documents['README.md'].replace(marker, 'Changed heading')
        : documents['README.md'] + '\n' + marker + '\n';
    assert.throws(
      () =>
        call('release-prepare', 'prepareReleaseDocs', {
          documents,
          version: '1.9.0',
          selectedFragments: ['metadata-query.md'],
        }),
      (e) => e.code === 'invalid-release-docs',
    );
  });
test('proposal: every selected note survives and historical bytes remain an exact suffix', () => {
  const files = Object.fromEntries(
    ['package.json', 'package-lock.json', 'CHANGELOG.md', 'README.md', 'docs/metadata.md'].map((n) => [n, read(n)]),
  );
  const fragments = {
    'metadata-query.md': read('.changes/metadata-query.md'),
    'second.md': fragment('fixed', 'patch', '- Exact second note.'),
  };
  const result = call('release-prepare', 'prepareRelease', { files, fragments, date: '2026-10-30' });
  assert.equal(result.version, '1.9.0');
  assert.equal(result.fromVersion, '1.8.0');
  assert(result.notes.includes('Exact second note.'));
  assert(result.notes.includes('Optional `foottrace/metadata`'));
  assert(result.updates['CHANGELOG.md'].endsWith(files['CHANGELOG.md'].slice('# Changelog\n\n'.length)));
  const pkg = JSON.parse(result.updates['package.json']);
  const old = JSON.parse(files['package.json']);
  pkg.version = old.version;
  assert.deepEqual(pkg, old);
  const lock = JSON.parse(result.updates['package-lock.json']);
  const oldLock = JSON.parse(files['package-lock.json']);
  lock.version = oldLock.version;
  lock.packages[''].version = oldLock.version;
  assert.deepEqual(lock, oldLock);
  assert.deepEqual(result.deletions, ['.changes/metadata-query.md', '.changes/second.md']);
});
test('declared fragment types and bumps are independent explicit schema choices', () => {
  for (const type of ['added', 'changed', 'deprecated', 'removed', 'fixed', 'security', 'documentation'])
    for (const bump of ['patch', 'minor', 'major']) {
      const parsed = call('release-changes', 'parseFragment', 'explicit.md', fragment(type, bump));
      assert.equal(parsed.type, type);
      assert.equal(parsed.bump, bump);
    }
  for (const version of ['01.8.0', '1.8', '1.8.0-beta', '1.8.0 ', '9007199254740991.0.0'])
    assert.throws(() => call('release-changes', 'nextVersion', version, 'major'), /invalid-version/);
});
