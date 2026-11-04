import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const checker = path.resolve('scripts/check-release-archive.cjs');
const root = fs.realpathSync(
  process.env.PATH.split(path.delimiter)
    .map((p) => path.join(p, 'npm'))
    .find((p) => fs.existsSync(p)),
);
const npmCli = root;
function fixture(t, file = 'dist/index.js') {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-pack-profile-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  const source = {
    name: 'foottrace',
    version: '1.11.0',
    files: ['dist/'],
    scripts: { prepack: 'exit 91', postpack: 'exit 92' },
  };
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(source) + '\n');
  fs.writeFileSync(path.join(cwd, file), 'exports.fixture=true;\n');
  const run = (args) =>
    spawnSync('git', args, {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: cwd,
        TMPDIR: process.env.TMPDIR,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
      encoding: 'utf8',
    });
  for (const args of [
    ['init', '-q'],
    ['add', 'package.json', file],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'],
  ])
    assert.equal(run(args).status, 0);
  return { cwd, source, run };
}
function check(cwd, executable = npmCli) {
  return spawnSync(process.execPath, [checker], {
    cwd,
    env: { PATH: process.env.PATH, HOME: cwd, TMPDIR: process.env.TMPDIR, npm_execpath: executable },
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
}
test('real-pack check is part of the normal check command without replacing any gate', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.match(pkg.scripts.check, /npm run check:archive/);
  assert.equal(pkg.scripts['check:archive'], 'node scripts/check-release-archive.cjs');
  assert.match(pkg.scripts.check, /npm run check:package/);
  assert.match(pkg.scripts.check, /npm run test:release/);
});
test('real-pack check admits source-equal ordinary pack without lifecycle execution', (t) => {
  const f = fixture(t),
    r = check(f.cwd);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'archive-profile:checked');
  assert.equal(f.run(['status', '--porcelain']).stdout, '');
});
for (const [name, file] of [
  ['ustar prefix', 'dist/' + 'a'.repeat(91) + '/index.js'],
  ['PAX Unicode', 'dist/naïve.js'],
  ['PAX long path', 'dist/' + 'long/'.repeat(54) + 'index.js'],
])
  test('real-pack check names unsupported ' + name, (t) => {
    const f = fixture(t, file),
      r = check(f.cwd);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.trim(), 'archive-profile');
    assert.equal(r.stdout, '');
    assert.equal(f.run(['status', '--porcelain']).stdout, '');
  });
test('real-pack check compares with pinned HEAD, not a changed staging manifest', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.cwd, 'package.json'), JSON.stringify({ ...f.source, tag: 'latest' }));
  const r = check(f.cwd);
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), 'manifest-source:tag');
});

test('real pack child keeps the caller temporary directory', (t) => {
  const f = fixture(t),
    temporary = path.join(f.cwd, 'child-temp'),
    log = path.join(f.cwd, 'pack-argv.json');
  fs.mkdirSync(temporary);
  const wrapper = path.join(f.cwd, 'capture-npm.cjs');
  fs.writeFileSync(
    wrapper,
    'require("node:fs").writeFileSync(' +
      JSON.stringify(log) +
      ',JSON.stringify({destination:process.argv.at(-1)}));require(' +
      JSON.stringify(npmCli) +
      ');\n',
  );
  const prior = process.env.TMPDIR;
  let result;
  try {
    process.env.TMPDIR = temporary;
    result = check(f.cwd, wrapper);
  } finally {
    if (prior === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prior;
  }
  assert.equal(result.status, 0, result.stderr);
  assert.equal(path.dirname(JSON.parse(fs.readFileSync(log, 'utf8')).destination), temporary);
});
