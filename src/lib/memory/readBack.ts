/**
 * readBack.ts — a family of rows that did not fold back, written as what the stage read.
 *
 * THE ADMITTED RECORD (9.30.0, docs/design/2026-10-admitted-record.md): a commit is admitted only if
 * its bundle folds back to what its stage read. `admission.ts · lossyFamilies` names the families that
 * do not; each encoder (`fullRows.ts`, `deltaRows.ts`) then calls {@link emitReadBack} at the family's
 * last touch, in place of the rows it would have laid out for it.
 *
 * WHY ITS OWN FILE: both encoders write the same read-back, and the rows it writes are the ones the
 * record's writer builds itself (`set` rows no stage asked for by that verb). One place decides what
 * such a row carries (`TraceEntry.builtOnView`, `hardWriteCoverage.ts · viewMark`).
 */

import type { Family, Member, Rows } from './admission.js';
import { pushValueRow } from './deltaEncoding.js';
import { viewMark } from './hardWriteCoverage.js';
import { nativeGet as _get, nativeSet as _set } from './pathOps.js';
import { type Staged, changedSinceBase, markedBelow, provenance } from './staged.js';
import type { CommitValuesMode } from './types.js';
import { DELIM } from './utils.js';

/**
 * A family whose rows did not fold back, written as what the stage read:
 * one `set` row per member that changed (descendants by last touch, each
 * with its own read prefix), the ROOT last, and the root's read-back value
 * in `overwrite` — one coherent tree, so no row can clobber another. The
 * root's row is written even when the root itself did not change: it is the
 * row that carries the family's read-back (and the containers L-1's dropped
 * op left). A lone root under `'delta'` keeps the compact `append` when the
 * value it read is its base plus a tail.
 */
export function emitReadBack(staged: Staged, family: Family, rows: Rows, encoding: CommitValuesMode): void {
  let root: Member = family.members[0];
  let changed = 0;
  for (const m of family.members) {
    if (m.path === family.root) {
      root = m;
      continue;
    }
    const segments = m.path.split(DELIM);
    if (!changedSinceBase(staged, segments)) continue;
    rows.trace.push({
      path: m.path,
      verb: 'set',
      ...provenance(m.readKeys, m.readAttempts, m.readAttemptsOmitted),
      ...viewMark(staged.hardWriteKeys, segments),
    });
    changed++;
  }
  const after = _get(staged.final, family.rootSegments);
  if (encoding === 'delta' && changed === 0 && after !== undefined) {
    const before = _get(staged.base, family.rootSegments);
    pushValueRow(
      rows,
      family.root,
      family.rootSegments,
      before,
      after,
      provenance(root.readKeys, root.readAttempts, root.readAttemptsOmitted),
      markedBelow(staged.redactedPaths, family.root),
      viewMark(staged.hardWriteKeys, family.rootSegments),
    );
    return;
  }
  rows.trace.push({
    path: family.root,
    verb: 'set',
    ...provenance(root.readKeys, root.readAttempts, root.readAttemptsOmitted),
    ...viewMark(staged.hardWriteKeys, family.rootSegments),
  });
  // The clone the check took (`admission.ts · foldsBack`), when it took one.
  _set(rows.overwrite, family.rootSegments, family.held !== undefined ? family.held.value : structuredClone(after));
}
