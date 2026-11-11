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
 *   2. A BUNDLE THAT SAYS NO INDEX is read next to its neighbour: one past the bundle before it; a
 *      run of them at the head of a stretch counts back from the first bundle that says one. A log
 *      where no bundle says an index (built by hand) is read by position.
 *   3. PLACING. When the array is unbroken around the step, positions and indices move together: the
 *      place is one subtraction away and one look confirms it. Otherwise the indices still rise along
 *      the stretch, and the place is found by halving.
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
 *     a filtered log.
 *
 *   4. WHEN THE STRETCH DOES NOT HOLD THE WINDOW'S START. A stretch that begins after the step began
 *      (its first index is past `beganAt`) and is not the head of the array could be two things:
 *      another log cut short, or this step's own log with one damaged index in it, which looks like
 *      a boundary. The two cannot be told apart, so the window is opened over everything before the
 *      step: every earlier writer of a key is then a possible source, none is certain, and none is
 *      left out. (Shown by the second reader: one bundle that said an index too large cut the step
 *      off from its own log, and the sibling came back as the one certain source.)
 *
 * NOT COVERED. A bundle that says a wrong index which still rises is believed: nothing can tell it
 * from a true one. A bundle that says none is placed next to its neighbour, which is right when no
 * bundle was taken out between the two and a guess otherwise. A door that takes records from outside
 * makes every copy say a rising index before any reader sees it (`readWindow.ts · admitStamps`).
 */

import { isCount, type ReadWindow } from './readWindow.js';
import type { CommitBundle } from './types.js';

/** What one pass over a log array finds. */
interface Layout {
  /** Where each stretch of rising indices starts, ascending. The first is always 0. */
  readonly starts: readonly number[];
  /** The index the bundle at a position is read at. */
  indexAt(position: number): number;
}

const LAYOUTS = new WeakMap<readonly CommitBundle[], Layout>();

/**
 * The layout of `log`. Kept for a frozen log (the array and every bundle frozen: an engine
 * snapshot's), which cannot change, as the log model is (`logModel.ts`). Computed when asked for any
 * other array, so a caller that asks for many steps takes {@link windowsOf} once.
 */
function layoutOf(log: readonly CommitBundle[]): Layout {
  const kept = LAYOUTS.get(log);
  if (kept !== undefined) return kept;
  const starts = [0];
  let last = -1;
  let saying = 0;
  let frozen = Object.isFrozen(log);
  for (let at = 0; at < log.length; at++) {
    const bundle = log[at];
    frozen &&= Object.isFrozen(bundle);
    const idx = bundle?.idx;
    if (!isCount(idx)) continue;
    saying++;
    if (at > 0 && idx <= last) starts.push(at);
    last = idx;
  }
  const layout: Layout = { starts, indexAt: readerOf(log, starts, saying) };
  if (frozen) LAYOUTS.set(log, layout);
  return layout;
}

/** How a position's index is read (step 2 of the file header). */
function readerOf(log: readonly CommitBundle[], starts: readonly number[], saying: number): Layout['indexAt'] {
  if (saying === log.length) return (position) => log[position].idx as number;
  if (saying === 0) return (position) => position;
  // Some say their index and some do not: place each silent bundle next to its neighbour, once.
  const readAt = new Array<number>(log.length);
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s];
    const to = starts[s + 1] ?? log.length;
    let first = from;
    while (first < to && !isCount(log[first]?.idx)) first++;
    if (first === to) {
      for (let at = from; at < to; at++) readAt[at] = at - from;
      continue;
    }
    for (let at = first; at >= from; at--) readAt[at] = (log[first].idx as number) - (first - at);
    for (let at = first + 1; at < to; at++) {
      const idx = log[at]?.idx;
      readAt[at] = isCount(idx) ? idx : readAt[at - 1] + 1;
    }
  }
  return (position) => readAt[position];
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

/** Where the commits "from index `index` on" begin, between `low` and the step at `first` (step 3). */
function firstFrom({ indexAt }: Layout, low: number, first: number, index: number): number {
  const at = first - (indexAt(first) - index);
  if (at >= low && at <= first && indexAt(at) === index) return at;
  let from = low;
  let to = first;
  while (from < to) {
    const mid = (from + to) >>> 1;
    if (indexAt(mid) >= index) to = mid;
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
    const layout = (known ??= layoutOf(log));
    const low = stretchOf(layout.starts, first);
    const own = layout.indexAt(first);
    // Step 4: can the stretch be trusted to hold the step's history from index `from` on?
    const heldFrom = (from: number) => low === 0 || layout.indexAt(low) <= from;
    if (!isCount(beganAt) || beganAt >= own) return { start: heldFrom(0) ? low : 0, end: first };
    if (!heldFrom(beganAt)) return { start: 0, end: first };
    const start = firstFrom(layout, low, first, beganAt);
    if (sawUntil === undefined) return { start, end: start };
    if (!isCount(sawUntil) || sawUntil <= beganAt || sawUntil > own) return { start, end: first };
    return { start, end: firstFrom(layout, low, first, sawUntil) };
  };
}

/** The window of one step: {@link windowsOf} for a single ask. */
export function windowOf(log: readonly CommitBundle[], first: number): ReadWindow {
  return windowsOf(log)(first);
}
