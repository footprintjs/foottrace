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
 * WHAT IT READS. Entries come back from storage unvalidated (a parsed file, a table scan) — untrusted
 * input — so it takes `Iterable<unknown>` and checks each one where it is read: the 9.18.0 law for
 * stored recordings, no cast at the seam. An entry it does not read into a log is never dropped in
 * silence: it is listed in `unread` with its position and the reason.
 *
 * THE LAWS IT KEEPS.
 *   1. Grouped by address. Every entry names its log (`logRunId` + `drillPath`); entries of many
 *      logs may arrive interleaved, and each log keeps its own entries in arrival order.
 *   2. A commit sits at its own index. `EventLog · record` stamps `bundle.idx` before the sink sees
 *      the bundle, so a commit lost on the way (a sink that failed once — the writer goes on) leaves a
 *      GAP at its index instead of shifting every commit after it; so does a bundle that is not a
 *      readable bundle. Every gap keeps its index, and the fold reports it (`skipped`) with the same
 *      reason the stored log gives (`gaps`). The FIRST commit entry read for an index stands; a later
 *      one for the same index (a redelivery, or a conflict) is not placed and is listed in `unread` —
 *      the reader never compares payloads, so no stored value is walked.
 *   3. Complete means the writer finished. A log is `complete` when a `closed` entry covers every
 *      stored commit (`closed.commits` is past the last index) — the latest such entry gives the
 *      `outcome`. A log that was closed and then went on (a later commit) is not complete until it is
 *      closed again. A closed log whose store lost commits is complete AND has gaps: the writer
 *      finished; the store did not keep everything (`closed.commits` makes even a lost LAST commit a
 *      gap).
 *   4. Opaque stays opaque. `meta` and a note's `kind` and `data` are handed back as stored, never
 *      read or merged.
 *   5. Read, never touched. Nothing here copies, freezes or edits the entries it is given — not the
 *      base, not `meta`: the stored log hands back their own values.
 *   6. Bounded work (see {@link StoredRecordLimits}). Every walk is a loop over the input, never a
 *      recursion; the work per entry is bounded by the address limits; the rows a log holds are its
 *      stored commits plus at most `missingCommits` gaps across the record; and reading stops after
 *      `entries` entries. Whatever a limit stops is listed in `unread` by name — never a hang, never a
 *      silent cut.
 *
 * DAG position: memory ← time-travel; this file is a reader beside `timeTravel` and imports only
 * record files.
 */

import { stageIdOf } from '../ids/runtimeStageId.js';
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
   * The entries this log was read from, in arrival order, as stored — the evidence the rest is read
   * from (each entry's `at`, every `closed` entry). An entry listed in `StoredRecord.unread` is not
   * here. A commit's bundle is the stored row: {@link gaps} names one that is not a readable bundle.
   */
  readonly entries: readonly RecordEntry[];
  /**
   * The log as `timeTravel` and `stateAt` read it: `{ commitLog, initialState?, subflowResults? }`. A
   * gap is a row the fold refuses with the same reason {@link gaps} gives (`skipped`), so a fold that
   * crosses one says so. `subflowResults` holds the run leg's mount logs — keyed by each mount's
   * runtimeStageId, the last segment of its `drillPath`; one flat map per leg, as a live snapshot's —
   * so the cursor marks those stops as mounts and `drill(mountRuntimeStageId)` opens the mount's own
   * stored log. The same object on every call.
   */
  source(): TimeTravelSource;
}

/** Every log a sink's entries hold, and every entry no log holds. */
export interface StoredRecord {
  /** Every log, keyed by its address as a JSON array — `["<logRunId>", ...drillPath]` — in first-arrival order. */
  readonly logs: ReadonlyMap<string, StoredLog>;
  /** The root log of the run leg `logRunId` (`drillPath: []`), or `undefined` when none was stored. */
  root(logRunId: string): StoredLog | undefined;
  /** The log at `address`, or `undefined` when none was stored. */
  log(address: LogAddress): StoredLog | undefined;
  /**
   * Entries not read into any log, by position in the input, with the reason — unreadable, past one of
   * the reader's limits, or a second commit entry for an index already held. In input order; empty
   * when every entry was read. A commit listed here leaves a gap at its index when its log has a later
   * commit or a close.
   */
  readonly unread: readonly { readonly index: number; readonly reason: string }[];
}

/**
 * The reader's limits — what bounds its work on untrusted input. Each defaults to the value below; a
 * caller that reads larger records raises it. Whatever a limit stops is listed in `unread` by name.
 */
export interface StoredRecordLimits {
  /** Entries read; past it, reading stops and one `unread` item says so. Default 16,777,216 (2^24). */
  readonly entries?: number;
  /**
   * Gaps held across the record — rows for commits the store does not have. A commit (or a close) that
   * would need more is unread. Default 1,048,576 (2^20). The other rows a log holds are its stored commits.
   */
  readonly missingCommits?: number;
  /** Segments in an address's `drillPath`. Default 1,024. */
  readonly drillDepth?: number;
  /** Characters in an address — its `logRunId` and `drillPath` segments together. Default 65,536. */
  readonly addressLength?: number;
}

/** The defaults — internal to the package; documented on {@link StoredRecordLimits}. */
export const DEFAULT_LIMITS: Required<StoredRecordLimits> = Object.freeze({
  entries: 2 ** 24,
  missingCommits: 2 ** 20,
  drillDepth: 1024,
  addressLength: 65_536,
});

/** The limits to read with: each a non-negative integer or `Infinity`, or a `RangeError` naming it. */
function limitsOf(given: StoredRecordLimits | undefined): Required<StoredRecordLimits> {
  if (given === undefined) return DEFAULT_LIMITS;
  const limits = { ...DEFAULT_LIMITS };
  for (const name of Object.keys(DEFAULT_LIMITS) as (keyof StoredRecordLimits)[]) {
    const value = given[name];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !(value === Infinity || (Number.isSafeInteger(value) && value >= 0))) {
      throw new RangeError(`readStoredRecord: limits.${name} must be a non-negative integer or Infinity`);
    }
    limits[name] = value;
  }
  return limits;
}

/** What an index holds when the record has no readable commit for it. */
const NO_COMMIT = absentRow('no readable commit entry for this index');

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

/** A position or a count: a non-negative safe integer. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Why `address` is not a log address the reader takes, or `undefined` when it is one. Bounded: the
 * drill path's length is checked before any segment is read, and the walk stops at the first segment
 * past the length limit.
 */
function addressRefusal(address: unknown, limits: Required<StoredRecordLimits>): string | undefined {
  if (!isPlainish(address)) return `address is ${described(address)}, not a log address`;
  const { logRunId, drillPath } = address;
  if (typeof logRunId !== 'string') return `address.logRunId is ${described(logRunId)}, not a string`;
  if (!Array.isArray(drillPath)) return 'address.drillPath is not an array of strings';
  if (drillPath.length > limits.drillDepth) {
    return `address.drillPath has ${drillPath.length} segments, past the reader's limit of ${limits.drillDepth}`;
  }
  let length = logRunId.length;
  for (let i = 0; i < drillPath.length && length <= limits.addressLength; i++) {
    const segment: unknown = drillPath[i];
    if (typeof segment !== 'string') return 'address.drillPath is not an array of strings';
    length += segment.length;
  }
  if (length > limits.addressLength) {
    return `address is longer than the reader's limit of ${limits.addressLength} characters`;
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
      return isCount(bundle.idx) ? undefined : `bundle.idx is ${described(bundle.idx)}, not a commit index`;
    }
    case 'note':
      if (typeof row.note !== 'string') return `note is ${described(row.note)}, not a string`;
      return isPlainish(row.data) ? undefined : `data is ${described(row.data)}, not a plain object`;
    default: {
      if (!LOG_OUTCOMES.includes(row.outcome as LogOutcome)) {
        return `outcome is ${described(row.outcome)}, not ${LOG_OUTCOMES.join(' | ')}`;
      }
      if (!isCount(row.commits)) return `commits is ${described(row.commits)}, not a commit count`;
      return metaRefusal(row.meta);
    }
  }
}

/** Why `row` cannot be read as a stored entry, or `undefined` when it can. */
function entryRefusal(row: unknown, limits: Required<StoredRecordLimits>): string | undefined {
  if (!isPlainish(row)) return `not an object (${row === null ? 'null' : Array.isArray(row) ? 'array' : typeof row})`;
  if (typeof row.kind !== 'string' || !KINDS.includes(row.kind)) {
    return `kind is ${described(row.kind)}, not ${KINDS.join(' | ')}`;
  }
  const address = addressRefusal(row.address, limits);
  if (address !== undefined) return address;
  if (typeof row.at !== 'number' || !Number.isFinite(row.at)) return `at is ${described(row.at)}, not a finite number`;
  return payloadRefusal(row);
}

/** The key a log is filed under: its address as a JSON array — one spelling per address, whatever the ids hold. */
function keyOf(logRunId: string, drillPath: readonly string[]): string {
  return JSON.stringify([logRunId, ...drillPath]);
}

type Opened = Extract<RecordEntry, { kind: 'opened' }>;
type Commit = Extract<RecordEntry, { kind: 'commit' }>;
type Closed = Extract<RecordEntry, { kind: 'closed' }>;

/** A read entry and its position in the input. */
interface Placed<E extends RecordEntry = RecordEntry> {
  readonly entry: E;
  readonly index: number;
}

/** An entry not read into a log, by position, and why. */
interface Unread {
  readonly index: number;
  readonly reason: string;
}

/** One log's entries, read: everything but `source`, which needs the whole record. */
interface ReadGroup {
  readonly address: LogAddress;
  readonly rows: readonly unknown[];
  readonly fields: Omit<StoredLog, 'address' | 'source'>;
}

/**
 * The longest prefix of a log the gap budget can hold: with `present` (the stored indices, ascending)
 * below it, a length `n` needs `n - (stored indices below n)` gaps. Returns the longest `n ≤ wanted`
 * whose gaps fit in `budget` — one pass over the stored indices.
 */
function lengthWithin(wanted: number, present: readonly number[], budget: number): number {
  for (let i = 0; i < present.length; i++) {
    // Below present[i] lie i stored indices and present[i] - i gaps: it fits while those gaps do.
    if (present[i] - i > budget) return Math.min(wanted, budget + i);
  }
  return Math.min(wanted, budget + present.length);
}

/**
 * Read one log's entries (arrival order) into its fields and its rows, spending the record's gap budget.
 * Returns the group and the entries it did not read, with why.
 */
function readGroup(
  address: LogAddress,
  placed: readonly Placed[],
  limits: Required<StoredRecordLimits>,
  budget: { missing: number },
): { group: ReadGroup; unread: Unread[] } {
  const unread: Unread[] = [];
  let opened: Placed<Opened> | undefined;
  const commits = new Map<number, Placed<Commit>>();
  const kept: Placed[] = [];
  for (const item of placed) {
    const { entry, index } = item;
    if (entry.kind === 'opened') {
      if (opened !== undefined) {
        if (opened.entry !== entry) {
          unread.push({ index, reason: `a second opened entry for this log — the one at ${opened.index} stands` });
        }
        continue;
      }
      opened = item as Placed<Opened>;
    } else if (entry.kind === 'commit') {
      const idx = entry.bundle.idx as number;
      const held = commits.get(idx);
      if (held !== undefined) {
        if (held.entry !== entry) {
          unread.push({ index, reason: `a second commit entry for index ${idx} — the one at ${held.index} stands` });
        }
        continue;
      }
      commits.set(idx, item as Placed<Commit>);
    }
    kept.push(item);
  }

  // The length the log asks for: past its last stored commit, or as long as its covering close says.
  const present = [...commits.keys()].sort((a, b) => a - b);
  const closes = kept.filter((item): item is Placed<Closed> => item.entry.kind === 'closed');
  const covering = (last: number) => {
    let closing: Placed<Closed> | undefined;
    for (const close of closes) if (close.entry.commits > last) closing = close;
    return closing;
  };
  const last = present.length > 0 ? present[present.length - 1] : -1;
  const wanted = covering(last)?.entry.commits ?? last + 1;

  // The gap budget cuts a log that asks for more rows than it can hold: what lies past the cut is unread.
  const fits = lengthWithin(wanted, present, budget.missing);
  const past = new Set<Placed>();
  if (fits < wanted) {
    const limit = `the reader's limit of ${limits.missingCommits} missing commits`;
    for (const [idx, item] of commits) {
      if (idx < fits) continue;
      past.add(item);
      commits.delete(idx);
      unread.push({ index: item.index, reason: `bundle.idx is ${idx}, past ${limit}` });
    }
    for (const close of closes) {
      if (close.entry.commits <= fits) continue;
      past.add(close);
      unread.push({ index: close.index, reason: `commits is ${close.entry.commits}, past ${limit}` });
    }
  }
  const inLog = past.size === 0 ? kept : kept.filter((item) => !past.has(item));
  const stillPresent = present.filter((idx) => idx < fits);
  const lastKept = stillPresent.length > 0 ? stillPresent[stillPresent.length - 1] : -1;
  let closing: Placed<Closed> | undefined;
  for (const item of inLog)
    if (item.entry.kind === 'closed' && item.entry.commits > lastKept) closing = item as Placed<Closed>;
  const length = closing ? closing.entry.commits : lastKept + 1;
  budget.missing -= length - stillPresent.length;

  const rows: unknown[] = [];
  for (let idx = 0; idx < length; idx++) rows.push(commits.get(idx)?.entry.bundle ?? NO_COMMIT);
  Object.freeze(rows);
  const { log, gaps } = readLog(rows);

  const notes: StoredNote[] = [];
  for (const { entry } of inLog) {
    if (entry.kind === 'note') notes.push(Object.freeze({ kind: entry.note, at: entry.at, data: entry.data }));
  }
  const meta: { opened?: Meta; closed?: Meta } = {};
  if (opened?.entry.meta !== undefined) meta.opened = opened.entry.meta;
  if (closing?.entry.meta !== undefined) meta.closed = closing.entry.meta;
  const fields: ReadGroup['fields'] = {
    ...(opened ? { initialState: opened.entry.initialState } : {}),
    commitLog: log,
    gaps,
    notes: Object.freeze(notes),
    complete: closing !== undefined,
    ...(closing ? { outcome: closing.entry.outcome } : {}),
    meta: Object.freeze(meta),
    entries: Object.freeze(inLog.map((item) => item.entry)),
  };
  return { group: { address, rows, fields }, unread };
}

/**
 * The mount logs of one run leg, as a live snapshot's `subflowResults` reads to the cursor: keyed by
 * each mount's runtimeStageId (the last segment of its drill path), ONE flat map for the whole leg —
 * so `drill` reaches a nested mount from any cursor of the leg. Built once per leg, in one pass.
 * `undefined` when the leg stored no mount log.
 */
function mountsOf(groups: readonly ReadGroup[]): Record<string, unknown> | undefined {
  let results: Record<string, unknown> | undefined;
  for (const group of groups) {
    const { drillPath } = group.address;
    if (drillPath.length === 0) continue;
    const mount = drillPath[drillPath.length - 1];
    // A null-prototype map: a stored drill segment is a key, never a prototype.
    results ??= Object.create(null) as Record<string, unknown>;
    const { initialState } = group.fields;
    results[mount] = Object.freeze({
      subflowId: stageIdOf(mount),
      treeContext: Object.freeze({ history: group.rows, ...(initialState ? { initialState } : {}) }),
    });
  }
  return results && Object.freeze(results);
}

/**
 * Read a sink's stored entries back into logs.
 *
 * Bounded on untrusted input: no recursion, no payload walk, work per entry bounded by the address
 * limits, at most `limits.missingCommits` gap rows across the record, and at most `limits.entries`
 * entries read — whatever a limit stops is listed in `unread` by name.
 *
 * @param entries What a `RecordSink` stored (`memorySink().entries`, or entries parsed back from a
 *   file or a table), in the order they were written — typed `unknown` because stored entries come
 *   back unvalidated; each is checked here.
 * @param limits Raise a default to read a larger record ({@link StoredRecordLimits}).
 * @returns Every log by address, the run-leg roots, and every entry not read into a log.
 * @throws RangeError when a limit is not a non-negative integer or `Infinity` — never for an entry.
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
export function readStoredRecord(entries: Iterable<unknown>, limits?: StoredRecordLimits): StoredRecord {
  const bounds = limitsOf(limits);
  const unread: Unread[] = [];
  const grouped = new Map<string, { address: LogAddress; placed: Placed[] }>();
  let index = 0;
  for (const row of entries) {
    if (index >= bounds.entries) {
      unread.push({ index, reason: `entries from here on are past the reader's limit of ${bounds.entries}; not read` });
      break;
    }
    const reason = entryRefusal(row, bounds);
    if (reason !== undefined) {
      unread.push({ index, reason });
    } else {
      const entry = row as RecordEntry;
      const { logRunId, drillPath } = entry.address;
      const key = keyOf(logRunId, drillPath);
      let group = grouped.get(key);
      if (group === undefined) {
        const address = Object.freeze({ logRunId, drillPath: Object.freeze([...drillPath]) });
        grouped.set(key, (group = { address, placed: [] }));
      }
      group.placed.push({ entry, index });
    }
    index++;
  }

  const budget = { missing: bounds.missingCommits };
  const groups: ReadGroup[] = [];
  for (const { address, placed } of grouped.values()) {
    const read = readGroup(address, placed, bounds, budget);
    groups.push(read.group);
    unread.push(...read.unread);
  }

  const legs = new Map<string, ReadGroup[]>();
  for (const group of groups) {
    const leg = legs.get(group.address.logRunId);
    if (leg === undefined) legs.set(group.address.logRunId, [group]);
    else leg.push(group);
  }
  const mountsByLeg = new Map<string, Record<string, unknown> | undefined>();
  const logs = new Map<string, StoredLog>();
  for (const group of groups) {
    const { logRunId } = group.address;
    const { initialState } = group.fields;
    let cached: TimeTravelSource | undefined;
    const log: StoredLog = Object.freeze({
      address: group.address,
      ...group.fields,
      source(): TimeTravelSource {
        if (cached === undefined) {
          if (!mountsByLeg.has(logRunId)) mountsByLeg.set(logRunId, mountsOf(legs.get(logRunId)!));
          const subflowResults = mountsByLeg.get(logRunId);
          cached = Object.freeze({
            commitLog: group.rows,
            ...(initialState ? { initialState } : {}),
            ...(subflowResults ? { subflowResults } : {}),
          });
        }
        return cached;
      },
    });
    logs.set(keyOf(logRunId, group.address.drillPath), log);
  }

  unread.sort((a, b) => a.index - b.index);
  return Object.freeze({
    logs,
    root: (logRunId: string) => (typeof logRunId === 'string' ? logs.get(keyOf(logRunId, [])) : undefined),
    log: (address: LogAddress) =>
      addressRefusal(address, bounds) === undefined ? logs.get(keyOf(address.logRunId, address.drillPath)) : undefined,
    unread: Object.freeze(unread.map((item) => Object.freeze({ index: item.index, reason: item.reason }))),
  });
}
