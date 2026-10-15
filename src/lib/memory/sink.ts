/**
 * sink.ts — the record's sink port: where a log's entries go AS THEY LAND, so a run that never ends
 * still leaves its record behind.
 *
 * A log that is given a sink (`new EventLog(base, { sink, address })`) hands it four kinds of entry,
 * each stamped with the log's address and the time it was written (`at`, epoch ms):
 *
 *   - `opened` — once, from the constructor: the fold base (`initialState`, the sink's own copy);
 *   - `commit` — per `record()`, AFTER the bundle is frozen: the log's own bundle, as served;
 *   - `note`   — per `note(kind, data)`: something the writer wants kept beside the log, as it happens;
 *   - `closed` — per `close(outcome)`: how the log ended, and how many commits it held then (`commits`).
 *
 * These are RECORD facts. What the writer means by them rides `meta` (on `opened` / `closed`) and a
 * note's `kind` and `data`: opaque here — stored and handed back, never read or interpreted. Nothing in
 * this file names an engine.
 *
 * THE STORED FORM. A sink stores each entry as a {@link RecordEntry}: the method's entry plus the
 * method's name as `kind`. A note's own kind cannot also be called `kind`, so it is stored as `note`.
 * `memorySink` is the reference adapter; `readStoredRecord` (`foottrace`) reads the entries back.
 *
 * @example
 * ```typescript
 * import { EventLog, memorySink } from 'foottrace/write';
 * import { readStoredRecord } from 'foottrace';
 *
 * const sink = memorySink();
 * const log = new EventLog({ count: 0 }, { sink, address: { logRunId: 'run-1', drillPath: [] } });
 * log.note('attempt', { attempt: 1, outcome: 'failed' });
 * // … the process dies here: no `closed` entry …
 * readStoredRecord(sink.entries).root('run-1')?.complete; // false — and its note is still there
 * ```
 */

import { deepFreeze } from '../capture/freeze.js';
import type { LogAddress } from './eventPosition.js';
import type { CommitBundle } from './types.js';

/**
 * What a writer puts beside the record — on a log's `opened` / `closed` entry, or as a note's data.
 * A plain object that survives `structuredClone`; opaque to foottrace: stored and returned, never read.
 */
export type Meta = Readonly<Record<string, unknown>>;

/** How a log's writer said it ended. A pause ends this log; it is not a failure. */
export type LogOutcome = 'ok' | 'failed' | 'paused';

/** The outcomes a `closed` entry may carry, in one place for the writer's and the reader's checks. */
export const LOG_OUTCOMES: readonly LogOutcome[] = /* @__PURE__ */ Object.freeze(['ok', 'failed', 'paused']);

/**
 * One stored entry: what a sink keeps per call, discriminated by `kind` (the method that received it).
 * A note's own kind is stored as `note`.
 */
export type RecordEntry =
  | {
      readonly kind: 'opened';
      readonly address: LogAddress;
      readonly at: number;
      /** The fold base — the state before the log's first commit. */
      readonly initialState: Record<string, unknown>;
      readonly meta?: Meta;
    }
  | {
      readonly kind: 'commit';
      readonly address: LogAddress;
      readonly at: number;
      /** The log's own bundle, frozen, its position stamped as `idx`. */
      readonly bundle: CommitBundle;
    }
  | {
      readonly kind: 'note';
      readonly address: LogAddress;
      readonly at: number;
      /** The note's own kind, as the writer named it (`note('attempt', …)` → `'attempt'`). */
      readonly note: string;
      readonly data: Meta;
    }
  | {
      readonly kind: 'closed';
      readonly address: LogAddress;
      readonly at: number;
      readonly outcome: LogOutcome;
      /** The log's length when it closed — how many commits the stored log must hold to be whole. */
      readonly commits: number;
      readonly meta?: Meta;
    };

/**
 * Where a log's entries go as they land — the port an adapter implements (memory, a file, S3, a table).
 *
 * Every method is called synchronously from the writer; an adapter that writes somewhere slow queues
 * the entry and drains in `flush`. A method may throw, or return a promise that rejects: the log
 * counts it (`EventLog · sinkFailures`), reports it to `onFailure`, and goes on — a failing sink never
 * stops the writer. The entries an adapter is handed are its to keep: the bundle is frozen and shared
 * with the log, everything else is the adapter's own copy.
 */
export interface RecordSink {
  /** A log opened at `address` with its fold base. Called once, from the log's constructor. */
  opened(entry: {
    readonly address: LogAddress;
    readonly at: number;
    readonly initialState: Record<string, unknown>;
    readonly meta?: Meta;
  }): void;
  /** A bundle landed in the log at `address` (its position is `bundle.idx`). */
  commit(entry: { readonly address: LogAddress; readonly at: number; readonly bundle: CommitBundle }): void;
  /** The writer noted something beside the log — `kind` and `data` are opaque. */
  note(entry: { readonly address: LogAddress; readonly at: number; readonly kind: string; readonly data: Meta }): void;
  /** The log at `address` closed with `outcome`, holding `commits` bundles. */
  closed(entry: {
    readonly address: LogAddress;
    readonly at: number;
    readonly outcome: LogOutcome;
    readonly commits: number;
    readonly meta?: Meta;
  }): void;
  /** Drain whatever the adapter queued. The log never calls it; whoever owns the sink does. */
  flush?(): Promise<void>;
  /** Told of every entry this sink did not take — the entry and what went wrong. A throw here is ignored. */
  onFailure?(failure: { readonly entry: RecordEntry; readonly error: unknown }): void;
}

/** A plain object — not null, not an array, not a primitive. */
export function isEntryObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `{ meta }` when there is one, `{}` otherwise — an absent field stays absent. */
function withMeta(meta: Meta | undefined): { meta?: Meta } {
  return meta === undefined ? {} : { meta };
}

/**
 * Hand `entry` to the sink's method for its kind, as that method's entry; returns what the method
 * returned (a promise from an async adapter). Throws whatever the method throws — the log catches.
 */
export function sendEntry(sink: RecordSink, entry: RecordEntry): unknown {
  const { address, at } = entry;
  switch (entry.kind) {
    case 'opened':
      return sink.opened({ address, at, initialState: entry.initialState, ...withMeta(entry.meta) });
    case 'commit':
      return sink.commit({ address, at, bundle: entry.bundle });
    case 'note':
      return sink.note({ address, at, kind: entry.note, data: entry.data });
    case 'closed':
      return sink.closed({ address, at, outcome: entry.outcome, commits: entry.commits, ...withMeta(entry.meta) });
  }
}

/**
 * A sink that keeps every entry in memory, in arrival order — the reference adapter: what any adapter
 * must give back for `readStoredRecord` to read the same record. `entries` is a new array on each read.
 * What it keeps is frozen as far as freezing reaches — the base, `meta` and a note's `data` are the
 * copies a log hands it, and the bundle is already frozen — so no reader can rewrite its containers. A
 * Date's time, a Map's or Set's entries and a buffer's bytes are not sealed by freezing (`deepFreeze`'s
 * stated limit). A caller that hands it objects directly hands them over: they are frozen in place.
 *
 * @example
 * ```typescript
 * const sink = memorySink();
 * const log = new EventLog({}, { sink, address: { logRunId: 'run-1', drillPath: [] } });
 * log.close('ok');
 * sink.entries.map((e) => e.kind); // ['opened', 'closed']
 * ```
 */
export function memorySink(): RecordSink & { readonly entries: readonly RecordEntry[] } {
  const stored: RecordEntry[] = [];
  const keep = (entry: RecordEntry): void => {
    stored.push(deepFreeze(entry));
  };
  return {
    get entries(): readonly RecordEntry[] {
      return stored.slice();
    },
    opened: ({ address, at, initialState, meta }) =>
      keep({ kind: 'opened', address, at, initialState, ...withMeta(meta) }),
    commit: ({ address, at, bundle }) => keep({ kind: 'commit', address, at, bundle }),
    note: ({ address, at, kind, data }) => keep({ kind: 'note', address, at, note: kind, data }),
    closed: ({ address, at, outcome, commits, meta }) =>
      keep({ kind: 'closed', address, at, outcome, commits, ...withMeta(meta) }),
    flush: () => Promise.resolve(),
  };
}
