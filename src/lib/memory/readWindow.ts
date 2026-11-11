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
 * first look, which never changes under it, and, for a key that view cannot answer, from live state
 * as it stands at that moment. The writer notes the log's length at the step's first look and at its
 * latest look at live state, and puts them on the step's first bundle when they say more than
 * "everything before my own commit":
 *   - `beganAt`: other steps committed between the step's first look and its own commit. The step's
 *     reads are dated at `beganAt`.
 *   - `sawUntil`: the step looked at live state again after such a commit. Commits `beganAt` to
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
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * A step and the indices around it: the commit index of any bundle of the array, as the step at
 * `first` (whose own index is `own`) has to read it.
 *
 * A bundle says its index in `idx`. One that does not (a stand-in for a lost row, a log built by
 * hand) is taken to sit where its position puts it relative to the step: one place before the step
 * is one commit before it. WHY RELATIVE TO THE STEP, not its bare position: in a slice of a log the
 * positions start at 0 and the indices do not, so a bare position would make such a bundle look like
 * one of the first commits of the log, seen by every step. (Shown by the second reader: a slice
 * numbered 10 to 12 with one bundle missing its `idx` dated a step at its own commit again.)
 */
type IndexAt = (position: number) => number;
function indicesAround(log: readonly CommitBundle[], first: number): { own: number; indexAt: IndexAt } {
  const ownIdx = log[first]?.idx;
  const own = isCount(ownIdx) ? ownIdx : first;
  return {
    own,
    indexAt: (position) => {
      const idx = log[position]?.idx;
      return isCount(idx) ? idx : own - (first - position);
    },
  };
}

/**
 * Where the commits "from index `index` on" begin in this array, at or before the step at `first`.
 *
 * Two cases, neither a walk:
 *   - the array is unbroken around the step (a whole log, a slice of one, a whole log placed after
 *     another): positions and indices move together, so the place is one subtraction away and one
 *     look confirms it;
 *   - bundles are missing between that place and the step (the array was filtered, or cut inside the
 *     window): the indices still rise along the array, so the place is found by halving.
 *
 * WHY NOT WALK BACK. A walk costs the window's width, for every step that has one. A fan-out of
 * thousands of branches gives thousands of wide windows, and a record from outside can claim one
 * per bundle: the cost grew with the square of the log (measured by the second reader on the key
 * timeline: 15 ms became 1.7 s at 20,000 steps; also raised by the automated security review).
 * Halving costs the logarithm, whoever wrote the record.
 *
 * NOT COVERED: an array whose indices do not rise (two filtered logs back to back, a bundle that
 * says an index lower than the one before it). The answer is then some position at or before the
 * step; it is never slow and never out of range. A door that takes records from outside makes the
 * indices rise before any reader sees them ({@link admitStamps}).
 */
function firstFrom(first: number, own: number, indexAt: IndexAt, index: number): number {
  const at = first - (own - index);
  if (at >= 0 && at <= first && indexAt(at) === index) return at;
  let low = 0;
  let high = first;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (indexAt(mid) >= index) high = mid;
    else low = mid + 1;
  }
  return low;
}

/**
 * The window of the step whose FIRST bundle is `log[first]`.
 *
 * WHY BY INDEX, NOT BY DISTANCE ALONE. `beganAt` and `sawUntil` count commits of the log the bundle
 * was written to, and every bundle of that log carries its own `idx`. The array a reader is handed
 * may be a slice of that log, or have bundles taken out of it (continuation bundles filtered away, a
 * row that could not be read). The commits a step had seen are the ones whose `idx` is below
 * `beganAt`, wherever they sit, so the window is placed by the `idx` the bundles carry
 * ({@link firstFrom}). (The second reader of this change showed what distance alone does: on a log
 * with its continuation bundles filtered out, the window started too early and the real source was
 * left out.) The array must keep its bundles in order: a slice or a filtered copy is fine, and whole
 * logs may follow one another.
 *
 * A bundle with no stamp is dated at its own commit: the reading every log had before the fields.
 * A stamp that IS there but cannot be one (a typed log built by hand, a stored row that was damaged)
 * says the step did not simply see everything before its commit, without saying from when. It is
 * never read as a narrower window than the truth could be: an unusable `beganAt` opens the window
 * over every commit before the step, and an unusable `sawUntil` beside a good `beganAt` opens it up
 * to the step's own commit. (A door that takes records from outside refuses such a bundle instead:
 * {@link admitStamps}.)
 */
export function windowOf(log: readonly CommitBundle[], first: number): ReadWindow {
  const bundle = log[first];
  const beganAt = bundle?.beganAt;
  const sawUntil = bundle?.sawUntil;
  if (beganAt === undefined && sawUntil === undefined) return { start: first, end: first };
  const { own, indexAt } = indicesAround(log, first);
  if (!isCount(beganAt) || beganAt >= own) return { start: 0, end: first };
  const start = firstFrom(first, own, indexAt, beganAt);
  if (sawUntil === undefined) return { start, end: start };
  if (!isCount(sawUntil) || sawUntil <= beganAt || sawUntil > own) return { start, end: first };
  return { start, end: firstFrom(first, own, indexAt, sawUntil) };
}

/** What an admitted copy of a bundle keeps of its place in its log: its commit index and its stamps. */
export type Placed = Required<Pick<CommitBundle, 'idx'>> & Pick<CommitBundle, 'beganAt' | 'sawUntil'>;

/**
 * Admit the place of a bundle that came from outside (a stored record, a record handed to a reader):
 * the three values as the caller read them off it, and `after`, the index of the copy before it in
 * the log (-1 for the first). Returns what the copy keeps, or `undefined` when the stamps cannot be
 * stamps.
 *
 * WHY REFUSE, NOT IGNORE. A stamp that is dropped reads as "this step saw everything before its own
 * commit": the dating the stamp exists to correct, and a narrower claim than the record made. So a
 * value that cannot be a stamp fails the bundle at every door: `beganAt` must be a whole number
 * before the bundle's own index, `sawUntil` a whole number after `beganAt` and not past that index,
 * and never present without `beganAt`.
 *
 * WHY THE COPIES' INDICES ALWAYS RISE. The stamps are read against the `idx` of the bundles around
 * them ({@link windowOf}), so one odd `idx` on a neighbour can move another step's window and put a
 * wrong writer forward as the certain one. A door therefore keeps a bundle's own `idx` only when it
 * is a whole number past the copy before it. An `idx` that is missing, not a whole number or not
 * past the one before is replaced by the next index on a bundle with no stamp (such a bundle only
 * needs its place in the order). Beside a stamp the same `idx` refuses the bundle, because the stamp
 * then counts against nothing; a stamped bundle with no `idx` at all is read at the next index, as a
 * log built by hand is.
 */
export function admitStamps(beganAt: unknown, sawUntil: unknown, idx: unknown, after: number): Placed | undefined {
  const own = isCount(idx) && Number.isSafeInteger(idx) && idx > after ? idx : undefined;
  if (beganAt === undefined) return sawUntil === undefined ? { idx: own ?? after + 1 } : undefined;
  const at = idx === undefined ? after + 1 : own;
  if (at === undefined || !isCount(beganAt) || beganAt >= at) return undefined;
  if (sawUntil === undefined) return { idx: at, beganAt };
  return isCount(sawUntil) && sawUntil > beganAt && sawUntil <= at ? { idx: at, beganAt, sawUntil } : undefined;
}

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

/** How sure the source at `at` is, among the `sources` of one read: `undefined` when it is the certain one. */
export function overlapOf(sources: ReadSources, at: number): ReadOverlap | undefined {
  if (sources.during.length === 0) return undefined;
  return at === sources.before ? 'replaced-while-running' : 'written-while-running';
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
