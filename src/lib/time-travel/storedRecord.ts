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
 *      reason the stored log gives (`gaps`). One place, one entry: the first READABLE commit entry
 *      for an index stands (a torn first delivery yields to a readable redelivery), the first
 *      `opened` stands, and every other entry for a place already held — a redelivery or a conflict,
 *      the very same object included — is listed in `unread`. Payloads are never compared, so no
 *      stored value is walked.
 *   3. Complete means the writer finished — and the reader read it all. A log is `complete` when a
 *      `closed` entry covers every stored commit (`closed.commits` is past the last index); the
 *      covering close with the largest `commits` gives the `outcome` and the length, so no loss an
 *      earlier close showed can hide behind a later one. A log that was closed and then went on (a
 *      later commit) is not complete until it is closed again. A closed log whose store lost commits
 *      is complete AND has gaps (`closed.commits` makes even a lost LAST commit a gap). A log a limit
 *      cut, and every log once reading stopped at the `entries` limit, is not complete: what the
 *      reader did not read could have gone on.
 *   4. Opaque stays opaque. `meta` and a note's `kind` and `data` are handed back as stored, never
 *      read or merged.
 *   5. Read, never touched. Nothing here copies, freezes or edits the entries it is given — not the
 *      base, not `meta`: the stored log hands back their own values.
 *   6. Bounded work (see {@link StoredRecordLimits}). Every walk is a loop over the input, never a
 *      recursion, and never through an input's own iterator except the input itself; the work per
 *      entry is bounded by the address limits; the rows a log holds are its stored commits plus gaps
 *      from ONE budget for the whole record, spent on the logs that need the fewest gaps first (so a
 *      corrupt log asking for the most is the one cut); and reading stops after `entries` entries. Whatever a
 *      limit stops is listed in `unread` by name — never a hang, never a silent cut.
 *
 * Entries are data. An entry whose fields throw while it is checked (a getter, a revoked proxy) is
 * listed in `unread`, and what the reader computes with — the kind, a commit's index and bundle, a
 * close's length — is taken once, as checked. An in-memory accessor that changes or throws on a later
 * read is out of contract, as everywhere in the record (docs/extraction.md): parsed JSON and structured
 * clones carry none.
 *
 * DAG position: memory ← time-travel; this file is a reader beside `timeTravel` and imports only
 * record files.
 */

import { stageIdOf } from '../ids/runtimeStageId.js';
import type { LogAddress } from '../memory/eventPosition.js';
import { LOG_OUTCOMES, type LogOutcome, type Meta, type RecordEntry } from '../memory/sink.js';
import type { CommitBundle } from '../memory/types.js';
import { absentRow, bundleRefusal, isPlainish, readLog } from './bundles.js';
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
   * before a causal query, which takes the bundles as they are; fold {@link source}, not this, so the
   * fold reports them.
   */
  readonly commitLog: readonly CommitBundle[];
  /** Every index of {@link commitLog} that holds no readable bundle, with why — empty when the log is whole. */
  readonly gaps: readonly LogGap[];
  /**
   * The notes, in arrival order. A store that delivers an entry twice as two copies repeats its note:
   * payloads are never compared (the very same object twice is listed in `unread` instead).
   */
  readonly notes: readonly StoredNote[];
  /**
   * `true` when a `closed` entry covers every stored commit and the reader read the log whole: the
   * writer said it ended. `false` for a log that never closed — a crashed run, or one still going —
   * for one that went on after its last close, and for one the reader did not read whole (a limit
   * cut it, or reading stopped at the `entries` limit — see `StoredRecord.unread`).
   */
  readonly complete: boolean;
  /** How the covering `closed` entry said the log ended; ABSENT while the log is not complete. */
  readonly outcome?: LogOutcome;
  /**
   * What the writer put on the `opened` entry and on the covering `closed` entry (present only while
   * the log is complete) — opaque, never merged.
   */
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
   * crosses one says so. `subflowResults` holds every stored mount log of the run leg — this one too,
   * when it is a mount — keyed by each mount's runtimeStageId (the last segment of its `drillPath`):
   * one flat map per leg, as a live snapshot's, so the cursor marks those stops as mounts and
   * `drill(mountRuntimeStageId)` opens the mount's own stored log. A mount log's head commit stamped
   * with its own mount id is its seed (it opens `start`, as on a live cursor). The same object on
   * every call.
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
   * Entries not read into any log, by position in the input, with the reason: an entry that could not
   * be read, one past a limit of the reader, or one for a place another entry holds (a second `opened`,
   * a second commit for an index, the same entry again). In input order; empty when every entry was
   * read. A commit that could not be read at all, or that a limit cut, leaves no row: its index is a
   * gap only when a later stored commit or a close reaches past it.
   */
  readonly unread: readonly { readonly index: number; readonly reason: string }[];
}

/**
 * The reader's limits — what bounds its work on untrusted input. Each defaults to the value below; a
 * caller that reads larger records raises it. Whatever a limit stops is listed in `unread` by name.
 */
export interface StoredRecordLimits {
  /**
   * Entries read; past it, reading stops, one `unread` item says so, and no log reads complete.
   * Default 16,777,216 (2^24).
   */
  readonly entries?: number;
  /**
   * Gaps held across the WHOLE record — rows for commits the store does not have — spent on the logs
   * that need the fewest first. A commit (or a close) that would need more is unread. Default
   * 1,048,576 (2^20). The other rows a log holds are its stored commits.
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
 * The address an entry names, as a fresh frozen copy — or why it is not one the reader takes. Bounded
 * and iterator-free: the drill path's length is read once and checked before any segment; segments are
 * read by index, checked and copied in one pass that stops at the first one past the length limit.
 */
function readAddress(address: unknown, limits: Required<StoredRecordLimits>): LogAddress | string {
  if (!isPlainish(address)) return `address is ${described(address)}, not a log address`;
  const { logRunId, drillPath } = address;
  if (typeof logRunId !== 'string') return `address.logRunId is ${described(logRunId)}, not a string`;
  if (!Array.isArray(drillPath)) return 'address.drillPath is not an array of strings';
  const depth = drillPath.length;
  if (depth > limits.drillDepth) {
    return `address.drillPath has ${depth} segments, past the reader's limit of ${limits.drillDepth}`;
  }
  const tooLong = `address is longer than the reader's limit of ${limits.addressLength} characters`;
  let length = logRunId.length;
  if (length > limits.addressLength) return tooLong;
  const segments: string[] = [];
  for (let i = 0; i < depth; i++) {
    const segment: unknown = drillPath[i];
    if (typeof segment !== 'string') return 'address.drillPath is not an array of strings';
    length += segment.length;
    if (length > limits.addressLength) return tooLong;
    segments.push(segment);
  }
  return Object.freeze({ logRunId, drillPath: Object.freeze(segments) });
}

/** Why an optional `meta` field cannot be read, or `undefined`. */
function metaRefusal(meta: unknown): string | undefined {
  return meta === undefined || isPlainish(meta) ? undefined : `meta is ${described(meta)}, not a plain object`;
}

/**
 * What the reader keeps of the fields only one kind carries — each field it computes with read ONCE
 * (a commit's bundle and index, a close's length) — or why they cannot be read.
 */
function payloadOf(
  row: Record<string, unknown>,
): { readonly count: number; readonly bundle?: Record<string, unknown> } | string {
  switch (row.kind) {
    case 'opened': {
      if (!isPlainish(row.initialState)) return `initialState is ${described(row.initialState)}, not a plain object`;
      return metaRefusal(row.meta) ?? { count: 0 };
    }
    case 'commit': {
      const bundle: unknown = row.bundle;
      if (!isPlainish(bundle)) return `bundle is ${described(bundle)}, not an object`;
      const idx: unknown = bundle.idx;
      return isCount(idx) ? { count: idx, bundle } : `bundle.idx is ${described(idx)}, not a commit index`;
    }
    case 'note':
      if (typeof row.note !== 'string') return `note is ${described(row.note)}, not a string`;
      return isPlainish(row.data) ? { count: 0 } : `data is ${described(row.data)}, not a plain object`;
    default: {
      if (!LOG_OUTCOMES.includes(row.outcome as LogOutcome)) {
        return `outcome is ${described(row.outcome)}, not ${LOG_OUTCOMES.join(' | ')}`;
      }
      const commits: unknown = row.commits;
      if (!isCount(commits)) return `commits is ${described(commits)}, not a commit count`;
      return metaRefusal(row.meta) ?? { count: commits };
    }
  }
}

/** An entry read: where it belongs, its position, and — for a commit — why its bundle is unreadable. */
interface Placed {
  readonly entry: RecordEntry;
  readonly index: number;
  /** The kind, as checked. */
  readonly kind: RecordEntry['kind'];
  /**
   * The number the reader computes with, as checked — a commit's `bundle.idx`, a close's `commits` —
   * taken once, so no later read of the entry can change what the gap budget spends.
   */
  readonly count: number;
  /** A commit's bundle, as checked. */
  readonly bundle?: unknown;
  /** A commit's bundle refusal, checked once while the entry was read; absent when it is readable. */
  readonly refusal?: string;
}

/** Read one stored entry, or say why not: what the reader keeps of it, and its address (the reader's own copy). */
function readEntry(
  row: unknown,
  index: number,
  limits: Required<StoredRecordLimits>,
): { readonly item: Placed; readonly address: LogAddress } | string {
  if (!isPlainish(row)) return `not an object (${row === null ? 'null' : Array.isArray(row) ? 'array' : typeof row})`;
  if (typeof row.kind !== 'string' || !KINDS.includes(row.kind)) {
    return `kind is ${described(row.kind)}, not ${KINDS.join(' | ')}`;
  }
  const address = readAddress(row.address, limits);
  if (typeof address === 'string') return address;
  if (typeof row.at !== 'number' || !Number.isFinite(row.at)) return `at is ${described(row.at)}, not a finite number`;
  const payload = payloadOf(row);
  if (typeof payload === 'string') return payload;
  const entry = row as RecordEntry;
  const kind = row.kind as RecordEntry['kind'];
  const { count, bundle } = payload;
  if (bundle === undefined) return { item: { entry, index, kind, count }, address };
  const refusal = bundleRefusal(bundle);
  const item: Placed =
    refusal === undefined ? { entry, index, kind, count, bundle } : { entry, index, kind, count, bundle, refusal };
  return { item, address };
}

/** The key a log is filed under: its address as a JSON array — one spelling per address, whatever the ids hold. */
function keyOf(logRunId: string, drillPath: readonly string[]): string {
  return JSON.stringify([logRunId, ...drillPath]);
}

type Closed = Extract<RecordEntry, { kind: 'closed' }>;

/** An entry not read into a log, by position, and why. */
interface Unread {
  readonly index: number;
  readonly reason: string;
}

/** The close that covers `last`: the one with the largest `commits` past it (the latest of equals). */
function coveringClose(closes: readonly Placed[], last: number): Placed | undefined {
  let best: Placed | undefined;
  for (const close of closes) {
    if (close.count > last && (best === undefined || close.count >= best.count)) best = close;
  }
  return best;
}

/** One log's entries after one place, one entry: what it holds before the gap budget is spent. */
interface Grouped {
  readonly key: string;
  readonly address: LogAddress;
  readonly arrival: number;
  readonly placed: readonly Placed[];
  readonly opened: Placed | undefined;
  readonly commits: Map<number, Placed>;
  readonly closes: readonly Placed[];
  /** Entries for a place another holds — not in the log. */
  readonly dropped: ReadonlySet<Placed>;
  /** The stored commit indices, ascending. */
  readonly present: readonly number[];
  /** The length the log asks for: as long as its covering close says, or past its last stored commit. */
  readonly wanted: number;
}

/** One place, one entry: the first readable commit for an index, the first opened. The rest is unread. */
function groupOf(
  key: string,
  address: LogAddress,
  arrival: number,
  placed: readonly Placed[],
  unread: Unread[],
): Grouped {
  let opened: Placed | undefined;
  const commits = new Map<number, Placed>();
  const closes: Placed[] = [];
  const dropped = new Set<Placed>();
  for (const item of placed) {
    if (item.kind === 'opened') {
      if (opened === undefined) opened = item;
      else {
        dropped.add(item);
        unread.push({
          index: item.index,
          reason: `a second opened entry for this log — the one at ${opened.index} stands`,
        });
      }
    } else if (item.kind === 'commit') {
      const held = commits.get(item.count);
      if (held === undefined) commits.set(item.count, item);
      else if (held.refusal !== undefined && item.refusal === undefined) {
        // A torn first delivery yields to a readable redelivery.
        commits.set(item.count, item);
        dropped.add(held);
      } else dropped.add(item);
    } else if (item.kind === 'closed') closes.push(item);
  }
  // Each commit entry not placed is named against the entry that holds its index in the end.
  for (const item of dropped) {
    if (item.kind !== 'commit') continue;
    const holder = commits.get(item.count)!;
    const reason =
      item.refusal !== undefined && holder.refusal === undefined
        ? `an unreadable commit entry for index ${item.count} — the readable one at ${holder.index} stands`
        : `a second commit entry for index ${item.count} — the one at ${holder.index} stands`;
    unread.push({ index: item.index, reason });
  }
  const present = [...commits.keys()].sort((a, b) => a - b);
  const last = present.length > 0 ? present[present.length - 1] : -1;
  const close = coveringClose(closes, last);
  const wanted = close !== undefined ? close.count : last + 1;
  return { key, address, arrival, placed, opened, commits, closes, dropped, present, wanted };
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

/** One log's entries, read: everything but `source`, which needs the whole record. */
interface ReadGroup {
  readonly key: string;
  readonly address: LogAddress;
  readonly rows: readonly unknown[];
  readonly fields: Omit<StoredLog, 'address' | 'source'>;
}

/**
 * Spend the record's gap budget on one log and read it: a log that asks for more rows than the budget
 * holds is cut — what lies past the cut is unread, by name, and the log is not complete.
 */
function readGroup(
  group: Grouped,
  limits: Required<StoredRecordLimits>,
  budget: { missing: number },
  stopped: boolean,
  unread: Unread[],
): ReadGroup {
  const { commits, closes, present, wanted } = group;
  const left = budget.missing;
  const fits = lengthWithin(wanted, present, left);
  const past = new Set<Placed>();
  if (fits < wanted) {
    const limit = `the reader's limit of ${limits.missingCommits} missing commits for the record (${left} were left for this log)`;
    for (const [idx, item] of commits) {
      if (idx < fits) continue;
      past.add(item);
      commits.delete(idx);
      unread.push({ index: item.index, reason: `bundle.idx is ${idx}, past ${limit}` });
    }
    for (const close of closes) {
      const count = close.count;
      if (count <= fits) continue;
      past.add(close);
      unread.push({ index: close.index, reason: `commits is ${count}, past ${limit}` });
    }
  }
  const stillPresent = past.size === 0 ? present : present.filter((idx) => idx < fits);
  const lastKept = stillPresent.length > 0 ? stillPresent[stillPresent.length - 1] : -1;
  const closing = coveringClose(past.size === 0 ? closes : closes.filter((close) => !past.has(close)), lastKept);
  const length = closing !== undefined ? closing.count : lastKept + 1;
  budget.missing -= length - stillPresent.length;

  const rows: unknown[] = [];
  for (let idx = 0; idx < length; idx++) {
    const item = commits.get(idx);
    if (item === undefined) rows.push(NO_COMMIT);
    else if (item.refusal !== undefined) rows.push(absentRow(item.refusal));
    else rows.push(item.bundle);
  }
  Object.freeze(rows);
  const { log, gaps } = readLog(rows);

  const inLog: RecordEntry[] = [];
  const notes: StoredNote[] = [];
  for (const item of group.placed) {
    if (group.dropped.has(item) || past.has(item)) continue;
    inLog.push(item.entry);
    if (item.entry.kind === 'note') {
      notes.push(Object.freeze({ kind: item.entry.note, at: item.entry.at, data: item.entry.data }));
    }
  }
  // Complete only when the writer closed it AND the reader read it whole.
  const ended = closing !== undefined && past.size === 0 && !stopped ? (closing.entry as Closed) : undefined;
  const opened = group.opened?.entry as Extract<RecordEntry, { kind: 'opened' }> | undefined;
  const meta: { opened?: Meta; closed?: Meta } = {};
  if (opened?.meta !== undefined) meta.opened = opened.meta;
  if (ended?.meta !== undefined) meta.closed = ended.meta;
  return {
    key: group.key,
    address: group.address,
    rows,
    fields: {
      ...(opened ? { initialState: opened.initialState } : {}),
      commitLog: Object.freeze(log),
      gaps,
      notes: Object.freeze(notes),
      complete: ended !== undefined,
      ...(ended ? { outcome: ended.outcome } : {}),
      meta: Object.freeze(meta),
      entries: Object.freeze(inLog),
    },
  };
}

/**
 * The mount logs of one run leg, as a live snapshot's `subflowResults` reads to the cursor: keyed by
 * each mount's runtimeStageId (the last segment of its drill path), ONE flat map for the whole leg —
 * so `drill` reaches a nested mount from any cursor of the leg. Built once per leg, in one pass; the
 * first log stored for a mount id holds it. `undefined` when the leg stored no mount log.
 */
function mountsOf(groups: readonly ReadGroup[]): Record<string, unknown> | undefined {
  let results: Record<string, unknown> | undefined;
  for (const group of groups) {
    const { drillPath } = group.address;
    if (drillPath.length === 0) continue;
    const mount = drillPath[drillPath.length - 1];
    // A null-prototype map: a stored drill segment is a key, never a prototype.
    results ??= Object.create(null) as Record<string, unknown>;
    if (results[mount] !== undefined) continue;
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
 * @throws RangeError when a limit is not a non-negative integer or `Infinity`; TypeError when
 *   `entries` is not iterable; whatever the input's own iterator throws. Never for an entry that is
 *   data (parsed JSON, a structured clone).
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
  const byKey = new Map<string, { address: LogAddress; placed: Placed[] }>();
  const seen = new Map<object, number>();
  let stopped = false;
  let index = 0;
  for (const row of entries) {
    if (index >= bounds.entries) {
      stopped = true;
      unread.push({ index, reason: `entries from here on are past the reader's limit of ${bounds.entries}; not read` });
      break;
    }
    let read: { readonly item: Placed; readonly address: LogAddress } | string;
    try {
      read = readEntry(row, index, bounds);
    } catch {
      read = 'the entry threw when it was read';
    }
    if (typeof read === 'string') {
      unread.push({ index, reason: read });
    } else if (seen.has(row as object)) {
      unread.push({ index, reason: `the same entry as at ${seen.get(row as object)}` });
    } else {
      seen.set(row as object, index);
      // One address per log: an entry's own copy is kept only by the first entry of its log.
      const key = keyOf(read.address.logRunId, read.address.drillPath);
      const log = byKey.get(key);
      if (log === undefined) byKey.set(key, { address: read.address, placed: [read.item] });
      else log.placed.push(read.item);
    }
    index++;
  }

  // Group, then spend the gap budget on the logs that need the fewest gaps first.
  let arrival = 0;
  const grouped: Grouped[] = [];
  for (const [key, { address, placed }] of byKey) grouped.push(groupOf(key, address, arrival++, placed, unread));
  const byNeed = [...grouped].sort(
    (a, b) => a.wanted - a.present.length - (b.wanted - b.present.length) || a.arrival - b.arrival,
  );
  const budget = { missing: bounds.missingCommits };
  const read = new Map<Grouped, ReadGroup>();
  for (const group of byNeed) read.set(group, readGroup(group, bounds, budget, stopped, unread));
  const groups = grouped.map((group) => read.get(group)!);

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
    logs.set(group.key, log);
  }

  unread.sort((a, b) => a.index - b.index);
  return Object.freeze({
    logs,
    root: (logRunId: string) => (typeof logRunId === 'string' ? logs.get(keyOf(logRunId, [])) : undefined),
    log: (address: LogAddress) => {
      const own = readAddress(address, bounds);
      return typeof own === 'string' ? undefined : logs.get(keyOf(own.logRunId, own.drillPath));
    },
    unread: Object.freeze(unread.map((item) => Object.freeze({ index: item.index, reason: item.reason }))),
  });
}
