/**
 * deltaRows.ts — the 'delta' layout of a commit's rows (`commitValues: 'delta'`, #13c-B;
 * docs/design/13c-b-delta-commit-verb.md): which verb each surviving path gets.
 *
 * Out of `TransactionBuffer` (see `staged.ts` for why). It reads the {@link Staged} view and writes
 * only the rows it returns. The pure helpers it leans on stay in `deltaEncoding.ts` (the overlap
 * families, the emission order, the row that carries a value). The VALUES it encodes come from the
 * one replay (`fullRows.ts · fullRowsValue`), never from a second copy of the verb law.
 */

import type { Lossy, Rows } from './admission.js';
import { type Survivor, emitInFamilyOrder, groupIntoFamilies, pushValueRow } from './deltaEncoding.js';
import { viewMark } from './hardWriteCoverage.js';
import { nativeGet as _get, nativeSet as _set } from './pathOps.js';
import { emitReadBack } from './readBack.js';
import { type OpVerb, type Staged, type StagedOp, changedSinceBase, markedBelow, provenance } from './staged.js';
import { DELIM } from './utils.js';

/** A path's ops, folded into what the delta encoder needs: its verbs in order, its last touch, its last op's provenance. */
type PathOps = {
  verbs: OpVerb[];
  readKeys?: string[];
  readAttempts?: readonly string[];
  readAttemptsOmitted?: number;
  last: number;
};

/**
 * Delta-encoded payload (`commitValues: 'delta'`, #13c-B) — same net-change
 * filter as the 'full' layout (`fullRows.ts · changeOnlyRows`), three encoding
 * differences:
 *
 * 1. **One trace entry per surviving path** (the §2.5 dedup rule — `append`
 *    is NOT idempotent on replay, so duplicate entries would multiply
 *    tails). The verb is resolved from the path's op mix + base→final
 *    relationship; entries are ordered by each path's LAST touch,
 *    preserving last-writer-wins for nested/overlapping paths.
 * 2. **Verb resolution per path** — for a path with NO surviving relative
 *    (see 3):
 *    - last op `'delete'` AND final value gone → `delete` (the path stays
 *      enumerated in `overwrite` with `undefined` for key-set consumers).
 *      Requires the parent to be a real container in the base — replay uses
 *      `nativeDelete`, which is inert on a primitive/absent parent, whereas
 *      the `'full'` flattening (`_set` of `undefined`) COERCES that parent
 *      into an object; when they would disagree we keep the flattening;
 *    - ONLY `'merge'` ops → `merge` with the accumulated `updatePatch`
 *      delta;
 *    - otherwise (`set`/mixed): the value the stage's 'full' rows give the
 *      path (`fullValueAt`). If base and that value are arrays and
 *      base is a STRICT PREFIX → `append` storing only the tail; else `set`
 *      storing the full value.
 * 3. **OVERLAP FAMILIES take the full-value fallback.** `overwrite` /
 *    `updates` are nested path TREES, so two surviving paths where one is
 *    an ancestor of the other (`a` and `a.p`) share storage. Delta's
 *    per-path encodings would clobber each other there (an `append`
 *    ancestor stores only a TAIL, a `delete` ancestor `undefined`), so every
 *    path that has a surviving ancestor/descendant is committed as a plain
 *    `set` of the value the 'full' rows give it, and the family's
 *    shallowest path (whose set covers the whole subtree) is emitted LAST.
 *
 * The result is ADMITTED (`TransactionBuffer · admit`) like the 'full' payload:
 * a compact row is kept only where the bundle provably folds back, and a
 * family in `lossy`, which does not, is written as what the stage read, at its
 * last touch ({@link emitReadBack}). So both encodings commit the value the
 * stage read; before 9.30.0 they shared a replay that did not
 * (`replayPathVerbs` / `replayFamilyVerbs`, deleted).
 */
export function deltaRows(
  staged: Staged,
  lossy: Lossy | undefined,
  fullValueAt: (segments: string[]) => unknown,
): Rows {
  const rows: Rows = { overwrite: {}, updates: {}, trace: [] };
  const { overwrite, updates, trace } = rows;
  const inLossy = (path: string) => lossy?.families.has(lossy.rootOf.get(path) as string) === true;
  const survivors = netChangeSurvivors(staged, opsByPath(staged.ops)).filter((s) => !inLossy(s.path));
  const { rootOf, byRoot } = groupIntoFamilies(survivors, new Set(survivors.map((s) => s.path)));

  // THE VERB CHOICE — the delta encoder picks a verb per path; the VALUES
  // it encodes come from the one replay (`fullValueAt`), never a replica of
  // the verb law (9.30.0: CLAUDE.md's verb-switch replicas lost two here).
  const emit = (s: Survivor): void => {
    const { path, segments, verbs, before } = s;
    const prov = provenance(s.readKeys, s.readAttempts, s.readAttemptsOmitted);
    if ((byRoot.get(rootOf.get(path) as string) as Survivor[]).length > 1) {
      // Rule 3 — one coherent tree: every member a set of its value. A member no hard write owns
      // still holds what was there, and its row says so (`TraceEntry.builtOnView`).
      trace.push({ path, verb: 'set', ...prov, ...viewMark(staged.hardWriteKeys, segments) });
      _set(overwrite, segments, structuredClone(fullValueAt(segments)));
      return;
    }
    const lastVerb = verbs[verbs.length - 1];
    if (lastVerb === 'delete' && s.after === undefined && deleteReplaysAsFlattening(staged.base, segments)) {
      // Real deletion — replay removes the key. Keep the path enumerated
      // in `overwrite` (undefined) so Object.keys consumers see it.
      trace.push({ path, verb: 'delete', ...prov });
      _set(overwrite, segments, undefined);
    } else if (verbs.every((v) => v === 'merge')) {
      trace.push({ path, verb: 'merge', ...prov });
      _set(updates, segments, structuredClone(_get(staged.updatePatch, segments)));
    } else {
      pushValueRow(rows, path, segments, before, fullValueAt(segments), prov, markedBelow(staged.redactedPaths, path));
    }
  };

  // A family that did not fold back takes its place by its last touch.
  const pending = lossy === undefined ? [] : [...lossy.families.values()].sort((a, b) => a.slot - b.slot);
  let next = 0;
  const flushBefore = (touch: number): void => {
    while (next < pending.length && pending[next].slot < touch) emitReadBack(staged, pending[next++], rows, 'delta');
  };
  emitInFamilyOrder(survivors, rootOf, byRoot, emit, flushBefore);
  flushBefore(Infinity);
  return rows;
}

/**
 * Path → its op-verb sequence, ordered by LAST touch (delete + re-insert
 * moves a re-touched path to the end of the Map's insertion order —
 * preserving last-writer-wins for nested/overlapping paths). Per-write
 * provenance (#P1): the LAST op's readKeys is kept — read prefixes only grow
 * within a stage, so last == union across the path. Delivered-answer windows instead
 * retain only the last window/count pair; eviction never changes that state-read law.
 */
function opsByPath(ops: readonly StagedOp[]): Map<string, PathOps> {
  const byPath = new Map<string, PathOps>();
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const prev = byPath.get(op.path);
    if (prev) {
      prev.verbs.push(op.verb);
      prev.last = i;
      if (op.readKeys !== undefined) prev.readKeys = op.readKeys;
      // Latest pair replaces the prior window; never union evicted witnesses back in.
      prev.readAttempts = op.readAttempts;
      prev.readAttemptsOmitted = op.readAttemptsOmitted;
      byPath.delete(op.path);
      byPath.set(op.path, prev);
    } else {
      byPath.set(op.path, {
        verbs: [op.verb],
        last: i,
        ...provenance(op.readKeys, op.readAttempts, op.readAttemptsOmitted),
      });
    }
  }
  return byPath;
}

/** The net-change filter — identical to 'full' (`staged.ts · changedSinceBase`). Survivors keep last-touch order. */
function netChangeSurvivors(staged: Staged, byPath: Map<string, PathOps>): Survivor[] {
  const survivors: Survivor[] = [];
  for (const [path, { verbs, readKeys, readAttempts, readAttemptsOmitted, last }] of byPath) {
    const segments = path.split(DELIM);
    if (!changedSinceBase(staged, segments)) continue; // no-op or write-then-revert → no net change
    const before = _get(staged.base, segments);
    const after = _get(staged.final, segments);
    survivors.push({ path, segments, verbs, readKeys, readAttempts, readAttemptsOmitted, last, before, after });
  }
  return survivors;
}

/**
 * May a staged `delete` at this path commit as the `'delete'` verb?
 *
 * Only when removing the key and the `'full'` mode's flattening (`_set` of
 * `undefined`) land in the same place. They diverge when the parent is not
 * a container: `nativeDelete` walks away untouched, while `nativeSet`
 * COERCES the primitive parent into an object to hold the key. Committing
 * `delete` there would silently drop a state change the stage really made,
 * so those (pathological) deletes keep the historical flattening.
 */
function deleteReplaysAsFlattening(base: unknown, segments: string[]): boolean {
  if (segments.length === 1) return true; // parent is the state root — always a container
  const parent = _get(base, segments.slice(0, -1));
  return parent !== null && typeof parent === 'object';
}
