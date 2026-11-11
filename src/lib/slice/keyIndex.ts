/**
 * slice/keyIndex.ts — the one pass over the log both FORWARD queries share.
 *
 * WHY it exists: a backward slice only ever asks "who wrote key k before
 * idx i" — `findLastWriter` answers that with a backward scan. A forward
 * query asks the opposite, and the opposite is not symmetric: reads are NOT
 * in the commit log, and `KeysReadSource` is a LOOKUP (runtimeStageId →
 * keys), not an enumerable collection. So "who read k" cannot be looked up —
 * it has to be inverted.
 *
 * THE INVERSION (and the law it rests on): every executed stage commits, and
 * the FIRST bundle that carries a runtimeStageId is that execution's own (a
 * later one with the same id is a continuation: a fork child's settle, a
 * mount's exit). So the first bundles ARE the list of execution steps. Calling
 * the reads lookup once per execution, at its first bundle, turns the strategy
 * into a key → [commit indices that read it] index — and gives every read
 * moment a commit position, the join key the whole library is addressed by.
 *
 * Consequence worth stating (documented, not silently absorbed): a reads
 * provider naming a step that has no commit in THIS log contributes nothing.
 * That is the same log↔reads pairing law the backward side has — a subflow
 * runs in an isolated runtime, so its log and its tree must come from the
 * same scope (see README.md § Subflow boundaries).
 *
 * Cost: one lookup call per execution, once per query — O(N + total read keys).
 * Both forward queries then run off sorted index arrays.
 *
 * The sentences the queries say about what this index could not show them are in `notes.ts`.
 *
 * DAG position: internal to slice/ (not exported from the barrel).
 */

import type { KeysReadLookup } from '../memory/backtrack.js';
import {
  type WriterIndex,
  ascendingUnion,
  pathsWritten,
  relation,
  rootOf,
  writesOnlyInside,
} from '../memory/keyPaths.js';
import { isViewRow, replacesValue } from '../memory/builtOn.js';
import { logModel } from '../memory/logModel.js';
import type { SourceOverlap } from '../memory/parentEdges.js';
import { type ReadWindow, readOfValue } from '../memory/readWindow.js';
import { placesOf } from '../memory/windowPlacement.js';
import type { CommitBundle, TraceEntry } from '../memory/types.js';

/**
 * The inverted view of one commit log + its reads provider.
 *
 * WRITES follow the writer rule every key query shares (`memory/keyPaths.ts`, 9.33.0): a commit
 * writes a key with a row ON it, INSIDE it, or AROUND it when that changed it. READS follow the
 * same path relation: a stage that read the key, a path inside it (part of its value) or a
 * container around it (the whole of its value, and more) is a reader of the key. A read key is
 * matched as the reads provider spelled it, as a DELIM path — the engine's own nested reads are
 * spelled with dots (`StageContext · getValue`), and a dot is a legal character of a top-level key,
 * so `'cfg.a'` stays the literal key it may be.
 */
export interface KeyIndex {
  /** Where every path was written — the writer rule's index (`keyPaths · buildWriterIndex`). */
  readonly writers: WriterIndex;
  /** key → commit ARRAY positions that WROTE it under the writer rule, ascending. Memoised per key. */
  writesOf(key: string): number[];
  /**
   * The writes that END a value's life: the ones that REPLACE the key's value (`memory/builtOn.ts ·
   * replacesValue`). A write that merged into the value, appended to it or wrote a path inside it
   * changed part of it, and a reader after it still read the rest. Memoised.
   */
  closingWritesOf(key: string): number[];
  /** Read key, as the reads provider named it → commit ARRAY positions whose stage READ it, ascending. */
  readonly readsByKey: Map<string, number[]>;
  /** key → commit ARRAY positions whose stage read it, a path inside it or a container around it, ascending. Memoised. */
  readsOf(key: string): number[];
  /**
   * key → the commits (ARRAY positions, ascending) that hold a `set` row the WRITER built on its step's
   * view, on the key, inside it or around it (`TraceEntry.builtOnView`, `memory/builtOn.ts`). Such a
   * commit holds what the view held of the key. It reads the value for that row, at ITS OWN position (a
   * later commit of a step has a view of its own), and for nothing else it wrote.
   *
   * WHY NOT AMONG `readsOf`: those are the reads the steps' own code made, as the reads provider names
   * them. Mixed in, a commit of a step that never read the key showed up as a read of it in the
   * timeline, counted as "reads were recorded" for a log that recorded none, and fed every write of
   * its bundle. Memoised.
   */
  viewReadersOf(key: string): number[];
  /**
   * The executions whose reads are NOT dated at their own commit (`CommitBundle.beganAt`): first-bundle
   * ARRAY position → when the step looked at state (`readWindow.ts · windowOf`). Empty for a log with no
   * such step, which is every log of a run whose steps go one after another.
   */
  readonly windows: ReadonlyMap<number, ReadWindow>;
  /**
   * The steps among `readsOf(key)` that are in {@link windows}, ascending. Memoised, so a forward walk asks
   * the rule once per such READER of the key and never once per stamped step of the whole log (a large
   * fan-out stamps every branch, and few of them read any one key).
   */
  windowedReadsOf(key: string): number[];
  /**
   * The commits whose view was NOT pinned on the state just before their own commit
   * (`CommitBundle.viewAt`): ARRAY position → what that view held (`windowPlacement.ts · Places.view`).
   * Only commits that hold a row built on the view are here. Empty for a log whose steps go one after
   * another.
   */
  readonly views: ReadonlyMap<number, ReadWindow>;
  /** The commits among `viewReadersOf(key)` that are in {@link views}, ascending. Memoised, as {@link windowedReadsOf}. */
  datedViewsOf(key: string): number[];
  /** Every key this log knows BY NAME: written paths ∪ recorded read keys — the list an unknown-key note shows. */
  readonly knownKeys: Set<string>;
  /** Does the log know `key` — a write of it (the writer rule), or a read on, inside or around it? */
  isKnown(key: string): boolean;
}

/** Push into a Map<string, number[]>, creating the bucket on first touch. */
function push(map: Map<string, number[]>, key: string, idx: number): void {
  const arr = map.get(key);
  if (arr) arr.push(idx);
  else map.set(key, [idx]);
}

/**
 * Build the index. Indices go in ascending order by construction (we iterate
 * the log forwards), which is what lets every range query below be a pair of
 * binary searches instead of a scan.
 */
export function buildKeyIndex(commitLog: CommitBundle[], lookup: KeysReadLookup): KeyIndex {
  const model = logModel(commitLog);
  const writers = model.index;
  const readsByKey = new Map<string, number[]>();
  const readKeysByRoot = new Map<string, string[]>();
  const viewsByPath = new Map<string, number[]>();
  const viewPathsByRoot = new Map<string, string[]>();
  /** One more position under one name; the first time a name is seen it joins the names of its root. */
  const note = (byName: Map<string, number[]>, namesByRoot: Map<string, string[]>, name: string, at: number) => {
    if (!byName.has(name)) {
      const names = namesByRoot.get(rootOf(name));
      if (names) names.push(name);
      else namesByRoot.set(rootOf(name), [name]);
    }
    push(byName, name, at);
  };
  const executions = new Set<string>();
  const windows = new Map<number, ReadWindow>();
  const views = new Map<number, ReadWindow>();
  const places = placesOf(commitLog);
  for (let i = 0; i < commitLog.length; i++) {
    const bundle = commitLog[i];
    // Reads: one lookup per EXECUTION, at its first bundle (see THE INVERSION above). A later bundle
    // of the same runtimeStageId is a continuation; the stage read before its own commit, and the
    // backward walk dates it there too (`commitLogUtils · buildCommitIndex`).
    const first = !executions.has(bundle.runtimeStageId);
    executions.add(bundle.runtimeStageId);
    // Rows the writer built on the view belong to the BUNDLE, first or not (`viewReadersOf`), and so does
    // the moment that view was pinned: a later commit of a step has a view of its own.
    const viewed = new Set<string>();
    for (const row of bundle.trace) if (isViewRow(row)) viewed.add(row.path);
    for (const path of viewed) note(viewsByPath, viewPathsByRoot, path, i);
    if (viewed.size > 0) {
      const view = places.view(i);
      if (view.start < i) views.set(i, view);
    }
    if (!first) continue;
    const window = places.window(i);
    if (window.start < i) windows.set(i, window);
    // A provider that throws is a consumer bug, not a reason to lose the
    // query — the same error-isolation posture recorder callbacks get.
    let keys: string[] = [];
    try {
      keys = lookup(bundle.runtimeStageId) ?? [];
    } catch {
      /* provider threw — treat this step as "no recorded reads" */
    }
    for (const k of new Set(keys)) note(readsByKey, readKeysByRoot, k, i);
  }

  const writesOf = (key: string): number[] => model.writersOf(key) as number[];
  const closing = new Map<string, number[]>();
  const closingWritesOf = (key: string): number[] => {
    let positions = closing.get(key);
    if (positions === undefined) {
      positions = writesOf(key).filter((c) => replacesValue(commitLog[c], key));
      closing.set(key, positions);
    }
    return positions;
  };
  /** key → the positions noted under every name on the key, inside it or around it, ascending. Memoised. */
  const related = (byName: Map<string, number[]>, namesByRoot: Map<string, string[]>) => {
    const memo = new Map<string, number[]>();
    return (key: string): number[] => {
      let positions = memo.get(key);
      if (positions === undefined) {
        const names = namesByRoot.get(rootOf(key)) ?? [];
        positions = ascendingUnion(
          names.filter((name) => relation(name, key) !== undefined).map((name) => byName.get(name) as number[]),
        );
        memo.set(key, positions);
      }
      return positions;
    };
  };
  const readsOf = related(readsByKey, readKeysByRoot);
  const viewReadersOf = related(viewsByPath, viewPathsByRoot);
  const knownKeys = new Set<string>([...pathsWritten(writers), ...readsByKey.keys()]);
  const windowedReads = new Map<string, number[]>();
  const windowedReadsOf = (key: string): number[] => {
    let positions = windowedReads.get(key);
    if (positions === undefined) {
      positions = windows.size === 0 ? [] : readsOf(key).filter((position) => windows.has(position));
      windowedReads.set(key, positions);
    }
    return positions;
  };
  const datedViews = new Map<string, number[]>();
  const datedViewsOf = (key: string): number[] => {
    let positions = datedViews.get(key);
    if (positions === undefined) {
      positions = views.size === 0 ? [] : viewReadersOf(key).filter((position) => views.has(position));
      datedViews.set(key, positions);
    }
    return positions;
  };

  const isKnown = (key: string): boolean => writesOf(key).length > 0 || readsOf(key).length > 0;
  return {
    writers,
    writesOf,
    closingWritesOf,
    readsByKey,
    readsOf,
    viewReadersOf,
    windows,
    windowedReadsOf,
    views,
    datedViewsOf,
    knownKeys,
    isKnown,
  };
}

/**
 * One commit that read a value, and why it is only a possible reader when it is: a read's reason
 * (`readWindow.ts · ReadOverlap`), or the view's (`builtOn.ts · ViewOverlap`) when the commit holds the
 * value through a row built on a view alone and the array does not show where that view sits.
 */
export interface LifeReader {
  /** The ARRAY position of the commit: a step's first bundle, or a bundle that holds a row built on the view. */
  readonly position: number;
  /** Present when the commit is only a POSSIBLE reader of this value, by every way it read the key. */
  readonly overlap?: SourceOverlap;
  /** The step's own code read this value: its recorded reads name the key, dated by its read window. */
  readonly step: boolean;
  /** A `set` row of this commit, built by the writer on the step's view, holds this value (`KeyIndex.viewReadersOf`). */
  readonly view: boolean;
}

/** How a commit read a value one way: for certain, or only possibly (the mark says why). */
type Read = true | SourceOverlap;

/**
 * The commits that read the value of `key` written at `writeIdx` (`undefined`: the value from before the
 * run), whose life ends at `nextWriteIdx` (`undefined`: it lives to the end of the log), ascending — the
 * forward side of the one rule (`memory/readWindow.ts · readOfValue`).
 *
 * A step with no window read the value when its commit sits in the life: after the write, up to and
 * including the next write (the step that commits the next write read the old value first). That is a
 * range query, and it is the whole answer for a log whose steps go one after another. A step that carries
 * `beganAt` is not dated at its own commit, so each of those is asked the rule instead: it read the value
 * when one of its looks at state could see it, and it is a possible reader, not a certain one, when the
 * key was written inside its window.
 *
 * A commit that holds a `set` row the writer built on its step's view is a reader in a second way, by
 * the same rule and with a date of its own: the moment that view was pinned (`KeyIndex.views`). The two
 * ways are asked apart, because their dates differ (a step may have read the key early and pinned the
 * view of a later commit late), and each reader says which of them saw THIS value (`step`, `view`).
 */
export function readersOfLife(
  index: Pick<
    KeyIndex,
    'windows' | 'windowedReadsOf' | 'readsOf' | 'views' | 'datedViewsOf' | 'viewReadersOf' | 'writesOf'
  >,
  key: string,
  writeIdx: number | undefined,
  nextWriteIdx: number | undefined,
): LifeReader[] {
  const from = writeIdx === undefined ? 0 : writeIdx + 1;
  const writes = index.writesOf(key);
  /** One way of reading: the commits dated at their own commit by range, the dated ones by the rule. */
  const readersBy = (all: number[], dated: number[], dates: ReadonlyMap<number, ReadWindow>): [number, Read][] => {
    const found: [number, Read][] = [];
    for (const position of indicesInRange(all, from, nextWriteIdx))
      if (!dates.has(position)) found.push([position, true]);
    for (const position of dated) {
      const window = dates.get(position)!;
      // Two halvings, never a copy of the writes in the window: with a wide window on every reader of a
      // key that is written all along (a fan-out), a copy per reader cost the square of the log.
      const written = lowerBound(writes, window.start) < lowerBound(writes, window.end);
      const read = readOfValue(window, writeIdx ?? -1, nextWriteIdx, written);
      if (read !== false) found.push([position, read]);
    }
    return found;
  };
  const how = new Map<number, { step?: Read; view?: Read }>();
  for (const [position, read] of readersBy(index.readsOf(key), index.windowedReadsOf(key), index.windows)) {
    how.set(position, { step: read });
  }
  // A log with no such row (every log before the mark existed) has the steps' reads alone.
  const viewers = index.viewReadersOf(key);
  if (viewers.length > 0) {
    for (const [position, read] of readersBy(viewers, index.datedViewsOf(key), index.views)) {
      // The rule answers in a read's words. A view is only possible for one reason, the array's.
      how.set(position, { ...how.get(position), view: read === true ? true : 'view-not-placed' });
    }
  }
  return [...how]
    .sort(([one], [other]) => one - other)
    .map(([position, { step, view }]) => {
      // Certain when either way is: the commit then holds this value for sure.
      const overlap = step === true || view === true ? undefined : step ?? view;
      return {
        position,
        ...(overlap !== undefined && { overlap }),
        step: step !== undefined,
        view: view !== undefined,
      };
    });
}

/**
 * Does this log carry ANY recorded read? The provider-agnostic version of
 * `ReadsCoverage.stepsWithReads > 0` (map / custom-fn strategies carry no
 * coverage), and the switch that decides whether "nobody read it" is a
 * FINDING or a BLIND SPOT.
 */
export function hasRecordedReads(index: KeyIndex): boolean {
  return index.readsByKey.size > 0;
}

/** First position in the ascending array holding a value >= `value`. */
function lowerBound(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Ascending indices in the INCLUSIVE range [from, to]. `to === undefined`
 * means "to the end of the log".
 */
export function indicesInRange(sorted: number[] | undefined, from: number, to?: number): number[] {
  if (!sorted || sorted.length === 0) return [];
  const start = lowerBound(sorted, from);
  const end = to === undefined ? sorted.length : lowerBound(sorted, to + 1);
  return sorted.slice(start, end);
}

/** The largest index in the ascending array that is < `before`, or undefined. */
export function lastIndexBefore(sorted: number[] | undefined, before?: number): number | undefined {
  if (!sorted || sorted.length === 0) return undefined;
  const end = before === undefined ? sorted.length : lowerBound(sorted, before);
  return end > 0 ? sorted[end - 1] : undefined;
}

/** The smallest index in the ascending array that is > `after`, or undefined. */
export function firstIndexAfter(sorted: number[] | undefined, after: number): number | undefined {
  if (!sorted || sorted.length === 0) return undefined;
  const at = lowerBound(sorted, after + 1);
  return at < sorted.length ? sorted[at] : undefined;
}

/**
 * The LAST trace entry for `path` in a bundle — the one that decides both the
 * committed verb and (under the writeProvenance dial) the widest read prefix.
 * Full mode can record several ops on one path in one commit; read prefixes
 * only grow during a stage, so the last entry is the honest one to attribute
 * with.
 */
export function lastTraceEntry(bundle: CommitBundle, path: string): TraceEntry | undefined {
  for (let i = bundle.trace.length - 1; i >= 0; i--) {
    if (bundle.trace[i].path === path) return bundle.trace[i];
  }
  return undefined;
}

/**
 * The trace entry that decides a WRITE of `key` in `bundle` — its verb, and the read prefix a
 * fed edge is judged by: the LAST entry on the exact path when there is one (as before 9.33.0),
 * otherwise the last entry inside or around the key (the commit wrote it through a nested row).
 */
export function writeEntry(bundle: CommitBundle, key: string): TraceEntry | undefined {
  const exact = lastTraceEntry(bundle, key);
  if (exact !== undefined) return exact;
  for (let i = bundle.trace.length - 1; i >= 0; i--) {
    if (relation(bundle.trace[i].path, key) !== undefined) return bundle.trace[i];
  }
  return undefined;
}

/**
 * The commits in `writes` that reached `key` ONLY through rows inside it — no row on the key and
 * none around it — so each changed part of its value, not the whole. What a `'nested-rows'` note
 * names.
 */
export function nestedOnlyWrites(commitLog: readonly CommitBundle[], key: string, writes: readonly number[]): number[] {
  return writes.filter((i) => writesOnlyInside(commitLog[i], key));
}

/**
 * The commits in `writes` that neither replaced `key` nor reached it only through rows inside it: a
 * `merge` or an `append` on the key, or a `merge` of a container around it. Each was folded onto what
 * the key held. What a `'partial-write'` note names (the nested-only ones have their own note).
 */
export function mergedWrites(commitLog: readonly CommitBundle[], key: string, writes: readonly number[]): number[] {
  return writes.filter((i) => !replacesValue(commitLog[i], key) && !writesOnlyInside(commitLog[i], key));
}

/** Distinct written paths of a bundle, in first-touch order. */
export function writtenPaths(bundle: CommitBundle): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of bundle.trace) {
    if (!seen.has(t.path)) {
      seen.add(t.path);
      out.push(t.path);
    }
  }
  return out;
}
