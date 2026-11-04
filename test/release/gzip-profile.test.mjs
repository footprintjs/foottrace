import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { syntheticPackageArchive } from './helpers.mjs';
const require = createRequire(import.meta.url),
  { inspectArchive } = require('../../scripts/release-archive.cjs');
const bytes = syntheticPackageArchive('2.0.0-rc.0'),
  expected = { package: 'foottrace', version: '2.0.0-rc.0' };
test('gzip profile admits the ordinary one-member flags-zero npm wrapper', () => {
  assert.equal(bytes[3], 0);
  assert.equal(inspectArchive(bytes, expected).version, expected.version);
});
const extra = Buffer.from(bytes);
extra[3] = 4;
const fname = Buffer.from(bytes);
fname[3] = 8;
const comment = Buffer.from(bytes);
comment[3] = 16;
for (const [name, value] of [
  [
    'FEXTRA',
    Buffer.concat([extra.subarray(0, 10), Buffer.from([255, 255]), Buffer.alloc(65535, 7), extra.subarray(10)]),
  ],
  ['FNAME', Buffer.concat([fname.subarray(0, 10), Buffer.from([110, 97, 109, 101, 0]), fname.subarray(10)])],
  [
    'FCOMMENT',
    Buffer.concat([comment.subarray(0, 10), Buffer.from([99, 111, 109, 109, 101, 110, 116, 0]), comment.subarray(10)]),
  ],
  ['second empty member', Buffer.concat([bytes, gzipSync(Buffer.alloc(0))])],
  ['second archive member', Buffer.concat([bytes, bytes])],
  ['trailing NUL', Buffer.concat([bytes, Buffer.from([0])])],
  ['NUL then unrelated bytes', Buffer.concat([bytes, Buffer.from([0]), Buffer.alloc(8192, 53)])],
])
  test('gzip profile refuses ' + name, () => {
    assert(gunzipSync(value).length > 0, 'control: node gunzip would admit this wrapper');
    assert.throws(() => inspectArchive(value, expected), { code: 'invalid-archive' });
  });
for (const offset of [8, 4])
  test('gzip profile validates trailer field ' + offset, () => {
    const changed = Buffer.from(bytes);
    changed[changed.length - offset] ^= 1;
    assert.throws(() => inspectArchive(changed, expected), { code: 'invalid-archive' });
  });

test('gzip flags policy refuses FTEXT and every reserved flag bit', () => {
  for (const bit of [1, 32, 64, 128]) {
    const changed = Buffer.from(bytes);
    changed[3] = bit;
    assert.throws(() => inspectArchive(changed, expected), { code: 'invalid-archive' });
  }
});
