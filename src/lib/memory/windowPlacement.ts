/**
 * windowPlacement.ts — where a step's read window sits in the array a reader holds.
 *
 * WHY THIS FILE EXISTS. The rule (`readWindow.ts`) speaks in ARRAY positions: "the last write before
 * the window", "the writes inside it". A bundle's stamps speak in COMMIT INDICES of the log it was
 * written to (`beganAt`, `sawUntil`, beside its own `idx`). The array a reader is handed is not always
 * that whole log: it may be a slice, have bundles taken out (continuations filtered away, a row that
 * could not be read), or be several logs one after another (the legs of a run that was paused and
 * resumed on a fresh executor). Placing a window means turning the two indices into two positions.
 *
 * THE LAW. The commits a step had seen when it began are the ones whose index is below its
 * `beganAt`, wherever they sit in the array. So the window is placed by the `idx` the bundles carry,
 * never by counting positions alone, and only inside the step's own log.
 *
 * HOW, IN ONE PASS PER LOG AND NO WALK PER STEP.
 *   1. STRETCHES. One pass finds where the indices stop rising: each such place starts a new stretch
 *      (another log, or a bundle that says an index not past the one before it). A step is searched
 *      for inside its own stretch only.
 *   2. A BUNDLE THAT SAYS NO INDEX has one only as far as its neighbours pin it. It sits past the
 *      bundle before it (the EARLIEST it can be; its position, when it is at the head of the array)
 *      and before the next bundle that says an index (the LATEST it can be). In an unbroken array
 *      the two are the same number. Where the said indices show a hole (two bundles further apart
 *      in index than in position, or a first said index larger than its position) the silent
 *      bundles there could sit anywhere in the hole, and the two readings differ. Nothing after it
 *      says an index: it is taken to follow the bundle before it directly, so a log where no bundle
 *      says an index (built by hand) is read by position. One case is not taken on trust: silent
 *      bundles right before a new stretch may be the last of their log or the first of the next. A
 *      step that sits there has its window opened over everything before it.
 *   3. PLACING. When the array is unbroken around the step, positions and indices move together: the
 *      place is one subtraction away and one look confirms it. Otherwise the indices still rise along
 *      the stretch, and the place is found by halving. The window STARTS at the first bundle that
 *      could sit at `beganAt` or later (its latest reading) and ENDS at the first bundle that surely
 *      does (its earliest reading, against `sawUntil`, or against `beganAt` when the step never looked
 *      again). So a bundle whose place is not known is inside the window whenever it could be: its
 *      write is a possible source, never a certain one, and never left out.
 *   4. WHEN THE STRETCH DOES NOT HOLD THE WINDOW'S START. A stretch that begins after the step began
 *      (its first index is past `beganAt`) and is not the head of the array could be two things:
 *      another log cut short, or this step's own log with one damaged index in it, which looks like
 *      a boundary. The two cannot be told apart, so the window is opened over everything before the
 *      step: every earlier writer of a key is then a possible source, none is certain, and none is
 *      left out. (Shown by the second reader: one bundle that said an index too large cut the step
 *      off from its own log, and the sibling came back as the one certain source.)
 *
 * WHY NOT WALK BACK FROM THE STEP. A walk costs the window's width for every step that has one. A
 * fan-out of thousands of branches gives thousands of wide windows, and a record from outside can
 * claim one per bundle, so the cost grew with the square of the log. Measured by the second reader of
 * this change on the key timeline of a 20,000-wide fan-out: 15 ms became 1.7 s. The automated
 * security review raised the same cost. One pass per log and a halving per step costs n + s log n.
 *
 * WHAT WENT WRONG ON THE WAY, kept so it is not tried again:
 *   - by distance alone (`first - (idx - beganAt)`): a log with its continuation bundles filtered out
 *     started the window too early, and the step lost its real source with no note;
 *   - a walk that stopped where the indices stopped falling: one odd `idx` on a neighbour ended the
 *     walk early, and the sibling came back as the one certain source;
 *   - a search over the whole array: with one log in front of another, the window landed in the
 *     wrong log;
 *   - a missing index read at its bare position, or relative to the step: wrong in a slice, wrong in
 *     a filtered log;
 *   - a missing index read as ONE number, next to its neighbour: in a log with bundles taken out the
 *     bundle looked older than it was, counted as seen, and came back as the one certain source.
 *
 * NOT COVERED, because nothing in the array shows it:
 *   - a bundle that says a wrong index which still rises is believed;
 *   - bundles that say no index at the END OF THE ARRAY, after the last one that does (or an array
 *     where none does), are taken to follow one another directly. If bundles were taken out among
 *     them, or they are the first bundles of another log whose later bundles were cut away, they are
 *     older or newer than they are read;
 *   - the array is taken to hold the step's history. A reader names the last writer that is IN the
 *     array: a writer that was taken out, or that sits in a part of another log that was cut away
 *     before the logs were joined, cannot be named, and indices that still rise across such a join
 *     do not show it. That is so with or without a window; it is the caller's claim, not checked here;
 *   - a log put behind another one shows where it begins only by an index that does not rise. Its
 *     first bundles must say their index for that: a head that says none is read as going on with
 *     the log before it, and when a later index of the second log still rises past that reading
 *     (bundles were taken out of it), the join is never seen. A step of the second log is then
 *     dated in the first, and can be given a writer of the first as its one certain source;
 *   - the stamps sit on a step's FIRST bundle. An array without that bundle has lost them, and the
 *     step's later bundles are read as any bundle with no stamp.
 *
 * WHY A DOOR READS STRICTER THAN THIS FILE. An array of typed bundles may be several logs one after
 * another (the legs of a paused run), so here an index that does not rise starts a new stretch, and a
 * stretch that holds the step's start is trusted as its log. A door that takes a record from outside
 * (the cause graph, the PROV export) is handed ONE log by contract. There an index that does not rise
 * is damage, never a join: the door leaves it off its copy, the bundles around it pin the place, and
 * every admitted log is one stretch (`readWindow.ts · admitStamps`). The same damaged array given to
 * this file as typed bundles is read as two logs; that cannot be told apart here.
 */

import { isCount, isIndex, type ReadWindow } from './readWindow.js';
import type { CommitBundle } from './types.js';

/** What one pass over a log array finds. */
interface Layout {
  /** Where each stretch of rising indices starts, ascending. The first is always 0. */
  readonly starts: readonly number[];
  /** The lowest index the bundle at each position can have. Rises along a stretch. */
  readonly earliest: readonly number[];
  /** The highest. The same array as `earliest` when every bundle's index is pinned to one number. */
  readonly latest: readonly number[];
}

const LAYOUTS = new WeakMap<readonly CommitBundle[], Layout>();

/**
 * The layout of `log`. Kept for a frozen log (the array and every bundle frozen: an engine
 * snapshot's), which cannot change, as the log model is (`logModel.ts`). Computed when asked for any
 * other array, so a caller that asks for many steps takes {@link windowsOf} once.
 *
 * Each bundle's `idx` is read ONCE, here. Every later question is answered from these numbers, so a
 * bundle that answers differently the second time (a getter, a proxy) cannot make two steps of one
 * query disagree about where a commit sits.
 */
function layoutOf(log: readonly CommitBundle[]): Layout {
  const kept = LAYOUTS.get(log);
  if (kept !== undefined) return kept;
  const starts = [0];
  const earliest = new Array<number>(log.length);
  const silent: number[] = [];
  let last = -1; // the earliest reading of the bundle before
  let frozen = Object.isFrozen(log);
  for (let at = 0; at < log.length; at++) {
    const bundle = log[at];
    frozen &&= Object.isFrozen(bundle);
    const idx = bundle?.idx;
    if (isIndex(idx)) {
      // Not past the bundle before it, even read as early as that one can be: another log starts here,
      // or one of the two is damaged (step 4 decides what a step may then take from before it).
      if (at > 0 && idx <= last) starts.push(at);
      last = idx;
    } else {
      silent.push(at);
      last += 1;
    }
    earliest[at] = last;
  }
  const pinned = silent.length === 0 || silent.length === log.length;
  const layout: Layout = { starts, earliest, latest: pinned ? earliest : latestOf(earliest, starts, silent) };
  if (frozen) LAYOUTS.set(log, layout);
  return layout;
}

/**
 * The latest reading of every position (step 2 of the file header): a silent bundle sits before the
 * bundle after it in its stretch. Walked from the end, so a run of silent bundles counts back from
 * the bundle that says an index after them.
 *
 * A run with nothing after it in its stretch has no such bound. At the end of the ARRAY it keeps its
 * earliest reading: the bundles are taken to follow one another directly. Where ANOTHER STRETCH
 * follows, they cannot be told from the first bundles of that next log, which would give them other
 * indices altogether: their latest reading is `Infinity`, which says "no place a stamp can be
 * counted against" (`windowsOf` opens the window for a step that sits there).
 */
function latestOf(earliest: readonly number[], starts: readonly number[], silent: readonly number[]): number[] {
  const latest = earliest.slice();
  let stretch = starts.length - 1;
  for (let k = silent.length - 1; k >= 0; k--) {
    const at = silent[k];
    if (at + 1 === latest.length) continue;
    while (starts[stretch] > at + 1) stretch--;
    latest[at] = starts[stretch] === at + 1 ? Infinity : latest[at + 1] - 1;
  }
  return latest;
}

/** The start of the stretch that holds `position`: the last start at or before it. */
function stretchOf(starts: readonly number[], position: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >>> 1;
    if (starts[mid] <= position) low = mid;
    else high = mid - 1;
  }
  return starts[low];
}

/**
 * The first position between `low` and the step at `first` that `readings` puts at `index` or later;
 * `first` when none before it is (step 3). `readings` rises strictly along a stretch (`layoutOf`
 * starts a new one wherever it would not, and `isIndex` keeps every sum exact).
 */
function firstFrom(readings: readonly number[], low: number, first: number, index: number): number {
  // Unbroken around the step: one subtraction lands on the bundle read at exactly `index`. The bundle
  // before it is read lower, so this is the first.
  const at = first - (readings[first] - index);
  if (at >= low && at <= first && readings[at] === index) return at;
  let from = low;
  let to = first;
  while (from < to) {
    const mid = (from + to) >>> 1;
    if (readings[mid] >= index) to = mid;
    else from = mid + 1;
  }
  return from;
}

/**
 * The windows of one log: ask the answer for the step whose FIRST bundle is at a position. The pass
 * over the log is taken once, at the first step that carries a stamp, so a log with none costs nothing.
 *
 * A bundle with no stamp is dated at its own commit: the reading every log had before the fields.
 * A stamp that IS there but cannot be one (a typed log built by hand, a stored row that was damaged)
 * says the step did not simply see everything before its commit, without saying from when. It is
 * never read as a narrower window than the truth could be: an unusable `beganAt` opens the window
 * over every commit of the step's log before it (over everything before it when the stretch is not
 * a log from its first commit: step 4 of the file header), and an unusable `sawUntil` beside a good
 * `beganAt` opens it up to the step's own commit. (A door that takes records from outside refuses
 * such a bundle instead: `readWindow.ts · admitStamps`.)
 */
export function windowsOf(log: readonly CommitBundle[]): (first: number) => ReadWindow {
  let known: Layout | undefined;
  return (first) => {
    const bundle = log[first];
    const beganAt = bundle?.beganAt;
    const sawUntil = bundle?.sawUntil;
    if (beganAt === undefined && sawUntil === undefined) return { start: first, end: first };
    const { starts, earliest, latest } = (known ??= layoutOf(log));
    const low = stretchOf(starts, first);
    // The step's own index, read as late as it can be: a stamp is unusable only when it fits no reading.
    const own = latest[first];
    // Step 4: can the stretch be trusted to hold the step's history from index `from` on?
    const heldFrom = (from: number) => low === 0 || latest[low] <= from;
    // A stamp that fits no place the step can have, or a step with no place at all: it says no index and
    // another log follows it, so it may be the last bundle of this log or one of the first of that one.
    if (!isCount(beganAt) || beganAt >= own || own === Infinity) return { start: heldFrom(0) ? low : 0, end: first };
    if (!heldFrom(beganAt)) return { start: 0, end: first };
    // Could sit at `beganAt` or later: from here on a commit may not have been in the step's first view.
    const start = firstFrom(latest, low, first, beganAt);
    // Surely at `index` or later: from here on a commit was not seen.
    const surelyFrom = (index: number) => firstFrom(earliest, low, first, index);
    // The step never looked again: no window, unless a bundle's place around `beganAt` is not known.
    if (sawUntil === undefined) return { start, end: earliest === latest ? start : surelyFrom(beganAt) };
    if (!isCount(sawUntil) || sawUntil <= beganAt || sawUntil > own) return { start, end: first };
    return { start, end: surelyFrom(sawUntil) };
  };
}

/** The window of one step: {@link windowsOf} for a single ask. */
export function windowOf(log: readonly CommitBundle[], first: number): ReadWindow {
  return windowsOf(log)(first);
}
