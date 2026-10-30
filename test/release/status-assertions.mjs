import { call, loadReleaseSpecimen, read } from './helpers.mjs';
import { existsSync } from 'node:fs';
import { root } from './helpers.mjs';
import { join } from 'node:path';

export const METADATA_HEADING = '## Value-free trace metadata — unreleased';
export const METADATA_PARAGRAPH = 'This is an unreleased additive entry point. The package version and existing\nrecord fixtures remain unchanged until a separately reviewed release.';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const requireStatus = (condition, code) => { if (!condition) fail(code); };
const count = (text, part) => text.split(part).length - 1;
const version = value => {
  try { return call('release-changes', 'parseVersion', value); }
  catch { fail('status-version'); }
};
const atMost = (a, b) => {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i]; }
  return true;
};
export function currentReleaseState() {
  const files = Object.fromEntries(['package.json', 'package-lock.json', 'CHANGELOG.md', 'README.md', 'docs/metadata.md'].map(name => [name, read(name)]));
  const fragments = {};
  if (existsSync(join(root, '.changes/metadata-query.md'))) fragments['metadata-query.md'] = read('.changes/metadata-query.md');
  return { files, fragments };
}
/** Checkout consistency only: this does not assert registry publication. */
export function assertRepositoryStatus({ files, fragments }) {
  let pkg, lock;
  try { pkg = JSON.parse(files['package.json']); lock = JSON.parse(files['package-lock.json']); }
  catch { fail('status-package'); }
  requireStatus(pkg.name === 'foottrace' && lock.name === pkg.name && lock.packages?.['']?.name === pkg.name && lock.version === pkg.version && lock.packages[''].version === pkg.version, 'status-package');
  const current = version(pkg.version), readme = files['README.md'], guide = files['docs/metadata.md'], history = files['CHANGELOG.md'];
  requireStatus([readme, guide, history].every(x => typeof x === 'string'), 'status-documents');
  const prov = readme.split('\n').filter(line => line.startsWith('## PROV-O export'));
  requireStatus(prov.length === 1 && prov[0] === '## PROV-O export (since 1.6.0)', 'status-prov');
  const headings = readme.split('\n').filter(line => line.startsWith('## Value-free trace metadata'));
  requireStatus(headings.length === 1, 'status-metadata-heading');
  const starts = guide.split('\n').filter(line => line.startsWith('This is an unreleased additive entry point') || line.startsWith('This additive entry point is included'));
  requireStatus(starts.length === 1, 'status-metadata-paragraph');
  const sections = [...history.matchAll(/^## ([^\n]+)$/gm)];
  const packageHistory = () => {
    const entries = sections.filter(row => /^\d+\./.test(row[1]));
    const matching = entries.filter(row => row[1].startsWith(pkg.version + ' '));
    requireStatus(matching.length === 1 && matching[0] === entries[0] && new RegExp('^' + pkg.version.replaceAll('.', '\\.') + ' — \\d{4}-\\d{2}-\\d{2}$').test(matching[0][1]), 'status-package-history');
  };
  // Expected note comes from captured input bytes, never from preparer output.
  const note = loadReleaseSpecimen().fragments['metadata-query.md'].split('\n---\n')[1].trim();
  if (Object.hasOwn(fragments, 'metadata-query.md')) {
    const fragment = call('release-changes', 'parseFragment', 'metadata-query.md', fragments['metadata-query.md']);
    requireStatus(fragment.type === 'added' && fragment.bump === 'minor' && fragment.body.includes('Optional `foottrace/metadata`'), 'status-pending-fragment');
    requireStatus(headings[0] === METADATA_HEADING, 'status-pending-heading');
    requireStatus(count(guide, METADATA_PARAGRAPH) === 1, 'status-pending-paragraph');
    requireStatus(count(history, note) === 0, 'status-pending-history');
    packageHistory();
    return { mode: 'pending', packageVersion: pkg.version };
  }
  const intro = /^## Value-free trace metadata \(since ([^)]+)\)$/.exec(headings[0]);
  requireStatus(!!intro, 'status-released-heading');
  const since = version(intro[1]);
  const released = /^This additive entry point is included from FootTrace (\S+)\. Existing complete-record APIs and saved records retain their prior contracts\.$/.exec(starts[0]);
  requireStatus(!!released && released[1] === intro[1], 'status-released-paragraph');
  requireStatus(atMost(since, current), 'status-future-introduction');
  const matching = sections.filter(row => row[1] === intro[1] || row[1].startsWith(intro[1] + ' '));
  requireStatus(matching.length === 1 && new RegExp('^' + intro[1].replaceAll('.', '\\.') + ' — \\d{4}-\\d{2}-\\d{2}$').test(matching[0][1]), 'status-history-section');
  const selected = matching[0], next = sections.find(row => row.index > selected.index);
  const body = history.slice(selected.index, next?.index ?? history.length);
  requireStatus(count(body, note) === 1, 'status-history-note');
  packageHistory();
  return { mode: 'released', packageVersion: pkg.version, metadataSince: intro[1] };
}
