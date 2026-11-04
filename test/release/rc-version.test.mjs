import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
const changes = require('../../scripts/release-changes.cjs');
const file = new URL('../../scripts/release-rc-version.cjs', import.meta.url);
test('candidate version: existing stable major bump remains the floor', () => {
  assert.equal(changes.nextVersion('1.11.0', 'major'), '2.0.0');
});
test('candidate version: package-native RC selector is available without changing stable parsing', () => {
  assert(existsSync(file), 'missing package-native RC version selector');
  const rc = require(file.pathname);
  assert.equal(typeof rc.candidateVersion, 'function');
  assert.throws(() => changes.parseVersion('2.0.0-rc.0'));
});

const rc = () => require(file.pathname);
const select = (...args) => {
  let value;
  assert.doesNotThrow(() => {
    value = rc().candidateVersion(...args);
  });
  return value;
};
test('candidate version: first major RC starts at zero with no fragment input', () => {
  assert.equal(select('1.11.0', 'major', []), '2.0.0-rc.0');
});
test('candidate version: choose highest matching N rather than tag count or provider order', () => {
  assert.equal(
    select('1.11.0', 'major', ['refs/tags/v2.0.0-rc.9', 'refs/tags/v2.0.0-rc.1', 'refs/tags/v2.0.0-rc.0']),
    '2.0.0-rc.10',
  );
});
test('candidate version: unrelated versions and ref-tail collisions cannot raise N', () => {
  assert.equal(
    select('1.11.0', 'major', ['refs/tags/v3.0.0-rc.90', 'refs/tags/v1.11.0', 'refs/tags/x/refs/tags/v2.0.0-rc.8']),
    '2.0.0-rc.0',
  );
});
test('candidate version: explicit bump selects the existing native stable target', () => {
  for (const [bump, target] of [
    ['patch', '1.11.1'],
    ['minor', '1.12.0'],
    ['major', '2.0.0'],
  ])
    assert.equal(select('1.11.0', bump, []), target + '-rc.0');
});
for (const number of ['01', '-1', '1.0', '9007199254740991'])
  test('candidate version: malformed or exhausted matching RC number refuses ' + number, () => {
    assert.throws(() => rc().candidateVersion('1.11.0', 'major', ['refs/tags/v2.0.0-rc.' + number]), {
      code: 'rc-tag-number',
    });
  });
for (const bump of [undefined, 'auto', ''])
  test('candidate version: RC requires explicit dispatch bump ' + String(bump), () => {
    assert.throws(() => rc().candidateVersion('1.11.0', bump, []), { code: 'rc-bump' });
  });
test('candidate version: unstable source and unavailable tag inventory cannot become an empty cohort', () => {
  assert.throws(() => rc().candidateVersion('2.0.0-rc.1', 'major', []));
  for (const refs of [null, {}, [null], ['refs/tags/v2.0.0-rc.1\n'], Array(4097).fill('refs/tags/v1.11.0')])
    assert.throws(() => rc().candidateVersion('1.11.0', 'major', refs), { code: 'rc-tags' });
});
test('candidate version: selection preserves the raw native tag array', () => {
  const refs = Object.freeze(['refs/tags/v2.0.0-rc.2']);
  assert.equal(select('1.11.0', 'major', refs), '2.0.0-rc.3');
  assert.deepEqual(refs, ['refs/tags/v2.0.0-rc.2']);
});
