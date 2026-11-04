import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { read } from './helpers.mjs';
const require = createRequire(import.meta.url),
  version = require('../../scripts/release-rc-version.cjs');
test('checked archive version chooses next for canonical RC and latest for stable', () => {
  assert.equal(typeof version.distributionTag, 'function', 'missing checked-version tag selector');
  assert.equal(version.distributionTag('2.0.0-rc.0'), 'next');
  assert.equal(version.distributionTag('1.11.0'), 'latest');
  for (const value of ['2.0.0-rc.01', '2.0.0-beta.1', '2.0.0\n']) assert.throws(() => version.distributionTag(value));
});
test('actual workflow admits RC authority while preserving preparation and stable publication', () => {
  const yaml = read('.github/workflows/publish.yml'),
    block = yaml.split('  authority:\n')[1].split('\n  verdict:')[0],
    expression = /^    if: (.+)$/m.exec(block)[1];
  const gate = (mode) => Function('needs', 'return (' + expression + ')')({ plan: { outputs: { mode } } });
  assert.equal(gate('rc'), true);
  assert.equal(gate('publish'), true);
  assert.equal(gate('prepare'), false);
  assert.equal(gate('verify'), false);
  assert.match(yaml, /      rc:\n[\s\S]*?type: boolean/);
  assert.match(yaml, /      bump:\n[\s\S]*?options: \[none, patch, minor, major\]/);
  assert.match(yaml, /NPM_TAG: \$\{\{ steps\.control\.outputs\.npmtag \}\}/);
  assert.match(
    yaml,
    /next\) npm publish "\$PACKAGE_FILE" --ignore-scripts --access public --tag next --registry=https:\/\/registry\.npmjs\.org/,
  );
});

const yaml = read('.github/workflows/publish.yml');
function job(name) {
  const rest = yaml.split('  ' + name + ':\n')[1];
  assert(rest, 'missing native job ' + name);
  return rest.split(/\n  [a-z][a-z-]*:\n/)[0];
}
function condition(name) {
  const block = job(name),
    folded = /^    if: >-\n((?:      [^\n]*\n)+)/m.exec(block);
  return folded ? folded[1].trim().replace(/\n\s*/g, ' ') : /^    if: (.*)$/m.exec(block)[1];
}
function envValue(name, inputs) {
  const expression = new RegExp('^  ' + name + ': (.+)$', 'm').exec(yaml)?.[1];
  assert(expression, 'missing native input mapping ' + name);
  return expression.startsWith('${{')
    ? Function('inputs', 'return (' + expression.slice(3, -2).trim() + ')')(inputs)
    : expression;
}
test('native dispatch boolean and explicit bump reach the helper unchanged', () => {
  for (const rc of [false, true, undefined])
    for (const bump of ['none', 'patch', 'minor', 'major', undefined]) {
      assert.equal(envValue('RC', { rc, bump }), rc === true ? 'true' : 'false');
      assert.equal(envValue('RC_BUMP', { rc, bump }), bump);
    }
});
test('ordinary stable pack runs only outside RC mode', () => {
  const block = job('build'),
    ordinary = /      - if: (.+)\n        run: npm pack --ignore-scripts --json > pack\.json\n/.exec(block);
  assert(ordinary, 'stable pack step is required');
  for (const mode of ['publish', 'rc'])
    assert.equal(Function('needs', 'return (' + ordinary[1] + ')')({ plan: { outputs: { mode } } }), mode !== 'rc');
});
test('RC and stable build uploads name only the two fixed checked artifacts', () => {
  const upload = job('build').split('      - uses: actions/upload-artifact@')[1];
  assert(upload, 'fixed upload action required');
  assert.equal(
    /          path: \|\n((?:            .+\n)+)/.exec(upload)?.[1],
    '            release-artifact/package.tgz\n            release-artifact/manifest.json\n',
  );
});
test('both native runtime gate lanes run for an authorized untested RC', () => {
  assert.match(job('gates'), /node: \[22, 24\]/);
  for (const mode of ['publish', 'rc'])
    for (const authorized of ['true', 'false'])
      for (const tested of ['true', 'false']) {
        const needs = {
          plan: { outputs: { mode } },
          authority: { outputs: { authorized } },
          verdict: { outputs: { tested } },
        };
        assert.equal(
          Function('needs', 'return (' + condition('gates') + ')')(needs),
          authorized === 'true' && tested !== 'true',
        );
      }
});
test('one native release concurrency group serializes stable and RC without cancellation', () => {
  assert.equal(
    /^concurrency:\n((?:  [^\n]*\n)+)/m.exec(yaml)?.[1],
    '  group: foottrace-release\n  cancel-in-progress: false\n',
  );
});
