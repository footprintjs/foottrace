'use strict';
const fs = require('node:fs');
const path = require('node:path');
const TYPES = Object.freeze({
  added: 'Added',
  changed: 'Changed',
  deprecated: 'Deprecated',
  removed: 'Removed',
  fixed: 'Fixed',
  security: 'Security',
  documentation: 'Documentation',
});
const BUMPS = Object.freeze({ patch: 0, minor: 1, major: 2 });
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const fail = (code) => {
  const e = new Error(code);
  e.code = code;
  throw e;
};
function parseFragment(name, text) {
  if (
    typeof name !== 'string' ||
    !/^[a-z0-9][a-z0-9-]*\.md$/.test(name) ||
    typeof text !== 'string' ||
    Buffer.byteLength(text) > 65536 ||
    text.includes('\r')
  )
    fail('invalid-fragment');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) fail('invalid-fragment');
  const fields = Object.create(null);
  for (const line of match[1].split('\n')) {
    const field = /^(type|bump): ([a-z]+)$/.exec(line);
    if (!field || own(fields, field[1])) fail('invalid-fragment');
    fields[field[1]] = field[2];
  }
  const body = match[2].trim();
  if (!own(TYPES, fields.type) || !own(BUMPS, fields.bump) || !body || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(body))
    fail('invalid-fragment');
  return { name, type: fields.type, bump: fields.bump, body };
}
function selectBump(fragments) {
  if (!Array.isArray(fragments)) fail('invalid-fragment');
  let result = null;
  for (const fragment of fragments) {
    if (!fragment || !own(BUMPS, fragment.bump) || !own(TYPES, fragment.type)) fail('invalid-fragment');
    if (result === null || BUMPS[fragment.bump] > BUMPS[result]) result = fragment.bump;
  }
  return result;
}
function parseVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    fail('invalid-version');
  const parts = version.split('.').map(Number);
  if (parts.some((n) => !Number.isSafeInteger(n) || n >= Number.MAX_SAFE_INTEGER)) fail('invalid-version');
  return parts;
}
function nextVersion(version, bump) {
  const p = parseVersion(version);
  if (!own(BUMPS, bump)) fail('invalid-version');
  const i = 2 - BUMPS[bump];
  p[i] += 1;
  for (let j = i + 1; j < 3; j++) p[j] = 0;
  return p.join('.');
}
function readFragments(directory) {
  return fs
    .readdirSync(directory)
    .filter((n) => n !== 'README.md')
    .sort()
    .map((name) => {
      const file = path.join(directory, name);
      if (!fs.lstatSync(file).isFile()) fail('invalid-fragment');
      return parseFragment(name, fs.readFileSync(file, 'utf8'));
    });
}
module.exports = { TYPES, parseFragment, selectBump, parseVersion, nextVersion, readFragments };
if (require.main === module) {
  readFragments(path.join(process.cwd(), '.changes'));
  console.log('Change fragments valid');
}
