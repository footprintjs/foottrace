/**
 * attemptId — the address of one attempt under a stage execution.
 *
 * Format:
 *   <runtimeStageId>@<n>              attempt n of the stage execution      'charge#4@2'
 *   <runtimeStageId>@<n>.<k>@<m>      attempt m of the k-th call made        'charge#4@2.1@3'
 *                                     during stage attempt n
 *
 * Every number after the runtimeStageId is a positive integer, counted from 1: attempt 1 is the first
 * try, call 1 the first call the stage attempt made. Written without leading zeros, so one attempt has
 * one spelling and an id is a safe join key.
 *
 * PARSED FROM THE RIGHT. A runtimeStageId always ends in `#<execution index>`, and the suffix grammar
 * holds no `#`, so the LAST `#` of an attempt id is its execution delimiter whatever the stage id
 * contains — `@`, `.` and `~` stay legal in stage ids, and no byte is newly reserved (the id doors'
 * refusal, FootPrint's `refuseReservedId`, is untouched). The delimiter is read from the grammar's one
 * owner, `runtimeStageId.ts`.
 *
 * Imports nothing but the runtime-ID grammar: a leaf of the record, checked by the package fence.
 *
 * @example
 * ```typescript
 * buildAttemptId('charge#4', 2);                              // 'charge#4@2'
 * buildAttemptId('charge#4', 2, { ordinal: 1, attempt: 3 });  // 'charge#4@2.1@3'
 * parseAttemptId('sf/v1.2@x#7@3'); // { runtimeStageId: 'sf/v1.2@x#7', attempt: 3 }
 * parseAttemptId('charge#4');      // undefined — a stage execution, not an attempt
 * ```
 */

import { EXECUTION_DELIMITER, type RuntimeStageId } from './runtimeStageId.js';

declare const ATTEMPT_ID: unique symbol;

/** A `<runtimeStageId>@<n>[.<k>@<m>]` string the grammar produced. Assignable to `string`. */
export type AttemptId = string & { readonly [ATTEMPT_ID]: true };

/**
 * What follows the last `#`: the execution index, `@` and the attempt, then — for a call — `.`, the
 * call's ordinal, `@` and the call's attempt. Counts are canonical positive integers.
 */
const AFTER_EXECUTION_DELIMITER = /^(\d+)@([1-9]\d*)(?:\.([1-9]\d*)@([1-9]\d*))?$/;
const EXECUTION_INDEX = /^\d+$/;

/** True when `id` ends in `#<digits>` — the one shape every runtimeStageId has. */
function endsInExecutionIndex(id: string): boolean {
  const at = id.lastIndexOf(EXECUTION_DELIMITER);
  return at !== -1 && EXECUTION_INDEX.test(id.slice(at + 1));
}

/** Refuse a count the parser could not give back: a positive safe integer, or a `RangeError`. */
function requireCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`buildAttemptId: ${name} must be a positive integer (counted from 1), got ${String(value)}`);
  }
}

/**
 * Build the id of one attempt.
 *
 * @param runtimeStageId The stage execution the attempt belongs to (`[subflowPath/]stageId#index`).
 * @param attempt The stage attempt, from 1.
 * @param call For an attempt of a call made inside the stage attempt: the call's `ordinal` (1 for the
 *   first call that stage attempt made) and its own `attempt` (from 1).
 * @throws TypeError when `runtimeStageId` does not end in `#<execution index>`, and RangeError when a
 *   count is not a positive integer — what `parseAttemptId` could not give back is never written.
 */
export function buildAttemptId(
  runtimeStageId: string,
  attempt: number,
  call?: { readonly ordinal: number; readonly attempt: number },
): AttemptId {
  if (typeof runtimeStageId !== 'string' || !endsInExecutionIndex(runtimeStageId)) {
    throw new TypeError(
      `buildAttemptId: ${JSON.stringify(runtimeStageId)} is not a runtimeStageId (it must end in #<execution index>)`,
    );
  }
  requireCount('attempt', attempt);
  if (call === undefined) return `${runtimeStageId}@${attempt}` as AttemptId;
  requireCount('call ordinal', call.ordinal);
  requireCount('call attempt', call.attempt);
  return `${runtimeStageId}@${attempt}.${call.ordinal}@${call.attempt}` as AttemptId;
}

/**
 * Parse an attempt id into its parts, or `undefined` when `id` is not one (a bare runtimeStageId, a
 * count of 0, a leading zero, a missing part). Never throws.
 *
 * `parseAttemptId(buildAttemptId(...parts))` gives the parts back, whatever the stage id contains.
 */
export function parseAttemptId(id: string):
  | {
      runtimeStageId: RuntimeStageId;
      attempt: number;
      call?: { ordinal: number; attempt: number };
    }
  | undefined {
  if (typeof id !== 'string') return undefined;
  const at = id.lastIndexOf(EXECUTION_DELIMITER);
  if (at === -1) return undefined;
  const parts = AFTER_EXECUTION_DELIMITER.exec(id.slice(at + 1));
  if (!parts) return undefined;
  const [, index, attempt, ordinal, callAttempt] = parts;
  const counts = [attempt, ordinal, callAttempt].filter((n): n is string => n !== undefined).map(Number);
  if (!counts.every(Number.isSafeInteger)) return undefined;
  const runtimeStageId = id.slice(0, at + 1 + index.length) as RuntimeStageId;
  if (ordinal === undefined) return { runtimeStageId, attempt: counts[0] };
  return { runtimeStageId, attempt: counts[0], call: { ordinal: counts[1], attempt: counts[2] } };
}
