/**
 * builtOn.ts — THE rule for "is the last write of a key the whole story of its value?".
 *
 * WHY THIS FILE EXISTS. Every reader that follows a value to its writer stopped at the last commit
 * that wrote the key. That is right when the write REPLACED the value. It is wrong when the write
 * only added to it: a `merge` into an object, an `append` to a list, a row on a path inside the
 * key. What the key holds after such a write is made of that write AND of what was there, and a
 * step that reads it reads both. A walk back that names the last writer alone leaves out the step
 * that wrote the rest, with no warning (witness on the real engine: `Start` sets a box, `Fill`
 * merges a field into it without reading it, `Use` reads the box; the walk back from `Use` named
 * `Fill` and never `Start`).
 *
 * THE RULE.
 *   - A commit REPLACES the value of a key when one of its rows is a `set` or a `delete` on the key
 *     or on a container around it ({@link replacesValue}). After such a commit nothing written
 *     before it is part of the value.
 *   - Any other write of the key is PARTIAL: it was folded onto the value the key held. That value
 *     is the one left by the last write of the key BEFORE THIS COMMIT in the log, because the fold
 *     applies commits in log order ({@link builtOnBefore}).
 *   - So the value a reader saw is made of a chain: the write it saw, the write that one was built
 *     on, and so on back to the last write that replaced the value, or to the start of the log
 *     (then it also rests on what the key held before the run).
 *
 * WHY COMMIT ORDER HERE, AND NOT THE READ WINDOW. `readWindow.ts` dates a READ where the step
 * looked at state, because a step that ran beside others did not read in commit order. A partial
 * write is not a read by the step. It is applied when the step commits, onto committed state as it
 * stands then: the engine and every replay fold the log in commit order. So what a partial write
 * was built on is exact, with no window and no "possible": the last write before its own commit.
 *
 * WHEN IN DOUBT, PARTIAL. Calling a partial write a replacement leaves a real source out. Calling a
 * replacement partial names one writer too many. Only the first is an omission, so the test is by
 * verb and path alone and never asks the values: a `merge` that happens to overwrite a single
 * number is read as partial, and the walk then also names the step that wrote the number before
 * (a writer too many, stated here as a limit).
 *
 * Every reader that follows a value to its writers asks here: the backward walk (`backtrack.ts`),
 * the forward index and the key timeline (`slice/`), and the cause graph (`cause/`).
 *
 * NOT COVERED:
 *   - a `set` row the WRITER made out of writes that only added. Under `'delta'` a step that merged
 *     into a key and also wrote a path inside it is written as a `set` of the whole value (the two
 *     rows share storage in the bundle). Under either encoding, rows that would not fold back to
 *     what the step read are written as `set` rows of that read-back (`TransactionBuffer ·
 *     emitReadBack`). Such a row holds what the key held when the step began plus the step's own
 *     part, and nothing in it says so. It is read here as what its verb says, a replacement, and
 *     the walk stops at it. A reader cannot follow what the record does not say: the writer has to
 *     mark such a row. Pinned as KNOWN LIMIT in `test/lib/memory/property/built-on.property.test.ts`;
 *   - which FIELDS a merge reached. The walk follows every write back to the last one that replaced
 *     the value, so it can name a step whose field has since been overwritten;
 *   - the PROV export does not link a write to the write it was folded onto. It exports a `merge`
 *     or an `append` row as that write alone, and counts it under "final value reconstruction is
 *     outside stage one" (`prov/gaps.ts`).
 *
 * Where the idea comes from, and what is ours: `REFERENCES.md` in this folder.
 */

import { relation } from './keyPaths.js';
import type { LastWriterBefore } from './readWindow.js';
import type { CommitBundle } from './types.js';

/** What the rule reads of a commit: its rows, and which execution wrote it. */
type Written = Pick<CommitBundle, 'trace' | 'runtimeStageId'>;

/**
 * Did this commit REPLACE the value of `key`: a `set` or a `delete` row on the key, or on a container
 * around it? Then the value after the commit rests on this commit alone (rows after the replacing row
 * refine it, rows before it are overwritten).
 *
 * `false` for a commit that reached the key only by `merge`, `append`, a row on a path inside it, or
 * a verb this version does not know: such a write was folded onto what the key held.
 *
 * @param key  A DELIM-joined path (`normalisePath`); a top-level key is a one-segment path.
 */
export function replacesValue(bundle: Pick<CommitBundle, 'trace'>, key: string): boolean {
  for (const row of bundle.trace) {
    if (row.verb !== 'set' && row.verb !== 'delete') continue;
    const sits = relation(row.path, key);
    if (sits === 'exact' || sits === 'around') return true;
  }
  return false;
}

/**
 * What the write of `key` committed at ARRAY position `at` was built on:
 *   - `undefined`: nothing. The commit replaced the value.
 *   - a position: the commit that left the value this write was folded onto.
 *   - `-1`: no commit before it wrote the key. The write was folded onto what the key held before the
 *     run (or onto nothing), which the log cannot see.
 *
 * An earlier bundle of the SAME execution is not an answer (a subflow mount commits its merge-back
 * and then its exit; a fork child its own bundle and then its settle): the execution built on its
 * own earlier write, so the question passes through it to what that one was built on.
 *
 * Costs one writer lookup, plus one per earlier bundle of the same execution that wrote the key.
 *
 * @param bundleAt          The commit at an ARRAY position of the log asked.
 * @param lastWriterBefore  The last position before `before` whose commit wrote `key`, or -1.
 */
export function builtOnBefore(
  key: string,
  at: number,
  bundleAt: (position: number) => Written,
  lastWriterBefore: LastWriterBefore,
): number | undefined {
  const own = bundleAt(at).runtimeStageId;
  let from = at;
  for (;;) {
    if (replacesValue(bundleAt(from), key)) return undefined;
    const earlier = lastWriterBefore(key, from);
    if (earlier < 0 || bundleAt(earlier).runtimeStageId !== own) return earlier < 0 ? -1 : earlier;
    from = earlier;
  }
}

/**
 * The inverse of {@link builtOnBefore}, for a reader that walks forward: the commits whose write of
 * `key` was built DIRECTLY on the write committed at `at`. They are the bundles of the next step that
 * wrote the key, as long as none of them replaced the value. A later bundle of `at`'s own step is not
 * one (a step builds on its own earlier write; what follows then builds on that later bundle), and a
 * third step's write was built on the second's.
 *
 * @param writes  The ARRAY positions of every commit that wrote `key`, ascending.
 */
export function builtDirectlyOn(
  key: string,
  at: number,
  writes: readonly number[],
  bundleAt: (position: number) => Written,
): number[] {
  const own = bundleAt(at).runtimeStageId;
  const out: number[] = [];
  let next: string | undefined;
  // Start at the first write after `at` (the list is ascending): a long history before it is not walked.
  let from = 0;
  for (let high = writes.length; from < high; ) {
    const middle = (from + high) >> 1;
    if (writes[middle] <= at) from = middle + 1;
    else high = middle;
  }
  for (let i = from; i < writes.length; i++) {
    const position = writes[i];
    const bundle = bundleAt(position);
    if (bundle.runtimeStageId === own) break;
    if (next !== undefined && bundle.runtimeStageId !== next) break;
    if (replacesValue(bundle, key)) break;
    next = bundle.runtimeStageId;
    out.push(position);
  }
  return out;
}
