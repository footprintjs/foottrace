/**
 * storedRecord.ts — reading back what a sink stored (1.1.0).
 *
 * WHY THIS FILE EXISTS. A log that writes to a `RecordSink` (`foottrace/write`) leaves its record in
 * storage AS IT LANDS: an `opened` entry with the fold base, one `commit` entry per bundle, `note`
 * entries, and a `closed` entry with how the log ended. A run that is killed never writes its
 * `closed` entry. This reader turns stored entries back into logs a person or a model can read —
 * and says, before any fold, which of them never finished (`complete: false`) and what each one is
 * missing.
 *
 * WHAT IT READS. Entries come back from storage unvalidated (a parsed file, a table scan), so it
 * takes `Iterable<unknown>` and checks each one where it is read — the 9.18.0 law for stored
 * recordings: no cast at the seam. An entry it cannot read (not an object, no known kind, no
 * address, a commit whose bundle carries no index …) is not dropped in silence: it is listed in
 * `unread` with its position and the reason.
 *
 * THE LAWS IT KEEPS.
 *   1. Grouped by address. Every entry names its log (`logRunId` + `drillPath`); entries of many
 *      logs may arrive interleaved, and each log keeps its own entries in arrival order.
 *   2. A commit sits at its own index. `EventLog · record` stamps `bundle.idx` before the sink sees
 *      the bundle, so a commit lost on the way (a sink that failed once — the writer goes on) leaves a
 *      GAP at its index instead of shifting every commit after it. The same holds for two stored
 *      commits that disagree about one index, and for a bundle that is not a readable bundle. Every
 *      gap keeps its index, and the fold reports it (`skipped`) with the same reason the stored log
 *      gives (`gaps`).
 *   3. Complete means the writer finished. A log is `complete` when a `closed` entry covers every
 *      stored commit (`closed.commits` is past the last index) — the latest such entry gives the
 *      `outcome`. A log that was closed and then went on (a later commit) is not complete until it is
 *      closed again. A closed log whose store lost commits is complete AND has gaps: the writer
 *      finished; the store did not keep everything (`closed.commits` makes even a lost LAST commit a
 *      gap).
 *   4. Opaque stays opaque. `meta` and a note's `kind` and `data` are handed back as stored, never
 *      read or merged.
 *   5. Read, never touched. Nothing here copies, freezes or edits the entries it is given: the stored
 *      log hands back their own values — read them, do not edit them.
 *
 * DAG position: memory ← time-travel; this file is a reader beside `timeTravel` and imports only
 * record files.
 */

import { stageIdOf } from '../ids/runtimeStageId.js';
import { deepEqual } from '../memory/equality.js';
import type { LogAddress } from '../memory/eventPosition.js';
import { LOG_OUTCOMES, type LogOutcome, type Meta, type RecordEntry } from '../memory/sink.js';
import type { CommitBundle } from '../memory/types.js';
import { absentRow, isPlainish, readLog } from './bundles.js';
import type { LogGap, TimeTravelSource } from './types.js';

/** A note the writer kept beside a log (`EventLog · note`), as stored. */
export interface StoredNote {
  /** The note's kind, as the writer named it. */
  readonly kind: string;
  /** When it was written (epoch ms). */
  readonly at: number;
  /** What the writer put in it — opaque. */
  readonly data: Meta;
}

/** One log read back from a sink's entries. */
export interface StoredLog {
  /** Which log this is: the run leg that owned it and the mounts it sits under (root: `drillPath: []`). */
  readonly address: LogAddress;
  /** The fold base the `opened` entry carried; ABSENT when no readable `opened` entry was stored. */
  readonly initialState?: Record<string, unknown>;
  /**
   * The bundles, each at its own index (`bundle.idx`). An index with no readable bundle holds an empty
   * stand-in (it belongs to no stage and carries nothing) and is named in {@link gaps} — check `gaps`
   * before a causal query, which takes the bundles as they are.
   */
  readonly commitLog: readonly CommitBundle[];
  /** Every index of {@link commitLog} that holds no readable bundle, with why — empty when the log is whole. */
  readonly gaps: readonly LogGap[];
  /** The notes, in arrival order. */
  readonly notes: readonly StoredNote[];
  /**
   * `true` when a `closed` entry covers every stored commit: the writer said it ended. `false` for a
   * log that never closed — a crashed run, or one still going — and for one that went on after its
   * last close.
   */
  readonly complete: boolean;
  /** How the covering `closed` entry said the log ended; ABSENT while the log is not complete. */
  readonly outcome?: LogOutcome;
  /** What the writer put on the `opened` entry and on the covering `closed` entry — opaque, never merged. */
  readonly meta: { readonly opened?: Meta; readonly closed?: Meta };
  /**
   * This log's entries in arrival order, as stored — the evidence the rest is read from (each entry's
   * `at`, every `closed` entry). A commit's bundle is the stored row: {@link gaps} names one that is not
   * a readable bundle.
   */
  readonly entries: readonly RecordEntry[];
  /**
   * The log as `timeTravel` and `stateAt` read it: `{ commitLog, initialState?, subflowResults? }`. A
   * gap is a row the fold refuses with the same reason {@link gaps} gives (`skipped`), so a fold that
   * crosses one says so. `subflowResults` holds the logs stored under this one — keyed by each mount's
   * runtimeStageId, the last segment of its `drillPath` — so the cursor marks those stops as mounts and
   * `drill(mountRuntimeStageId)` opens the mount's own stored log. The same object on every call.
   */
  source(): TimeTravelSource;
}

/** Every log a sink's entries hold, and every entry no log could hold. */
export interface StoredRecord {
  /** Every log, keyed by its address as a JSON array — `["<logRunId>", ...drillPath]` — in first-arrival order. */
  readonly logs: ReadonlyMap<string, StoredLog>;
  /** The root log of the run leg `logRunId` (`drillPath: []`), or `undefined` when none was stored. */
  root(logRunId: string): StoredLog | undefined;
  /** The log at `address`, or `undefined` when none was stored. */
  log(address: LogAddress): StoredLog | undefined;
  /**
   * Entries that could not be read, by position in the input, with the reason. Empty when every entry
   * was read. An unread commit also leaves a gap at its index, when its log has later commits or a close.
   */
  readonly unread: readonly { readonly index: number; readonly reason: string }[];
}

/**
 * The reader's budget: a stored log holds at most 2^24 commits. A commit index or a close's `commits`
 * past it is unread — so one corrupted index cannot make the reader allocate without bound.
 */
const MAX_LOG_LENGTH = 2 ** 24;

/** What an index holds when the record has no commit for it, or two that disagree. */
const NO_COMMIT = absentRow('no readable commit entry for this index');
const DISAGREEING_COMMITS = absentRow('commit entries for this index disagree');

const KINDS: readonly string[] = ['opened', 'commit', 'note', 'closed'];

/** A value as a reason names it: `missing`, `null`, `an array`, a short quoted string, a number, or `a <type>`. */
function described(value: unknown): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  if (typeof value === 'number') return String(value);
  return `a ${typeof value}`;
}

/** A position or a count: a non-negative safe integer inside the reader's budget. */
function isCount(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

/** Why `address` is not a log address, or `undefined` when it is one. */
function addressRefusal(address: unknown): string | undefined {
  if (!isPlainish(address)) return `address is ${described(address)}, not a log address`;
  if (typeof address.logRunId !== 'string') return `address.logRunId is ${described(address.logRunId)}, not a string`;
  const { drillPath } = address;
  if (!Array.isArray(drillPath) || !drillPath.every((segment) => typeof segment === 'string')) {
    return 'address.drillPath is not an array of strings';
  }
  return undefined;
}

/** Why an optional `meta` field cannot be read, or `undefined`. */
function metaRefusal(meta: unknown): string | undefined {
  return meta === undefined || isPlainish(meta) ? undefined : `meta is ${described(meta)}, not a plain object`;
}

/** Why the fields only one kind carries cannot be read, or `undefined`. */
function payloadRefusal(row: Record<string, unknown>): string | undefined {
  switch (row.kind) {
    case 'opened':
      if (!isPlainish(row.initialState)) return `initialState is ${described(row.initialState)}, not a plain object`;
      return metaRefusal(row.meta);
    case 'commit': {
      const bundle = row.bundle;
      if (!isPlainish(bundle)) return `bundle is ${described(bundle)}, not an object`;
      if (!isCount(bundle.idx, MAX_LOG_LENGTH - 1)) {
        return `bundle.idx is ${described(bundle.idx)}, not a commit index below ${MAX_LOG_LENGTH}`;
      }
      return undefined;
    }
    case 'note':
      if (typeof row.note !== 'string') return `note is ${described(row.note)}, not a string`;
      return isPlainish(row.data) ? undefined : `data is ${described(row.data)}, not a plain object`;
    default: {
      if (!LOG_OUTCOMES.includes(row.outcome as LogOutcome)) {
        return `outcome is ${described(row.outcome)}, not ${LOG_OUTCOMES.join(' | ')}`;
      }
      if (!isCount(row.commits, MAX_LOG_LENGTH)) {
        return `commits is ${described(row.commits)}, not a commit count up to ${MAX_LOG_LENGTH}`;
      }
      return metaRefusal(row.meta);
    }
  }
}

/** Why `row` cannot be read as a stored entry, or `undefined` when it can. */
function entryRefusal(row: unknown): string | undefined {
  if (!isPlainish(row)) return `not an object (${row === null ? 'null' : Array.isArray(row) ? 'array' : typeof row})`;
  if (typeof row.kind !== 'string' || !KINDS.includes(row.kind)) {
    return `kind is ${described(row.kind)}, not ${KINDS.join(' | ')}`;
  }
  const address = addressRefusal(row.address);
  if (address !== undefined) return address;
  if (typeof row.at !== 'number' || !Number.isFinite(row.at)) return `at is ${described(row.at)}, not a finite number`;
  return payloadRefusal(row);
}

/** The key a log is filed under: its address as a JSON array — one spelling per address, whatever the ids hold. */
function keyOf(logRunId: string, drillPath: readonly string[]): string {
  return JSON.stringify([logRunId, ...drillPath]);
}

type Opened = Extract<RecordEntry, { kind: 'opened' }>;
type Closed = Extract<RecordEntry, { kind: 'closed' }>;

/** One log's entries, read: everything but `source`, which needs the whole record. */
interface ReadGroup {
  readonly address: LogAddress;
  readonly rows: readonly unknown[];
  readonly fields: Omit<StoredLog, 'address' | 'source'>;
}

/** Each stored commit, by index: the bundle, or the mark that two stored commits disagree. */
function commitsByIndex(entries: readonly RecordEntry[]): Map<number, unknown> {
  const byIndex = new Map<number, unknown>();
  for (const entry of entries) {
    if (entry.kind !== 'commit') continue;
    const idx = entry.bundle.idx as number;
    if (!byIndex.has(idx)) byIndex.set(idx, entry.bundle);
    else if (!deepEqual(byIndex.get(idx), entry.bundle, 'copies')) byIndex.set(idx, DISAGREEING_COMMITS);
  }
  return byIndex;
}

/** Read one log's entries (arrival order) into its fields and its rows. */
function readGroup(address: LogAddress, entries: readonly RecordEntry[]): ReadGroup {
  const byIndex = commitsByIndex(entries);
  let last = -1;
  for (const idx of byIndex.keys()) if (idx > last) last = idx;
  let opened: Opened | undefined;
  let closing: Closed | undefined;
  const notes: StoredNote[] = [];
  for (const entry of entries) {
    if (entry.kind === 'opened') opened ??= entry;
    else if (entry.kind === 'note') notes.push(Object.freeze({ kind: entry.note, at: entry.at, data: entry.data }));
    // The latest close that covers every stored commit; a close the log went on past covers nothing.
    else if (entry.kind === 'closed' && entry.commits > last) closing = entry;
  }
  const length = closing ? closing.commits : last + 1;
  const rows: unknown[] = [];
  for (let idx = 0; idx < length; idx++) rows.push(byIndex.has(idx) ? byIndex.get(idx) : NO_COMMIT);
  Object.freeze(rows);
  const { log, gaps } = readLog(rows);

  const meta: { opened?: Meta; closed?: Meta } = {};
  if (opened?.meta !== undefined) meta.opened = opened.meta;
  if (closing?.meta !== undefined) meta.closed = closing.meta;
  return {
    address,
    rows,
    fields: {
      ...(opened ? { initialState: opened.initialState } : {}),
      commitLog: log,
      gaps,
      notes: Object.freeze(notes),
      complete: closing !== undefined,
      ...(closing ? { outcome: closing.outcome } : {}),
      meta: Object.freeze(meta),
      entries: Object.freeze([...entries]),
    },
  };
}

/**
 * Every log stored UNDER another, filed under each of its ancestors' keys (same run leg, a strict
 * prefix of its drill path) — one pass over the record, however many logs ask.
 */
function logsUnderEachAddress(groups: readonly ReadGroup[]): Map<string, ReadGroup[]> {
  const under = new Map<string, ReadGroup[]>();
  for (const group of groups) {
    const { logRunId, drillPath } = group.address;
    for (let depth = 0; depth < drillPath.length; depth++) {
      const key = keyOf(logRunId, drillPath.slice(0, depth));
      let held = under.get(key);
      if (held === undefined) under.set(key, (held = []));
      held.push(group);
    }
  }
  return under;
}

/**
 * The logs stored under one, as a snapshot's `subflowResults` reads to the cursor: keyed by each
 * mount's runtimeStageId (the last segment of its drill path), flat over every depth — the shape the
 * live snapshot has, so `drill` reaches a nested mount from its parent's cursor. `undefined` when none.
 */
function storedMounts(nested: readonly ReadGroup[] | undefined): Record<string, unknown> | undefined {
  if (nested === undefined) return undefined;
  // A null-prototype map: a stored drill segment is a key, never a prototype.
  const results = Object.create(null) as Record<string, unknown>;
  for (const group of nested) {
    const mount = group.address.drillPath[group.address.drillPath.length - 1];
    const { initialState } = group.fields;
    results[mount] = Object.freeze({
      subflowId: stageIdOf(mount),
      treeContext: Object.freeze({ history: group.rows, ...(initialState ? { initialState } : {}) }),
    });
  }
  return Object.freeze(results);
}

/**
 * Read a sink's stored entries back into logs.
 *
 * @param entries What a `RecordSink` stored (`memorySink().entries`, or entries parsed back from a
 *   file or a table), in the order they were written — typed `unknown` because stored entries come
 *   back unvalidated; each is checked here.
 * @returns Every log by address, the run-leg roots, and every entry that could not be read.
 *
 * @example
 * ```typescript
 * import { readStoredRecord, stateAt, timeTravel } from 'foottrace';
 *
 * const stored = readStoredRecord(entries);       // e.g. JSON lines read back after a crash
 * const run = stored.root('run-1');
 * run?.complete;                                   // false — it never closed
 * run?.notes.map((n) => n.kind);                   // ['attempt', 'attempt'] — kept as they happened
 * timeTravel(run!.source()).last();                // the cursor over what landed
 * stateAt(run!.source(), run!.commitLog.length - 1).skipped; // a lost commit, by index and reason
 * ```
 */
export function readStoredRecord(entries: Iterable<unknown>): StoredRecord {
  const unread: { readonly index: number; readonly reason: string }[] = [];
  const grouped = new Map<string, { address: LogAddress; entries: RecordEntry[] }>();
  let index = 0;
  for (const row of entries) {
    const reason = entryRefusal(row);
    if (reason !== undefined) {
      unread.push(Object.freeze({ index, reason }));
    } else {
      const entry = row as RecordEntry;
      const { logRunId, drillPath } = entry.address;
      const key = keyOf(logRunId, drillPath);
      let group = grouped.get(key);
      if (group === undefined) {
        const address = Object.freeze({ logRunId, drillPath: Object.freeze([...drillPath]) });
        grouped.set(key, (group = { address, entries: [] }));
      }
      group.entries.push(entry);
    }
    index++;
  }

  const groups = [...grouped.values()].map((group) => readGroup(group.address, group.entries));
  let nestedUnder: Map<string, ReadGroup[]> | undefined;
  const logs = new Map<string, StoredLog>();
  for (const group of groups) {
    const key = keyOf(group.address.logRunId, group.address.drillPath);
    const { initialState } = group.fields;
    let cached: TimeTravelSource | undefined;
    const log: StoredLog = Object.freeze({
      address: group.address,
      ...group.fields,
      source(): TimeTravelSource {
        if (cached === undefined) {
          nestedUnder ??= logsUnderEachAddress(groups);
          const subflowResults = storedMounts(nestedUnder.get(key));
          cached = Object.freeze({
            commitLog: group.rows,
            ...(initialState ? { initialState } : {}),
            ...(subflowResults ? { subflowResults } : {}),
          });
        }
        return cached;
      },
    });
    logs.set(key, log);
  }

  return Object.freeze({
    logs,
    root: (logRunId: string) => (typeof logRunId === 'string' ? logs.get(keyOf(logRunId, [])) : undefined),
    log: (address: LogAddress) =>
      addressRefusal(address) === undefined ? logs.get(keyOf(address.logRunId, address.drillPath)) : undefined,
    unread: Object.freeze(unread),
  });
}
