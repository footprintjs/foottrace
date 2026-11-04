import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { syntheticPackageArchive } from './helpers.mjs';
const require = createRequire(import.meta.url),
  { inspectArchive } = require('../../scripts/release-archive.cjs');
const expected = { package: 'foottrace', version: '1.12.0-rc.0' };
function changed(edit, { checksum = true } = {}) {
  const tar = gunzipSync(syntheticPackageArchive(expected.version)),
    header = tar.subarray(0, 512);
  edit(header, tar);
  if (checksum) {
    header.fill(32, 148, 156);
    header.write(
      [...header]
        .reduce((a, b) => a + b, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
      148,
      'ascii',
    );
  }
  return gzipSync(tar);
}
for (let offset = 257; offset < 265; offset++)
  test('canonical header refuses magic byte ' + offset, () => {
    inspectArchive(syntheticPackageArchive(expected.version), expected);
    assert.throws(
      () =>
        inspectArchive(
          changed((h) => {
            h[offset] ^= 1;
          }),
          expected,
        ),
      { code: 'invalid-archive' },
    );
  });
test('canonical header checksum authenticates all actual header bytes', () => {
  const bytes = changed(
    (h) => {
      h[148] = h[148] === 48 ? 49 : 48;
    },
    { checksum: false },
  );
  assert.throws(() => inspectArchive(bytes, expected), { code: 'invalid-archive' });
});
for (const [name, edit, code = 'invalid-archive'] of [
  [
    'name bytes after NUL',
    (h) => {
      h[35] = 120;
    },
  ],
  [
    'empty type alias',
    (h) => {
      h[156] = 0;
    },
  ],
  [
    'link bytes after NUL',
    (h) => {
      h[159] = 120;
    },
  ],
  [
    'uname bytes',
    (h) => {
      h[265] = 120;
    },
  ],
  [
    'gname bytes',
    (h) => {
      h[297] = 120;
    },
  ],
  [
    'prefix bytes',
    (h) => {
      h[345] = 120;
    },
    'archive-profile',
  ],
  [
    'unused header tail',
    (h) => {
      h[500] = 120;
    },
  ],
  ...[
    ['mode', 100],
    ['uid', 108],
    ['gid', 116],
    ['size', 124],
    ['mtime', 136],
    ['device major', 329],
    ['device minor', 337],
  ].map(([name, offset]) => [
    name + ' base256',
    (h) => {
      h[offset] = 0x81;
    },
  ]),
  [
    'nonzero content padding',
    (_h, tar) => {
      const size = Number.parseInt(tar.subarray(124, 136).toString('ascii'), 8);
      tar[512 + size] = 1;
    },
  ],
])
  test('canonical header refuses ' + name, () => {
    assert.throws(() => inspectArchive(changed(edit), expected), { code });
  });
