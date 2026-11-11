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
 * A `set` ROW THE WRITER MADE (`TraceEntry.builtOnView`). The writer sometimes writes a `set` of a
 * whole value in place of rows that only added: under either encoding when a step's rows would not
 * fold back to what the step read (one step that merges into `a.x`, deletes `a.x` and merges into
 * `a`), and under `'delta'` whenever a step merged into a key and also wrote a path inside it. In the
 * fold such a row does replace the value, so nothing a sibling committed in between is under it.
 * What IS in it is the value as the step's VIEW held it, with the step's own writes folded in. The
 * writer marks the row, and a reader takes the mark as a READ of the path, made for the step, at the
 * commit that carries the row ({@link readFromView}): its source is the read rule's
 * (`readWindow.ts`), asked with the moment that commit's view was pinned (`CommitBundle.viewAt`).
 * WHY A READ AND NOT A FOLD: a fold is dated at the commit; the view was pinned before it. A step
 * that ran beside others and then wrote such a row holds what was there when its view was pinned,
 * not what a sibling committed since. WHY A STAMP OF ITS OWN FOR THAT MOMENT, and not the step's
 * read stamps: `CommitBundle.viewAt` says it.
 * WHEN THE VIEW HELD NO WRITE OF THE KEY the row was built on the value from before the run, or on
 * nothing. A reader says that in the view's own words (`'pre-run-view'`: `CausalNode.preRunView`,
 * `KeyMoment.builtOnViewPreRun`, the cause graph's `untracked-input`) and never in the fold's
 * (`'from-initial-state'`). WHY: the fold's code says no write of the whole value is under the
 * value, so it may be partial. A marked `set` is a whole write of its path, and what the log
 * cannot see is only where part of it came from. One code for both made a timeline that held two
 * `set` rows of a key say it had "no write of its whole value in range", and left the cause
 * graph's node with no parent and no gap, the shape of a root (found in round 4 of this change's
 * second read, and by then asking every reader about the same row).
 * Until the writer marked these rows they were read as plain replacements and the walk stopped at
 * them (found by this rule's own property test, and under the default encoding by its second reader).
 *
 * Every reader that follows a value to its writers asks here: the backward walk (`backtrack.ts`),
 * the forward index and the key timeline (`slice/`), and the cause graph (`cause/`).
 *
 * NOT COVERED:
 *   - a `set` row a producer other than `RecordFrame` writes out of an earlier value plus a change,
 *     with no mark and no read of the key on record. It reads as a replacement, and no reader can
 *     tell (the record contract says what a producer owes here);
 *   - which FIELDS a merge reached. The walk follows every write back to the last one that replaced
 *     the value, so it can name a step whose field has since been overwritten;
 *   - an array that does not show where a view sits. `viewAt` is an index of the log the bundle
 *     was written to. In an array handed over with bundles that say no index (a slice, rows taken
 *     out) the place of that index can be a range (`windowPlacement.ts`). A write inside the range
 *     is then a possible source of the row, never the certain one and never left out;
 *   - the PROV export does not link a write to the write it was folded onto. It exports a `merge`
 *     or an `append` row as that write alone, and counts it under "final value reconstruction is
 *     outside stage one" (`prov/gaps.ts`).
 *
 * Where the idea comes from, and what is ours: `REFERENCES.md` in this folder.
 */

import type { RegisteredCode } from './honesty.js';
import { relation } from './keyPaths.js';
import type { LastWriterBefore } from './readWindow.js';
import type { CommitBundle, TraceEntry } from './types.js';

/**
 * Why a write is only a POSSIBLE source of a `set` row the writer built on its step's view: the array
 * the reader was handed does not show where that view sits (`windowPlacement.ts`: bundles around the
 * commit that say no index, several logs in one array, a `viewAt` that cannot be one). The row could
 * then have been built on any write in the range the view could be in, and each is named.
 *
 * WHY NOT THE READ'S WORDS (`readWindow.ts · ReadOverlap`). Those say a step was RUNNING while the key
 * was written: it began, another step committed, and it looked at state again. A view is one moment.
 * Nothing is written "while it ran", and in a log as its writer wrote it a view has one source, for
 * certain. What is missing here is only the reader's knowledge of that moment. Said in the read's
 * words, a walk back told a person that a step "looked at state again after another step committed"
 * where no step had read the key at all (found by asking every reader about one such row).
 */
export type ViewOverlap = RegisteredCode<'view-not-placed'>;

/** The mark of each write a view could have held: none when it has ONE source (`during` is empty). */
export function viewOverlapOf(sources: { readonly during: readonly number[] }): ViewOverlap | undefined {
  return sources.during.length > 0 ? 'view-not-placed' : undefined;
}

/** What the rule reads of a commit: its rows. */
type Written = Pick<CommitBundle, 'trace'>;

/**
 * Does this commit hold a `set` row the WRITER built on the step's view (`TraceEntry.builtOnView`) on
 * `key`, around it or inside it? Then part of what `key` holds after the commit is what the VIEW
 * held there: the commit read the key from its view, for its step, and a reader owes it the source
 * of that read (`readWindow.ts · readSourcesOf`, asked with THIS commit's view,
 * `windowPlacement.ts · Places.view`: a later commit of a step has a view of its own, pinned after
 * the earlier one).
 */
export function readFromView(bundle: Written, key: string): boolean {
  for (const row of bundle.trace) if (isViewRow(row) && relation(row.path, key) !== undefined) return true;
  return false;
}

/**
 * Is this a `set` row the WRITER built on the step's view? The mark counts on a `set` row only: on
 * any other verb it says nothing the fold does not already say (such a row adds to what is there),
 * and a door that takes records from outside refuses it there.
 */
export function isViewRow(row: Pick<TraceEntry, 'verb' | 'builtOnView'>): boolean {
  return row.builtOnView === true && row.verb === 'set';
}

/**
 * Does a bundle's `viewAt` have a row to date? The stamp dates the `set` rows the writer built on
 * the step's view and nothing else. On a bundle with no such row it says something no reader can
 * use, and no writer of ours puts it there, so a door that takes records from outside refuses that
 * bundle as it refuses any stamp that cannot be one (`readWindow.ts · admitStamps`).
 */
export function viewStampFits(
  placed: Pick<CommitBundle, 'viewAt'>,
  rows: readonly Pick<TraceEntry, 'verb' | 'builtOnView'>[],
): boolean {
  return placed.viewAt === undefined || rows.some(isViewRow);
}

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
