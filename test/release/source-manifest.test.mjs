import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { syntheticPackageArchive } from './helpers.mjs';
const require = createRequire(import.meta.url),
  archive = require('../../scripts/release-archive.cjs');
const source = {
  name: 'foottrace',
  version: '1.11.0',
  files: ['dist/'],
  scripts: { build: 'trusted-source-build' },
  dependencies: { example: '1.0.0' },
  description: 'source',
};
const inspect = (manifest, version = '1.12.0-rc.0') =>
  archive.inspectArchive(syntheticPackageArchive(version, manifest), {
    package: 'foottrace',
    version,
    sourceManifest: source,
  });
test('archive source-manifest rule permits only version and JSON object key ordering', () => {
  const manifest = {
    description: 'source',
    dependencies: { example: '1.0.0' },
    scripts: { build: 'trusted-source-build' },
    files: ['dist/'],
    version: '1.12.0-rc.0',
    name: 'foottrace',
  };
  assert.equal(inspect(manifest).version, '1.12.0-rc.0');
  assert.equal(inspect({ ...source, version: '1.12.0' }, '1.12.0').version, '1.12.0');
});
for (const [key, value] of [
  ['tag', 'latest'],
  ['publishConfig', { registry: 'http://127.0.0.1:9/evil/' }],
  ['scripts', { ...source.scripts, postinstall: 'untrusted' }],
  ['dependencies', { example: '9.0.0' }],
  ['bin', { tool: 'dist/untrusted.js' }],
  ['dist', { tarball: 'untrusted' }],
  ['description', 'changed'],
  ['files', ['dist/unexpected/']],
])
  test('archive source-manifest rule refuses first differing key ' + key, () => {
    const manifest = { ...source, version: '1.12.0-rc.0', [key]: value };
    assert.throws(
      () => inspect(manifest),
      (error) => archive.archiveRefusalCode(error) === 'manifest-source:' + key,
    );
  });
test('archive source-manifest rule refuses deleted source fields', () => {
  const manifest = { ...source, version: '1.12.0-rc.0' };
  delete manifest.dependencies;
  assert.throws(
    () => inspect(manifest),
    (error) => error.code === 'manifest-source',
  );
});
test('independent canonical tag override archives cannot pass pinned source binding', () => {
  for (const file of ['T1-rc-tag-latest.tgz', 'T2-stable-tag-next.tgz', 'T3-rc-tag-scripts.tgz']) {
    const version = file.startsWith('T2') ? '1.12.0' : '1.12.0-rc.0';
    assert.throws(
      () =>
        archive.inspectArchive(fs.readFileSync(new URL('./fixtures/archive-parsers/' + file, import.meta.url)), {
          package: 'foottrace',
          version,
          sourceManifest: { name: 'foottrace', version: '1.11.0' },
        }),
      (error) => error.code === 'manifest-source',
    );
  }
});

test('archive manifest diagnostics name the first sorted key and hide unknown raw keys', () => {
  const manifest = { ...source, version: '1.12.0-rc.0', tag: 'latest', bin: { tool: 'dist/no.js' } };
  assert.throws(
    () => inspect(manifest),
    (error) => archive.archiveRefusalCode(error) === 'manifest-source:bin',
  );
  const raw = 'unexpected-private-value\\nmarker';
  assert.throws(
    () => inspect({ ...source, version: '1.12.0-rc.0', [raw]: true }),
    (error) => {
      const code = archive.archiveRefusalCode(error);
      assert.match(code, /^manifest-source:key-[a-f0-9]{12}$/);
      assert(!code.includes(raw));
      assert(!error.message.includes(raw));
      return true;
    },
  );
});
