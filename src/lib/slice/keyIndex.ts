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
import { type ReadOverlap, type ReadWindow, readOfValue } from '../memory/readWindow.js';
import { windowsOf } from '../memory/windowPlacement.js';
import { shownPath } from '../record-paths/codec.js';
import type { CommitBundle, TraceEntry } from '../memory/types.js';
import type { HonestyNote } from './types.js';

/** How many known keys an unknown-key refusal lists before it says "+N more". */
export const KNOWN_KEYS_LISTED = 10;

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
   * The commits among `readsOf(key)` and `viewReadersOf(key)` that are in {@link windows}, ascending.
   * Memoised, so a forward walk asks the rule once per such READER of the key and never once per stamped
   * step of the whole log (a large fan-out stamps every branch, and few of them read any one key).
   */
  windowedReadsOf(key: string): number[];
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
  const windowAt = windowsOf(commitLog);
  for (let i = 0; i < commitLog.length; i++) {
    const bundle = commitLog[i];
    // Reads: one lookup per EXECUTION, at its first bundle (see THE INVERSION above). A later bundle
    // of the same runtimeStageId is a continuation; the stage read before its own commit, and the
    // backward walk dates it there too (`commitLogUtils · buildCommitIndex`).
    const first = !executions.has(bundle.runtimeStageId);
    executions.add(bundle.runtimeStageId);
    // Rows the writer built on the view belong to the BUNDLE, first or not (`viewReadersOf`).
    const viewed = new Set<string>();
    for (const row of bundle.trace) if (isViewRow(row)) viewed.add(row.path);
    for (const path of viewed) note(viewsByPath, viewPathsByRoot, path, i);
    if (!first && viewed.size === 0) continue;
    const window = windowAt(i);
    if (window.start < i) windows.set(i, window);
    if (!first) continue;
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
      positions =
        windows.size === 0
          ? []
          : ascendingUnion([readsOf(key), viewReadersOf(key)]).filter((position) => windows.has(position));
      windowedReads.set(key, positions);
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
    knownKeys,
    isKnown,
  };
}

/** One commit that read a value, and why it is only a possible reader when it is (`readWindow.ts · ReadOverlap`). */
export interface LifeReader {
  /** The ARRAY position of the commit: a step's first bundle, or a bundle that holds a row built on the view. */
  readonly position: number;
  readonly overlap?: ReadOverlap;
  /** The step's own code read the key (`KeyIndex.readsOf`). */
  readonly step: boolean;
  /** The writer built a `set` row of this commit on the step's view of the key (`KeyIndex.viewReadersOf`). */
  readonly view: boolean;
}

/**
 * The steps that read the value of `key` written at `writeIdx` (`undefined`: the value from before the
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
 * A commit that holds a `set` row the writer built on its step's view is a reader by the same rule,
 * dated by its own stamps (`KeyIndex.viewReadersOf`). Each reader says which it is (`step`, `view`).
 */
export function readersOfLife(
  index: Pick<KeyIndex, 'windows' | 'windowedReadsOf' | 'readsOf' | 'viewReadersOf' | 'writesOf'>,
  key: string,
  writeIdx: number | undefined,
  nextWriteIdx: number | undefined,
): LifeReader[] {
  const steps = index.readsOf(key);
  const views = index.viewReadersOf(key);
  // A log with no such row (every log before the mark existed) takes the lists as they are.
  const how =
    views.length === 0
      ? () => BY_STEP
      : (position: number) => ({ step: holds(steps, position), view: holds(views, position) });
  const lookers = views.length === 0 ? steps : ascendingUnion([steps, views]);
  const inLife = indicesInRange(lookers, writeIdx === undefined ? 0 : writeIdx + 1, nextWriteIdx);
  const stamped = index.windowedReadsOf(key);
  if (stamped.length === 0) return inLife.map((position) => ({ position, ...how(position) }));
  const readers: LifeReader[] = [];
  for (const position of inLife) if (!index.windows.has(position)) readers.push({ position, ...how(position) });
  const writes = index.writesOf(key);
  for (const position of stamped) {
    const window = index.windows.get(position)!;
    // Two halvings, never a copy of the writes in the window: with a wide window on every reader of a
    // key that is written all along (a fan-out), a copy per reader cost the square of the log.
    const written = lowerBound(writes, window.start) < lowerBound(writes, window.end);
    const read = readOfValue(window, writeIdx ?? -1, nextWriteIdx, written);
    if (read !== false) readers.push({ position, ...(read !== true && { overlap: read }), ...how(position) });
  }
  return readers.sort((one, other) => one.position - other.position);
}

const BY_STEP = { step: true, view: false } as const;

/** Is `value` in the ascending list? */
function holds(ascending: number[], value: number): boolean {
  const at = lowerBound(ascending, value);
  return at < ascending.length && ascending[at] === value;
}

/** At least one read a forward answer lists is only possible: the key was written inside the reader's window. */
export function concurrentReadsNote(reads: number): HonestyNote {
  return {
    code: 'concurrent-write',
    detail:
      `${reads} read${reads === 1 ? ' was' : 's were'} made by a step that looked at state again after another ` +
      'step committed the key (steps side by side). Such a step may have read this value or another one ' +
      'written in that time, so it is a possible reader, not a certain one.',
  };
}

/**
 * LAW — an unknown key is NAMED as unknown; it never renders as "no history".
 *
 * The failure this prevents: `forwardSliceForKey(log, 'recipId')` (typo) must
 * not come back looking like a real variable that nothing happened to. The
 * answer says so out loud AND lists the keys the log does know — bounded, so
 * a 400-key agent state is a hint, not a wall.
 *
 * Why a NOTE and not a throw: the module's absence convention is a RESULT,
 * not an exception (`VariableSlice.missing`) — one absence vocabulary across
 * both doors. The loudness comes from the note + `missing: 'never-written'`,
 * not from a stack trace a triage tool would have to catch.
 */
export function unknownKeyNote(index: Pick<KeyIndex, 'knownKeys'>, key: string): HonestyNote {
  const all = [...index.knownKeys].sort();
  const shown = all.slice(0, KNOWN_KEYS_LISTED).map(shownPath);
  const more = all.length - shown.length;
  const known = shown.length > 0 ? `${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}` : '(none)';
  return {
    code: 'unknown-key',
    detail:
      `unknown key '${shownPath(key)}' — this commit log has no write and no recorded read of it. ` +
      `Known keys: ${known}. ` +
      'If the key is real, check that the commit log and the reads provider come from the SAME scope ' +
      '(a subflow has its own).',
  };
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

/** A write the answer rests on, or that a value's life crosses, merged into the key or appended to it. */
export function partialWriteNote(key: string, commits: readonly number[]): HonestyNote {
  const shown = commits.slice(0, NESTED_WRITES_LISTED);
  const more = commits.length - shown.length;
  const at = `commit${commits.length === 1 ? '' : 's'} ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`;
  return {
    code: 'partial-write',
    detail:
      `'${shownPath(key)}' was merged into or appended to at ${at} — such a write did not replace the value: ` +
      'it is made of that write and of the earlier ones, and a reader after it read all of them.',
  };
}

/** How many commit positions a `'nested-rows'` or a `'partial-write'` note lists before it says "+N more". */
export const NESTED_WRITES_LISTED = 5;

/** A write the answer rests on reached the key only through paths inside it. */
export function nestedRowsNote(key: string, commits: readonly number[]): HonestyNote {
  const shown = commits.slice(0, NESTED_WRITES_LISTED);
  const more = commits.length - shown.length;
  const at = `commit${commits.length === 1 ? '' : 's'} ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`;
  return {
    code: 'nested-rows',
    detail:
      `'${shownPath(key)}' was written only through paths inside it at ${at} — such a write changed part of ` +
      'its value, not the whole: earlier writes account for the rest (a walk back follows them), and a ' +
      'reader of the key may not have read the part it changed.',
  };
}

/** At least one read a backward slice follows has only possible sources: its key was written inside the reader's window. */
export function concurrentWriteNote(reads: number): HonestyNote {
  return {
    code: 'concurrent-write',
    detail:
      `${reads} read${reads === 1 ? ' was' : 's were'} made by a step that looked at state again after another ` +
      'step committed the same key (steps side by side). The record cannot say which value such a read saw, ' +
      'so every writer shown for that key is a possible source, not a certain one; the real source is among ' +
      'them, or is the value from before the run when the key is listed as read from there.',
  };
}

/** The value a backward slice explains holds, or lost the key under, the log's redaction placeholder. */
export function redactedValueNote(key: string): HonestyNote {
  return {
    code: 'redacted',
    detail:
      `'${shownPath(key)}' was redacted when it was written — where its value shows the log's placeholder (or ` +
      'the key is missing under a placeholder that replaced its container), the real value was never recorded.',
  };
}

/** No set or delete of the key, or of a container around it, is in range: the value rests on the pre-run state. */
export function fromInitialStateNote(key: string): HonestyNote {
  return {
    code: 'from-initial-state',
    detail:
      `'${shownPath(key)}' has no write of its whole value in range — its value rests on what it held before the ` +
      'run, which the commit log cannot see, so the writes here may be only part of it.',
  };
}

// ── Shared honesty notes (one sentence per code, one place) ───────────────
//
// LAW: every forward answer states what it could not see, in the SAME words
// whichever query produced it. Codes are what a consumer branches on; the
// detail is what a human or an LLM reads.

/** The `readTracking: 'off'` signature — see the HonestyNoteCode docs. */
export function readsNotRecordedNote(): HonestyNote {
  return {
    code: 'reads-not-recorded',
    detail:
      "reads were not recorded (readTracking may be 'off') — 'nothing read this value' is " +
      'UNKNOWABLE here, not true.',
  };
}

/** The value predates every write this log can see. */
export function preRunOriginNote(key: string): HonestyNote {
  return {
    code: 'pre-run-origin',
    detail:
      `'${shownPath(key)}' has no write before this point — the value came from initial state, frozen run input ` +
      '(args), or a closure. The reads listed did see it; who put it there is outside the commit log.',
  };
}

/** At least one fed edge rests on stage-level co-occurrence only. */
export function conservativeEdgesNote(key: string): HonestyNote {
  return {
    code: 'conservative-fed-edges',
    detail:
      "some 'fed' edges are CONSERVATIVE (stage-level): those writes carry no per-write read provenance, " +
      `so a stage that read '${shownPath(key)}' and wrote another key may not actually have used it. Run with ` +
      "writeProvenance: 'reads-prefix' to get exact edges.",
  };
}

/** A budget cut the walk — stated, never silent. */
export function truncatedNote(byDepth: boolean, byNodes: boolean): HonestyNote {
  const causes = [byDepth && 'maxDepth reached', byNodes && 'maxNodes reached'].filter(Boolean).join(', ');
  return {
    code: 'truncated',
    detail: `walk truncated (${causes}) — more consumers of this value exist beyond this horizon.`,
  };
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
