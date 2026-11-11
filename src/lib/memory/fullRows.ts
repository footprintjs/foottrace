/**
 * fullRows.ts — the 'full' layout of a commit's rows (`commitValues: 'full'`, the default), and the one
 * replay both encoders take a path's value from.
 *
 * Out of `TransactionBuffer` (see `staged.ts` for why): the buffer stages, this file lays the staged
 * ops out as rows. It reads the {@link Staged} view and writes only the rows it returns.
 */

import type { Lossy, Rows } from './admission.js';
import { nativeGet as _get, nativeSet as _set } from './pathOps.js';
import { emitReadBack } from './readBack.js';
import { type Staged, type StagedOp, changedSinceBase, provenance } from './staged.js';
import type { TraceEntry } from './types.js';
import { DELIM, dryFold } from './utils.js';

/**
 * Rebuild overwrite / updates / trace keeping ONLY paths whose final value
 * differs from the base value — i.e. the stage's net change. See
 * `TransactionBuffer · commit` for the rationale.
 *
 * Paths are compared at the exact granularity they were written (each trace
 * entry's path), against the working copy (final) vs the diff base (start).
 * Surviving `set` paths copy their final value from `overwritePatch`;
 * surviving `merge` paths copy their accumulated delta from `updatePatch`,
 * keeping the set-vs-merge verb — and the result is ADMITTED
 * (`TransactionBuffer · admit`): a family in `lossy`, whose replay does not
 * give back what the stage read, is written as its read-back instead, at its
 * last touch ({@link emitReadBack}, 9.30.0).
 *
 * This is the DEFAULT (`commitValues: 'full'`) payload, including the
 * historical flattening of staged `delete` ops into `set`-of-`undefined`
 * trace entries. The delta encoding lives in `deltaRows.ts`.
 *
 * Work, not bytes (9.22.1): the net-change verdict is paid once per PATH
 * and the clone once per CONSECUTIVE run of ops on a path, not once per op
 * — see the two memos inside. Pinned by
 * test/lib/memory/scenario/repeated-path-byte-identity.test.ts against the
 * 9.22.0 bytes. Since 9.23.0 that clone is THE clone: the patch trees hold
 * the caller's references (see the buffer's header), so this loop is the one
 * place the record is detached from them.
 */
export function changeOnlyRows(staged: Staged, lossy: Lossy | undefined): Rows {
  const rows: Rows = { overwrite: {}, updates: {}, trace: [] };
  const { overwrite, updates, trace } = rows;
  // Per PATH, decided once (9.22.1): base and final value are fixed at
  // commit, so every later op on a path gets the verdict its first op got.
  // `undefined` = not yet decided; the surviving paths are the `true` keys.
  const survives = new Map<string, boolean>();
  // The path the LAST surviving op copied into each patch tree (9.22.1).
  // The value at a path is fixed at commit, so an op whose predecessor on
  // the SAME tree already copied that path would write the same bytes over
  // the same key — it keeps its trace row (the log is byte-identical) and
  // pays no second clone. The 9.22.0 element-write funnel stages N
  // whole-array sets on ONE path; this is what makes that commit O(N)
  // instead of O(N × ops). CONSECUTIVE only — an op on another path in
  // between may have coerced or grown this one's container (a descendant
  // `nativeSet` through a primitive, a `key: undefined` shell) and the
  // re-copy is what repairs it; a `merge` between two sets touches the
  // other tree and does not count. Same law as `supersededByNextSet`.
  let lastSetPath: string | undefined;
  let lastMergePath: string | undefined;

  for (let i = 0; i < staged.ops.length; i++) {
    const op = staged.ops[i];
    const family = lossy?.families.get(lossy.rootOf.get(op.path) as string);
    if (family !== undefined) {
      if (i === family.slot) {
        emitReadBack(staged, family, rows, 'full');
        lastSetPath = lastMergePath = undefined;
      }
      continue;
    }
    let keep = survives.get(op.path);
    if (keep === undefined) {
      keep = changedSinceBase(staged, op.path.split(DELIM));
      survives.set(op.path, keep);
    }
    if (!keep) continue; // no-op or write-then-revert → no net change

    trace.push(flattenedTraceRow(op));
    if (op.verb === 'merge') {
      if (lastMergePath === op.path) continue;
      lastMergePath = op.path;
      const segments = op.path.split(DELIM);
      _set(updates, segments, structuredClone(_get(staged.updatePatch, segments)));
    } else {
      if (lastSetPath === op.path) continue;
      lastSetPath = op.path;
      const segments = op.path.split(DELIM);
      _set(overwrite, segments, structuredClone(_get(staged.overwritePatch, segments)));
    }
  }
  return rows;
}

/**
 * The value the stage's 'full' rows give a path — what the delta encoder
 * commits for a family member or a path with a `set` — read from ONE
 * {@link dryFold} of those rows over the patch trees themselves, taken the
 * first time it is asked. By reference, as the stage held them: an element
 * a `set` and a `merge` of one path share stays one element. A stage that
 * staged no `merge` and no nested op needs no fold — a path's value is its
 * last staged value. (Before 9.30.0: two replicas of the verb law,
 * `replayPathVerbs` and `replayFamilyVerbs`.)
 */
export function fullRowsValue(staged: Staged): (segments: string[]) => unknown {
  if (!staged.needsFold) return (segments) => _get(staged.overwritePatch, segments);
  let fold: unknown;
  return (segments) => {
    fold ??= dryFold(staged.base, staged.updatePatch, staged.overwritePatch, fullRows(staged));
    return _get(fold, segments);
  };
}

/** The stage's 'full' rows: every op on a path the net-change filter keeps, a `delete` spelled `set`. */
function fullRows(staged: Staged): TraceEntry[] {
  const keep = new Map<string, boolean>();
  const rows: TraceEntry[] = [];
  for (const op of staged.ops) {
    let k = keep.get(op.path);
    if (k === undefined) keep.set(op.path, (k = changedSinceBase(staged, op.path.split(DELIM))));
    if (k) rows.push({ path: op.path, verb: op.verb === 'merge' ? 'merge' : 'set' });
  }
  return rows;
}

/**
 * Historical flattening for the `'full'` payload: an explicit delete commits
 * as set-of-undefined. Per-write provenance (#P1) rides each surviving entry
 * untouched.
 */
function flattenedTraceRow(op: StagedOp): TraceEntry {
  return op.verb === 'delete'
    ? { path: op.path, verb: 'set' as const, ...provenance(op.readKeys, op.readAttempts, op.readAttemptsOmitted) }
    : op;
}
