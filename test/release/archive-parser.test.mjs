import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  { inspectArchive } = require('../../scripts/release-archive.cjs');
const here = path.dirname(fileURLToPath(import.meta.url)),
  fixture = path.join(here, 'fixtures/archive-parsers');
function npmRoot() {
  for (const folder of (process.env.PATH ?? '').split(path.delimiter)) {
    try {
      const executable = fs.realpathSync(path.join(folder, 'npm')),
        root = path.dirname(path.dirname(executable));
      if (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version === '11.19.0') return root;
    } catch {}
  }
  assert.fail('npm11.19.0 is required, as installed by CI; no comparator skip');
}
const root = npmRoot(),
  cases = JSON.parse(fs.readFileSync(path.join(fixture, 'cases.json'), 'utf8'));
function npmManifest(file) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-npm-reader-'));
  try {
    const r = spawnSync(process.execPath, [path.join(here, 'npm-manifest-reader.cjs'), file, root], {
      cwd: home,
      env: { HOME: home, NPM_TEST_CACHE: path.join(home, 'cache') },
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    // node-tar refuses the crafted NUL/newline path with this uncaught input
    // error. Preserve it as a reader refusal, never as an admitted manifest.
    if (r.status === 1 && /code: 'ERR_INVALID_ARG_VALUE'/.test(r.stderr)) return { error: 'ERR_INVALID_ARG_VALUE' };
    assert.equal(r.status, 0, 'npm own-reader child must finish');
    return JSON.parse(r.stdout);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
for (const row of cases)
  test('canonical archive/npm reader agreement: ' + row.file, () => {
    const file = path.join(fixture, row.file),
      bytes = fs.readFileSync(file);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256);
    const npm = npmManifest(file),
      expected = { package: 'foottrace', version: row.version };
    if (!row.canonicalAllowed) {
      assert.throws(() => inspectArchive(bytes, expected), { code: 'invalid-archive' });
    } else {
      const actual = inspectArchive(bytes, expected);
      assert.deepEqual(npm, { name: actual.package, version: actual.version, hasPublishConfig: false });
    }
  });

for (const version of ['1.12.0', '1.12.0-rc.0'])
  test('real npm11.19 canonical pack agrees for ' + version, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-canonical-pack-'));
    try {
      const input = path.join(home, 'input');
      fs.mkdirSync(path.join(input, 'dist'), { recursive: true });
      fs.writeFileSync(
        path.join(input, 'package.json'),
        JSON.stringify({ name: 'foottrace', version, files: ['dist'] }) + '\n',
      );
      fs.writeFileSync(path.join(input, 'dist/index.js'), 'exports.fixture = true;\n');
      const packed = spawnSync(
        process.execPath,
        [
          path.join(root, 'bin/npm-cli.js'),
          'pack',
          '--ignore-scripts',
          '--offline',
          '--json',
          '--pack-destination',
          home,
        ],
        {
          cwd: input,
          env: {
            HOME: home,
            PATH: process.env.PATH,
            npm_config_cache: path.join(home, 'cache'),
            npm_config_update_notifier: 'false',
          },
          encoding: 'utf8',
          timeout: 15000,
          maxBuffer: 1024 * 1024,
        },
      );
      assert.equal(packed.status, 0, 'canonical npm pack must succeed');
      const rows = JSON.parse(packed.stdout);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].filename, 'foottrace-' + version + '.tgz');
      const file = path.join(home, rows[0].filename),
        actual = inspectArchive(fs.readFileSync(file), { package: 'foottrace', version });
      assert.deepEqual(npmManifest(file), { name: actual.package, version: actual.version, hasPublishConfig: false });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
