/**
 * readWindow.ts — THE rule for "which commits could this step's read of a key have seen?".
 *
 * WHY THIS FILE EXISTS. A log is ordered by COMMIT, and a step commits when it ends. For steps that
 * run one after another that is also the order of their reads: a step reads between the commit
 * before it and its own, so the last write before its commit is what it read. For steps that run
 * side by side it is not. A branch that reads `x` early and commits late sits in the log after a
 * sibling that wrote `x` in between; dating its read at its own commit names the sibling as the
 * source and leaves out the step whose value was actually read.
 *
 * WHAT THE RECORD SAYS. A step reads state in two ways (`RecordFrame`): from the view it pins at its
 * first touch, which never changes under it, and, for a key that view cannot answer, from live state
 * as it stands at that moment. Each read is a LOOK at the log as it stood when the value it returned
 * was current: for a read from the view, when the view was pinned; for a read of live state, now.
 * (Pinning the view for a write is not a look: nothing was read.) The writer notes the log's length
 * at the step's earliest look and at its latest, and puts them on the step's first bundle when they
 * say more than "everything before my own commit":
 *   - `beganAt`: other steps committed between the step's earliest look and its own commit. The
 *     step's reads are dated at `beganAt`.
 *   - `sawUntil`: the step also looked later, after such a commit. Commits `beganAt` to
 *     `sawUntil - 1` are its WINDOW: the ones a later look may have read.
 *
 * THE RULE. A read of `key` by a step saw
 *   - the last write of `key` BEFORE the window: the value as it stood when the step began; or
 *   - a write of `key` INSIDE the window. The record keeps which keys a step read, not when it read
 *     each, so a look at live state after that write may have been the read of this key.
 * So the sources are that one earlier write plus every write in the window, and the real source is
 * always among them.
 *
 * HOW SURE. With no write of the key in the window there is one source and it is certain:
 *   - a step that ran alone: the last writer before its commit, as it always was;
 *   - a step that only read what it saw when it began: the last writer before `beganAt`, however
 *     many siblings committed before it did. This is the common case of steps side by side, and it
 *     is exact.
 * With a write of the key in the window every source is possible and none is certain
 * ({@link overlapOf}). A write that reached the key only through a path inside it counts as a write
 * here: it changed part of the value.
 *
 * Every reader that follows a read to its writer asks here: the backward walk (`backtrack.ts`), the
 * forward index and the key timeline (`slice/`), the cause graph (`cause/`) and the PROV export
 * (`prov/`). No reader dates a read on its own.
 *
 * NOT COVERED:
 *   - a log written before these fields existed carries no window anywhere; for it a read is dated
 *     at the step's first commit, as before;
 *   - a read made after a step's first commit (a second round of one frame) is dated with the first.
 *     The engine runs no user code there;
 *   - a value handed to user code outside the frame's read doors (a subflow mapper is given the
 *     parent's whole state) is not a tracked read, so no reader dates it at all.
 *
 * Where the idea comes from, and what is ours: `REFERENCES.md` in this folder.
 */

import type { RegisteredCode } from './honesty.js';
import type { CommitBundle } from './types.js';

/** The last ARRAY position before `before` whose commit wrote `key`, or -1. */
export type LastWriterBefore = (key: string, before: number) => number;

/**
 * When one step looked at state, in ARRAY positions of the log asked. The view the step began with
 * holds every commit before `start`. Commits `start` to `end - 1` are the window: a later look at
 * live state may have read them. `start === end`: no window, every read is dated at `start`.
 */
export interface ReadWindow {
  readonly start: number;
  readonly end: number;
}

/** What a step's read of one key could have seen. Positions are ARRAY positions in the log asked. */
export interface ReadSources {
  /** The last commit that wrote the key before the step began, or -1: the value in the step's first view. */
  readonly before: number;
  /** The commits that wrote the key inside the step's window, ascending. Empty: `before` is certain. */
  readonly during: readonly number[];
}

/**
 * Why a source of a read is only POSSIBLE: the key was written inside the reader's window, so the
 * record cannot say which value the read saw. Absent on a source that is certain.
 *   - `'replaced-while-running'`: this source is the value the key held when the reader began; the
 *     key was written again, in whole or in part, before the reader last looked at state.
 *   - `'written-while-running'`: this source was written inside the window; the read may have come
 *     before it.
 * Both are registered in `honesty.ts · HONESTY_CODES` with the sentence a screen shows.
 */
export type ReadOverlap = RegisteredCode<'replaced-while-running' | 'written-while-running'>;

const NONE: readonly number[] = Object.freeze([]);
/** A whole number from 0 up: what a commit index or a stamp can be. */
export const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;
/**
 * A commit index a reader can count with: a whole number from 0 to 2^52. A reader adds positions to
 * indices (`windowPlacement.ts`); up to here every such sum is exact for any array a program can
 * hold, so two bundles are never read at one place. A larger `idx` is treated as not said.
 */
export const isIndex = (value: unknown): value is number => isCount(value) && value <= 2 ** 52;

/**
 * What an admitted copy of a bundle keeps of its place in its log: the commit index it said, when a
 * reader can count with it, and its stamps. Nothing here is made up by the door.
 */
export type Placed = Pick<CommitBundle, 'idx' | 'beganAt' | 'sawUntil' | 'viewAt'>;

/**
 * Admit the place of a bundle that came from outside (a stored record, a record handed to a reader):
 * the three values as the caller read them off it, and `after`, the lowest index the copy before it
 * can have (-1 for the first; {@link placedAt} gives it for the next one). Returns what the copy
 * keeps, or `undefined` when the stamps cannot be stamps.
 *
 * WHY REFUSE, NOT IGNORE. A stamp that is dropped reads as "this step saw everything before its own
 * commit": the dating the stamp exists to correct, and a narrower claim than the record made. So a
 * value that cannot be a stamp fails the bundle at every door: `beganAt` must be a whole number
 * before the bundle's own index, `sawUntil` a whole number after `beganAt` and not past that index,
 * and never present without `beganAt`.
 *
 * WHY THE COPIES' INDICES ALWAYS RISE. The stamps are read against the `idx` of the bundles around
 * them (`windowPlacement.ts · windowsOf`), so one odd `idx` on a neighbour can move another step's
 * window and put a wrong writer forward as the certain one. A door therefore keeps a bundle's own
 * `idx` only when it is a whole number past the copy before it. On a bundle with no stamp any other
 * `idx` (missing, not a whole number, not past the one before) is left off the copy: such a bundle
 * only needs its place in the order. Beside a stamp the same `idx` refuses the bundle, because the
 * stamp then counts against nothing; a stamped bundle with no `idx` at all is admitted when its
 * stamps fit the lowest index it can have, as a log built by hand is.
 *
 * WHY THE DOOR WRITES NO INDEX OF ITS OWN. It used to give a copy that said none the next index. In a
 * record with rows taken out that number is a guess, and once written on the copy no reader could
 * tell it from a said one: the bundle looked older than it was and came back as the one certain
 * source (found by the second reader of this change). A copy that says no index is read by its
 * neighbours, as a range where they show a hole (`windowPlacement.ts`, step 2).
 *
 * WHAT THIS COSTS, AND IS ACCEPTED. The door cannot tell which of two bundles is the damaged one. A
 * bundle that says an index far too large is kept, and then every stamped bundle after it is the one
 * that does not rise: it is refused although it may be the sound one. A refusal says "not known";
 * a guess would put a writer forward as certain.
 *
 * `viewAt` (when the view behind a row the writer built on it was pinned, `CommitBundle.viewAt`) is
 * held to the same rule as `beganAt`, and for the same reason: a whole number before the bundle's own
 * index. Dropped, the row would be dated at its commit and a sibling's write would be named as what
 * it was built on. Whether the bundle holds such a row at all is the caller's to check: it has the
 * rows (`builtOn.ts · viewStampFits`).
 */
export function admitStamps(
  beganAt: unknown,
  sawUntil: unknown,
  idx: unknown,
  after: number,
  viewAt?: unknown,
): Placed | undefined {
  const own = isIndex(idx) && idx > after ? idx : undefined;
  const said: Placed = own === undefined ? {} : { idx: own };
  if (beganAt === undefined && viewAt === undefined) return sawUntil === undefined ? said : undefined;
  // What the stamps must fit: the bundle's own index, or the lowest it can have when it says none.
  const at = idx === undefined ? after + 1 : own;
  if (at === undefined) return undefined;
  if (viewAt !== undefined) {
    if (!isCount(viewAt) || viewAt >= at) return undefined;
    said.viewAt = viewAt;
  }
  if (beganAt === undefined) return sawUntil === undefined ? said : undefined;
  if (!isCount(beganAt) || beganAt >= at) return undefined;
  if (sawUntil === undefined) return { ...said, beganAt };
  return isCount(sawUntil) && sawUntil > beganAt && sawUntil <= at ? { ...said, beganAt, sawUntil } : undefined;
}

/** The `after` of the next bundle: the lowest index this copy can have, its own or one past the copy before it. */
export const placedAt = (placed: Placed, after: number): number => placed.idx ?? after + 1;

/**
 * The rule, backward (see the file header): the sources of a read of `key` by a step with `window`.
 *
 * Costs one writer lookup when no write of the key sits in the window, and one more per write that does.
 */
export function readSourcesOf(key: string, window: ReadWindow, lastWriterBefore: LastWriterBefore): ReadSources {
  let at = lastWriterBefore(key, window.end);
  if (at < window.start) return { before: at, during: NONE };
  const during: number[] = [];
  while (at >= window.start && at >= 0) {
    during.push(at);
    at = lastWriterBefore(key, at);
  }
  return { before: at, during: during.reverse() };
}

/**
 * How sure the source at `at` is, among the `sources` of one read: `undefined` when it is the certain one.
 *
 * `at` must be one of those sources: `sources.before`, or a member of `sources.during`. Any other
 * position is refused with a `RangeError`. WHY REFUSED, NOT ANSWERED: the function used to answer
 * `'written-while-running'` for a position that is no source at all, and a mark on a commit the read
 * could not have seen is a wrong statement that looks like a careful one. The check is a binary
 * search of `during` (it is ascending), so asking once per source of a wide window stays near linear.
 */
export function overlapOf(sources: ReadSources, at: number): ReadOverlap | undefined {
  if (at !== sources.before && !holds(sources.during, at)) {
    throw new RangeError(`overlapOf: position ${at} is not one of the sources of this read`);
  }
  if (sources.during.length === 0) return undefined;
  return at === sources.before ? 'replaced-while-running' : 'written-while-running';
}

/** Is `value` in the ascending list? */
function holds(ascending: readonly number[], value: number): boolean {
  let low = 0;
  let high = ascending.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (ascending[middle] === value) return true;
    if (ascending[middle] < value) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}

/**
 * The rule, forward: did a step with `window` read the value written at `write` (-1: the value from
 * before the run)? `next` is the write that ends that value's life (`undefined`: it lives to the end
 * of the log); `writtenInWindow` says whether any commit wrote the key inside the window.
 *
 * `false`: it did not. `true`: it did, for certain. A mark: it may have ({@link ReadOverlap}).
 *
 * The step looked at state when the log held `window.start` commits and, with a window, at moments up
 * to `window.end`. A look sees a value that was written before it and not ended before it; the step
 * that commits the write ending a value still read the old value first, so the life is closed at
 * `next`. The step read the value when at least one of its looks could see it.
 */
export function readOfValue(
  window: ReadWindow,
  write: number,
  next: number | undefined,
  writtenInWindow: boolean,
): boolean | ReadOverlap {
  if (write >= window.end || (next !== undefined && next < window.start)) return false;
  if (!writtenInWindow) return true;
  return write >= window.start ? 'written-while-running' : 'replaced-while-running';
}
