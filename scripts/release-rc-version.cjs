'use strict';
const { nextVersion, parseVersion } = require('./release-changes.cjs');
const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};
/** Pure candidate selection from a successful native tag inventory.
 * The caller still owns current source, admission, grants and every effect. */
function targetVersion(current, bump) {
  if (!['patch', 'minor', 'major'].includes(bump)) fail('rc-bump');
  return nextVersion(current, bump);
}
function candidateCore(version) {
  const match = typeof version === 'string' && /^(.+)-rc\.(0|[1-9]\d*)$/.exec(version);
  if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) >= Number.MAX_SAFE_INTEGER)
    fail('rc-version');
  parseVersion(match[1]);
  return match[1];
}
function candidateVersion(current, bump, refs) {
  const target = targetVersion(current, bump),
    prefix = 'refs/tags/v' + target + '-rc.';
  if (!Array.isArray(refs) || refs.length > 4096) fail('rc-tags');
  let maximum = -1;
  for (const ref of refs) {
    if (typeof ref !== 'string' || ref.length > 1024 || /[\s\x00-\x1f\x7f]/.test(ref)) fail('rc-tags');
    if (!ref.startsWith(prefix)) continue;
    const number = ref.slice(prefix.length);
    try {
      candidateCore(ref.slice('refs/tags/v'.length));
    } catch {
      fail('rc-tag-number');
    }
    const value = Number(number);
    if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER - 1) fail('rc-tag-number');
    maximum = Math.max(maximum, value);
  }
  return target + '-rc.' + (maximum + 1);
}
function distributionTag(version) {
  try {
    parseVersion(version);
    return 'latest';
  } catch {
    candidateCore(version);
    return 'next';
  }
}
module.exports = { candidateVersion, targetVersion, candidateCore, distributionTag };
