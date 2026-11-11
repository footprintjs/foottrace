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
 * THE RULE. It speaks in COMMITS, because a fold applies commits.
 *   - A commit REPLACES the value of a key when one of its rows is a `set` or a `delete` on the key
 *     or on a container around it ({@link replacesValue}). After such a commit nothing written
 *     before it is part of the value.
 *   - Any other write of the key is PARTIAL: it was folded onto the value the key held. That value
 *     is the one left by the last write of the key BEFORE THIS COMMIT in the log, whichever step
 *     made it ({@link builtOnBefore}).
 *   - So the value a reader saw is made of a chain of commits: the write it saw, the write that one
 *     was folded onto, and so on back to the last write that replaced the value, or to the start
 *     of the log (then it also rests on what the key held before the run).
 *
 * WHY COMMIT ORDER HERE, AND NOT THE READ WINDOW. `readWindow.ts` dates a READ where the step
 * looked at state, because a step that ran beside others did not read in commit order. A partial
 * write is not a read by the step. It is applied when the step commits, onto committed state as it
 * stands then: the engine and every replay fold the log in commit order. So what a partial write
 * was folded onto is exact, with no window and no "possible": the last write before its own commit.
 *
 * WHY THE RULE KNOWS NOTHING OF STEPS. One step can commit more than once (a subflow mount commits
 * and then commits its exit; a fork child commits again when the fan-out settles), and its later
 * commit is folded onto its earlier one like any other. A reader whose nodes are COMMITS (the cause
 * graph, the key timeline) wants exactly that link. A reader whose nodes are STEPS (the backward
 * walk) must not draw an edge from a step to itself, and passes through its own earlier commit to
 * what that one was folded onto: that is the reader's business (`backtrack.ts`), not the rule's.
 * The first version of this file passed through inside the rule. The cause graph then had no way
 * back to a step's earlier commit, though its forward walk reached readers from it (found by the
 * second reader of this change).
 *
 * WHEN IN DOUBT, PARTIAL. Calling a partial write a replacement leaves a real source out. Calling a
 * replacement partial names one writer too many. Only the first is an omission, so
 * {@link replacesValue} decides by verb and path alone and never asks the values: a `merge` that
 * happens to overwrite a single number is read as partial, and the walk then also names the step
 * that wrote the number before (a writer too many, stated here as a limit). WHICH commits wrote a
 * key at all is the writer rule's answer (`keyPaths.ts`), and that one does ask values for a row
 * AROUND the key: a `set` of a container that left the key as it was is not a write of the key.
 *
 * Every reader that follows a value to its writers asks here: the backward walk (`backtrack.ts`),
 * the forward index and the key timeline (`slice/`), and the cause graph (`cause/`).
 *
 * NOT COVERED:
 *   - a `set` row the WRITER made out of writes that only added. Under EITHER encoding, a step's
 *     rows that would not fold back to what the step read are written as `set` rows of that
 *     read-back (`TransactionBuffer · emitReadBack`); ordinary writes reach it under the default
 *     `'full'` encoding, for example a step that merges into `a.x`, deletes `a.x` and merges into
 *     `a`. Under `'delta'`, any step that merged into a key and also wrote a path inside it is
 *     written as a `set` of the whole value (the two rows share storage in the bundle). Such a row
 *     holds what the key held when the step began plus the step's own part, and nothing in it says
 *     so. It is read here as what its verb says, a replacement, and the walk stops at it. A reader
 *     cannot follow what the record does not say: the writer has to mark such a row. Pinned as
 *     KNOWN LIMIT in `test/lib/memory/property/built-on.property.test.ts`, under both encodings;
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

/** What the rule reads of a commit: its rows. */
type Written = Pick<CommitBundle, 'trace'>;

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
export function replacesValue(bundle: Written, key: string): boolean {
  for (const row of bundle.trace) {
    if (row.verb !== 'set' && row.verb !== 'delete') continue;
    const sits = relation(row.path, key);
    if (sits === 'exact' || sits === 'around') return true;
  }
  return false;
}

/**
 * What the write of `key` committed at ARRAY position `at` was folded onto:
 *   - `undefined`: nothing. The commit replaced the value.
 *   - a position: the commit that left the value this write was folded onto, the last write of the
 *     key before it. It may be an earlier commit of the same step.
 *   - `-1`: no commit before it wrote the key. The write was folded onto what the key held before the
 *     run (or onto nothing), which the log cannot see.
 *
 * Costs one look at the commit's rows and one writer lookup.
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
  if (replacesValue(bundleAt(at), key)) return undefined;
  return lastWriterBefore(key, at);
}

/**
 * The inverse of {@link builtOnBefore}, for a reader that walks forward: the commit whose write of
 * `key` was folded DIRECTLY onto the write committed at `at`. That is the next write of the key,
 * unless it replaced the value. `undefined`: there is none.
 *
 * @param writes  The ARRAY positions of every commit that wrote `key`, ascending.
 */
export function builtDirectlyOn(
  key: string,
  at: number,
  writes: readonly number[],
  bundleAt: (position: number) => Written,
): number | undefined {
  // The first write after `at` (the list is ascending): a long history before it is not walked.
  let next = 0;
  for (let high = writes.length; next < high; ) {
    const middle = (next + high) >> 1;
    if (writes[middle] <= at) next = middle + 1;
    else high = middle;
  }
  if (next === writes.length || replacesValue(bundleAt(writes[next]), key)) return undefined;
  return writes[next];
}
