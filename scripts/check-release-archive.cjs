'use strict';
// Unprivileged PR gate: inspect a real pack against the committed source manifest.
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { execFileSync } = require('node:child_process'),
  { inspectArchive, archiveRefusalCode } = require('./release-archive.cjs');
let temporary;
try {
  const cwd = process.cwd(),
    env = {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_ALLOW_PROTOCOL: '',
    };
  const source = JSON.parse(
    execFileSync('git', ['show', 'HEAD:package.json'], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  if (source.name !== 'foottrace' || !/^\d+\.\d+\.\d+$/.test(source.version) || !process.env.npm_execpath)
    throw Error('archive-pack');
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'foottrace-pack-check-'));
  const packed = JSON.parse(
    execFileSync(
      process.execPath,
      [process.env.npm_execpath, 'pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', temporary],
      {
        cwd,
        env: {
          PATH: process.env.PATH,
          HOME: temporary,
          npm_config_cache: path.join(temporary, 'cache'),
          npm_config_update_notifier: 'false',
          npm_config_userconfig: path.join(temporary, 'user.npmrc'),
          npm_config_globalconfig: path.join(temporary, 'global.npmrc'),
        },
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ),
  );
  const file = 'foottrace-' + source.version + '.tgz';
  if (!Array.isArray(packed) || packed.length !== 1 || packed[0].filename !== file) throw Error('archive-pack');
  inspectArchive(fs.readFileSync(path.join(temporary, file)), {
    package: source.name,
    version: source.version,
    sourceManifest: source,
  });
  process.stdout.write('archive-profile:checked\n');
} catch (error) {
  process.stderr.write((archiveRefusalCode(error) || 'archive-pack') + '\n');
  process.exitCode = 1;
} finally {
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
}
