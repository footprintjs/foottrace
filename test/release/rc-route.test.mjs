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
  assert.match(yaml, /npm publish "\$PACKAGE_FILE" --ignore-scripts --access public --tag "\$NPM_TAG"/);
});
