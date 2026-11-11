/**
 * staged.ts — what a stage staged, as its commit reads it.
 *
 * WHY THIS FILE EXISTS. `TransactionBuffer` did two jobs in one class of 1,100 lines. It STAGES a
 * stage's writes (two patch trees, a working copy, the copy-on-write reads), and at commit it ENCODES
 * them into rows (the 'full' layout, the 'delta' layout, the read-back of a family that does not fold
 * back). The encoders only read what was staged. They now live in files of their own (`fullRows.ts`,
 * `deltaRows.ts`, `readBack.ts`) and are handed the view below, so the buffer's state stays private
 * to the buffer and each encoder takes one argument that says what it reads.
 *
 * This file holds what that group shares: the buffer's op, the view, and the three questions every
 * encoder asks of it the same way (did a path change, what provenance does a row carry, which
 * redaction marks matter for a row).
 *
 * A RULE, NOT A LOCK. The view's own fields are marked read-only. What they point at is not frozen:
 * the patch trees, the base, the working copy and the ops are the buffer's live objects. That an
 * encoder writes to none of them is a rule each one keeps, which a reviewer checks, and which the
 * types do not enforce. One thing is handed on by design: the 'full' layout puts a staged op object
 * itself into the trace it returns, as the buffer always did.
 */

import type { StagedOp } from './admission.js';
import type { OpVerb } from './deltaEncoding.js';
import { nativeGet as _get } from './pathOps.js';
import type { MemoryPatch, TraceEntry } from './types.js';
import { deepEqual, DELIM } from './utils.js';

/**
 * One op as the buffer staged it: the op the admission reads (`admission.ts · StagedOp`), with the
 * verbs the buffer really stages (`deltaEncoding.ts · OpVerb`). WHY a name of its own: the admission
 * takes any verb as text, and the layouts need to know it is one of the three.
 */
export type BufferOp = StagedOp & { verb: OpVerb };

/**
 * What a stage staged, fixed at commit: the view `TransactionBuffer · atCommit` hands the encoders.
 * Every field is the buffer's own object, by reference (nothing is copied to build the view).
 */
export interface Staged {
  /** The net-change diff base: state when the stage began. */
  readonly base: unknown;
  /** The working copy: state after every staged op, which is what the stage read back. */
  readonly final: unknown;
  /** The values of the stage's `set` and `delete` ops, by path. */
  readonly overwritePatch: MemoryPatch;
  /** The accumulated delta of the stage's `merge` ops, by path. */
  readonly updatePatch: MemoryPatch;
  /** Every op the stage staged, in order. */
  readonly ops: readonly BufferOp[];
  /** The paths a `set` or a `delete` of the stage owns (`hardWriteCoverage.ts`). */
  readonly hardWriteKeys: ReadonlySet<string>;
  /** The paths marked secret, whole keys and fields alike. */
  readonly redactedPaths: ReadonlySet<string>;
  /**
   * Did the stage stage a `merge`, or an op deeper than one key below its address? Only then can a
   * path's value differ from its last staged value, so only then is a fold needed to know it.
   */
  readonly needsFold: boolean;
}

/**
 * Did the stage change the value at `segments`? Base and final value are
 * fixed at commit, so this is the ONE net-change verdict both payload
 * encodings apply (a no-op write and a write-then-revert both fail it).
 */
export function changedSinceBase(staged: Pick<Staged, 'base' | 'final'>, segments: string[]): boolean {
  return !deepEqual(_get(staged.base, segments), _get(staged.final, segments));
}

/** A row's `readKeys` fragment — absent unless the provenance dial recorded one (#P1). */
export function provenance(
  readKeys: string[] | undefined,
  readAttempts?: readonly string[],
  readAttemptsOmitted?: number,
): Pick<TraceEntry, 'readKeys' | 'readAttempts' | 'readAttemptsOmitted'> | undefined {
  if (readKeys === undefined && !readAttempts?.length) return undefined;
  return {
    ...(readKeys !== undefined && { readKeys }),
    ...(readAttempts?.length && { readAttempts }),
    ...(readAttemptsOmitted && { readAttemptsOmitted }),
  };
}

/**
 * Does a redaction mark address an array ELEMENT right below `path`
 * (`list.1.token`)? An `append` row re-bases the indices onto the tail, so
 * such a path takes the whole-value `set` (`deltaEncoding · pushValueRow`).
 * A mark by NAME below an array (`obj.y`) means the same thing on the tail
 * as on the whole value, so the compact row stays (byte-identical).
 */
export function markedBelow(redactedPaths: ReadonlySet<string>, path: string): boolean {
  const prefix = path + DELIM;
  for (const marked of redactedPaths) {
    if (!marked.startsWith(prefix)) continue;
    const next = marked.slice(prefix.length).split(DELIM)[0];
    if (/^(0|[1-9]\d*)$/.test(next)) return true;
  }
  return false;
}

/**
 * The redacted paths that survive the net-change filter: a path survives
 * when it IS a surviving op path (a whole-key redaction) or sits UNDER one
 * (a field inside a surviving write). A dropped op takes its fields with it.
 */
export function survivingRedactedPaths(redactedPaths: ReadonlySet<string>, survivingPaths: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const path of redactedPaths) {
    if (survivingPaths.has(path)) {
      out.add(path);
      continue;
    }
    for (const op of survivingPaths) {
      if (path.startsWith(op + DELIM)) {
        out.add(path);
        break;
      }
    }
  }
  return out;
}
