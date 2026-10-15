/**
 * EventLog — Time-travel snapshot storage for flowchart execution
 *
 * Like git history: stores commit bundles (diffs), not full snapshots.
 *
 * THE RECORD IS IMMUTABLE FROM `record` (F3, ruling R3). Every bundle is deep-frozen as it is
 * recorded — the bundle, `overwrite` and `updates` at every depth, the trace and each row, the
 * row's `readKeys`, `redactedPaths`, `tags`, `untrackedSources` — so a holder of a snapshot can no
 * longer rewrite the history every later answer is folded from: an assignment into a bundle throws
 * a `TypeError` in strict code. Safe because nothing outside the log holds a bundle's containers:
 * the log's payload is the commit's own copy (`recordCommit` hands it the output of
 * `scrubPatch`), and live state, the redacted mirror and write retention each take their own copy
 * (`verbs.ts · foldRows` detaches, `StageContext · retainedForm` clones) — pinned by
 * test/lib/memory/property/record-reachability.property.test.ts.
 *
 * What `Object.freeze` cannot seal — a Date's time, a Map's or Set's entries, a buffer's bytes, a
 * RegExp, an Error's stack — is never handed out to a reader (9.44.2): `record` remembers that a
 * bundle holds such a value (`capture/freeze.ts · freezeRecord`), and `list()` — like the public
 * snapshot, `runner/snapshot.ts · servedSnapshot` — serves that bundle as a copy of its open paths
 * (`serveRecord`, mapped at its first serve): fresh frozen containers down to each such value, a
 * fresh copy of it, every other part the log's own. A reader edits only its own copy; every later
 * serve reads the record as recorded. `recorded()` is the engine's own, unserved read. Named holes: an object hung on an array EXPANDO (arrays are walked
 * by index — the `'indices'` walk, which keeps the freeze inside its budget; an expando is out of
 * contract for state) and a `SharedArrayBuffer` (every copy shares its memory). A frozen RegExp's
 * `lastIndex` is read-only, so a `/g` or `/y` regex read from a bundle throws when `exec` or
 * `replace` advance it.
 *
 * A SINK (1.1.0, optional). `new EventLog(base, { sink, address, meta? })` also hands every entry to a
 * `RecordSink` AS IT LANDS (`sink.ts`): `opened` from the constructor (the base, as the sink's own
 * copy), `commit` from `record` after the bundle is frozen and appended (the bundle as served),
 * `note` from `note`, `closed` from `close`. The log's own record never depends on the sink: the
 * bundle is in `steps` before the sink sees it, and nothing the sink does reaches the writer — a
 * throw, a rejected promise or an entry the log refuses to send (a `note` whose data is not a plain
 * object that survives `structuredClone`) is counted (`sinkFailures`) and reported to
 * `sink.onFailure`, and the writer goes on; a `meta` that will not copy is lost on its own and its
 * entry still goes. Without a sink, nothing here runs: the one-argument log writes the same bytes,
 * and has the same own fields, it always did.
 */

import { freezeRecord, serveRecord } from '../capture/freeze.js';
import type { EmitSourcePosition, LogAddress } from './eventPosition.js';
import {
  isEntryObject,
  LOG_OUTCOMES,
  type LogOutcome,
  type Meta,
  type RecordEntry,
  type RecordSink,
  sendEntry,
} from './sink.js';
import type { CommitBundle, MemoryPatch } from './types.js';
import { applySmartMergeInto } from './utils.js';

/** True when `value` has a callable `then` — an adapter that answered with a promise. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * The address, copied segment by segment and frozen — the log's identity cannot be edited through the
 * caller's object, and a path with a hole or a non-string segment is refused rather than copied as one.
 */
function frozenAddress(address: LogAddress): LogAddress {
  const { logRunId, drillPath } = (address ?? {}) as Partial<LogAddress>;
  const refused = () => new TypeError('EventLog: a sink needs an address — { logRunId: string, drillPath: string[] }');
  if (typeof logRunId !== 'string' || !Array.isArray(drillPath)) throw refused();
  const segments: string[] = [];
  for (let i = 0; i < drillPath.length; i++) {
    const segment: unknown = drillPath[i];
    if (typeof segment !== 'string') throw refused();
    segments.push(segment);
  }
  return Object.freeze({ logRunId, drillPath: Object.freeze(segments) });
}

/** A writer's payload as the sink keeps it: a plain object, copied — or a `TypeError` naming `field`. */
function copiedPayload(value: Meta, field: string): Meta {
  if (!isEntryObject(value)) throw new TypeError(`EventLog: ${field} must be a plain object`);
  return structuredClone(value);
}

/**
 * The entry with its `meta` copied — or, when `meta` cannot be copied, the entry WITHOUT it and the
 * error: the structural facts (the base, how the log ended, its length) still go; only `meta` is lost.
 */
function withCopiedMeta<E extends Extract<RecordEntry, { meta?: Meta }>>(entry: E): { ready: E; dropped?: unknown } {
  if (entry.meta === undefined) return { ready: entry };
  try {
    return { ready: { ...entry, meta: copiedPayload(entry.meta, 'meta') } };
  } catch (error) {
    const { meta: _dropped, ...rest } = entry;
    return { ready: rest as E, dropped: error };
  }
}

/**
 * The entry as the sink may keep it: a payload checked and copied (the writer keeps its own object),
 * the bundle served. `dropped` is a `meta` that could not be copied (the entry goes without it). Throws
 * when the entry itself cannot be sent; the caller counts it as a lost entry.
 */
function detached(entry: RecordEntry): { ready: RecordEntry; dropped?: unknown } {
  switch (entry.kind) {
    case 'opened':
      return withCopiedMeta(entry);
    case 'commit':
      return { ready: { ...entry, bundle: serveRecord(entry.bundle) } };
    case 'note':
      if (typeof entry.note !== 'string') throw new TypeError('EventLog.note: kind must be a string');
      return { ready: { ...entry, data: copiedPayload(entry.data, 'note data') } };
    case 'closed':
      if (!LOG_OUTCOMES.includes(entry.outcome)) {
        throw new TypeError(`EventLog.close: outcome must be ${LOG_OUTCOMES.join(', ')}`);
      }
      return withCopiedMeta(entry);
  }
}

/** Swallows a rejection nobody waits for. */
function ignore(): void {
  // A failure report that fails changes nothing: the loss is already counted.
}

export class EventLog {
  /** Base snapshot BEFORE the first stage mutates anything. */
  private base: any;
  /** Ordered list of commit bundles. */
  private steps: CommitBundle[] = [];
  private sourceAddress?: LogAddress;
  private sourceAddressRetired = false;
  // The sink's two fields are DECLARED, not initialised, and set only with a sink: the one-argument
  // log keeps 1.0.3's own fields exactly (its `Object.keys`, its JSON).
  /** Where entries go as they land; absent for the one-argument log. */
  private declare readonly sink?: RecordSink;
  /** Entries the sink did not take; set with the sink. */
  private declare lostEntries?: number;
  /** True while `onFailure` runs: a loss it causes is counted, not reported again (no runaway). */
  private declare reporting?: boolean;

  /**
   * @param initialMemory The fold base — the state before the first commit (copied).
   * @param options With a `sink`: every entry goes to it as it lands, under `address` — which also
   *   becomes this log's {@link address} — and `meta` rides the `opened` entry. The sink is told
   *   `opened` before the constructor returns.
   * @throws TypeError when `options` names no sink, a malformed address, or a base that is not a plain
   *   object (the `opened` entry carries it) — a writer's mistake, refused at the door. Nothing the sink
   *   itself does is ever thrown.
   */
  constructor(
    initialMemory: any,
    options?: { readonly sink: RecordSink; readonly address: LogAddress; readonly meta?: Meta },
  ) {
    // Normalised to an object: the base is a STATE, and every fold over it
    // (`materialise`, `stateAt`) applies path writes to it. `undefined` —
    // what a run with no `initialContext` used to store here — made every
    // one of those folds throw on the first `set`.
    this.base = initialMemory === undefined ? {} : structuredClone(initialMemory);
    if (options === undefined) return;
    if (!isEntryObject(options.sink)) throw new TypeError('EventLog: options.sink must be a RecordSink');
    if (!isEntryObject(this.base)) {
      throw new TypeError(
        'EventLog: a log that writes to a sink needs a plain-object base — its opened entry carries it',
      );
    }
    const address = frozenAddress(options.address);
    this.sourceAddress = address;
    this.sink = options.sink;
    this.lostEntries = 0;
    this.send({
      kind: 'opened',
      address,
      at: Date.now(),
      initialState: this.getInitialState(),
      ...(options.meta === undefined ? {} : { meta: options.meta }),
    });
  }

  /**
   * The fold BASE — the state as it stood before the first commit.
   *
   * This is the other half of the commit log: bundles are DIFFS, so a log
   * alone cannot reconstruct state that was seeded before the run (an
   * executor `initialContext`, `defaultValuesForContext`, a resume's
   * `checkpoint.sharedState`, a subflow's `inputMapper` seed). Travelling
   * with the log — `RuntimeSnapshot.initialState` — is what lets an OFFLINE
   * consumer fold; without it the honest answer is a partial one
   * (`stateAt`'s `basis: 'log-only'`).
   *
   * Returns a fresh detached clone on every call — the caller owns it.
   */
  getInitialState(): any {
    return structuredClone(this.base);
  }

  /**
   * Reconstructs the full state at any given step.
   * Replays commits from the beginning — O(n) but low memory footprint.
   *
   * INDEX CONVENTION — `stepIdx` is EXCLUSIVE: `materialise(3)` folds commits
   * 0, 1 and 2. `stateAt(source, commitIdx)` (foottrace) folds the
   * same log but its `commitIdx` is INCLUSIVE, because a reader's cursor asks
   * "the state AT this stop", which must include that stop's own commit. Two
   * folds over one log with opposite conventions: check which one you hold.
   *
   * One clone of the base per call, then every bundle replayed INTO that
   * private copy (`applySmartMergeInto` — the live commit's copy-on-write law
   * below the root, 9.29.0, so the fold and the live state agree at every
   * path). The result is the caller's: it shares nothing with the base or
   * the log.
   *
   * @deprecated Since 9.33.0 — use `stateAt` from `foottrace`, which folds the same log
   * from the same base (`RuntimeSnapshot.initialState`) and says how it was derived (`basis`).
   * Nothing in the library calls this; it stays for one minor and is then removed. Mind the
   * index: `materialise(n)` folds commits `0..n-1`, `stateAt(source, n - 1)` the same commits.
   */
  materialise(stepIdx = this.steps.length): any {
    const out = structuredClone(this.base);
    for (let i = 0; i < stepIdx; i++) {
      const { overwrite, updates, trace } = this.steps[i];
      applySmartMergeInto(out, updates as MemoryPatch, overwrite as MemoryPatch, trace);
    }
    return out;
  }

  /**
   * Persists a commit bundle for a finished stage, and FREEZES it (see the module doc): the bundle
   * is stamped with its position, then deep-frozen, then appended. The engine hands it a bundle
   * built for the log alone; a caller of this class (`foottrace/write`) hands over a bundle it
   * will no longer edit — its own object is the one frozen.
   */
  record(bundle: CommitBundle): void {
    bundle.idx = this.steps.length;
    freezeRecord(bundle, 'indices');
    this.steps.push(bundle);
    if (this.sink !== undefined) this.send({ kind: 'commit', address: this.sourceAddress!, at: Date.now(), bundle });
  }

  /**
   * Note something beside the log, in the sink, as it happens — for evidence that must survive a run
   * that never closes (an attempt that ended, before the next one starts). `kind` and `data` are the
   * writer's: opaque to the record. Notes never enter the log's bundles, so the log's bytes are the
   * same with or without them. Without a sink, nothing happens.
   *
   * Never throws: a `kind` that is not a string, `data` that is not a plain object surviving
   * `structuredClone`, or a sink that fails is counted in {@link sinkFailures} and reported to
   * `sink.onFailure`. The sink keeps its own copy of `data`.
   */
  note(kind: string, data: Meta): void {
    if (this.sink === undefined) return;
    this.send({ kind: 'note', address: this.sourceAddress!, at: Date.now(), note: kind, data });
  }

  /**
   * Tell the sink this log ended — `outcome` and, for the reader's check that the stored log is
   * whole, how many commits it holds now. `meta` rides the entry, copied. Without a sink, nothing
   * happens. The log itself stays as it is: a later `record` still lands, and still reaches the sink
   * (a reader then reads the log as not complete until it is closed again).
   *
   * Never throws: an unknown outcome, a `meta` that is not a plain object surviving `structuredClone`,
   * or a sink that fails is counted in {@link sinkFailures} and reported to `sink.onFailure`.
   */
  close(outcome: LogOutcome, meta?: Meta): void {
    if (this.sink === undefined) return;
    this.send({
      kind: 'closed',
      address: this.sourceAddress!,
      at: Date.now(),
      outcome,
      commits: this.steps.length,
      ...(meta === undefined ? {} : { meta }),
    });
  }

  /**
   * How many entries the sink did not take: a sink method that threw or whose promise rejected, and an
   * entry the log refused to send — plus each `meta` the log could not copy (that entry went without
   * it). Counted as each happens (a rejection, when it settles); 0 without a sink. The stored record
   * says the same from its side: a missing commit is a gap.
   */
  get sinkFailures(): number {
    return this.lostEntries ?? 0;
  }

  /**
   * One entry to the sink. Nothing here reaches the writer: a refusal, a throw or a rejection is a lost
   * entry; a `meta` that cannot be copied is lost on its own — counted and reported — and the entry goes
   * without it.
   */
  private send(entry: RecordEntry): void {
    const sink = this.sink;
    if (sink === undefined) return;
    let sent = entry;
    try {
      const { ready, dropped } = detached(entry);
      sent = Object.freeze(ready);
      if (dropped !== undefined) this.lost(sink, entry, dropped);
      const returned = sendEntry(sink, sent);
      if (isThenable(returned)) this.watch(sink, sent, returned);
    } catch (error) {
      this.lost(sink, sent, error);
    }
  }

  /**
   * Count the rejection of an adapter's promise once. A native promise is watched through the real
   * `Promise.prototype.then` (an own `then` on it is not trusted); any other thenable is adopted into a
   * fresh promise first, whose settling functions run once. Either way the rejection is handled.
   */
  private watch(sink: RecordSink, entry: RecordEntry, returned: PromiseLike<unknown>): void {
    let counted = false;
    const onRejected = (error: unknown): void => {
      if (counted) return;
      counted = true;
      this.lost(sink, entry, error);
    };
    if (returned instanceof Promise) Promise.prototype.then.call(returned, undefined, onRejected);
    else new Promise((resolve) => resolve(returned)).then(undefined, onRejected);
  }

  /**
   * Count a lost entry and tell the sink's `onFailure`, if it listens; a report that fails is ignored.
   * A loss caused while `onFailure` runs (it wrote to this log again, through the same failing sink) is
   * counted and not reported again — one report deep, never a runaway.
   */
  private lost(sink: RecordSink, entry: RecordEntry, error: unknown): void {
    this.lostEntries = (this.lostEntries ?? 0) + 1;
    if (this.reporting === true) return;
    this.reporting = true;
    try {
      const reported: unknown = sink.onFailure?.({ entry, error });
      if (isThenable(reported)) new Promise((resolve) => resolve(reported)).then(undefined, ignore);
    } catch {
      ignore();
    } finally {
      this.reporting = false;
    }
  }

  /**
   * Every recorded commit bundle, AS SERVED (9.44.2): a new array each call; a bundle freezing sealed
   * whole is the log's own (frozen) object, one holding a Date, Map, buffer … is a copy of its open
   * paths (`capture/freeze.ts · serveRecord`) — the reader's own, so no edit reaches the log.
   */
  list(): CommitBundle[] {
    return this.steps.map(serveRecord);
  }

  /**
   * @internal The bundles as the log holds them — each frozen, NOT served — in a new array, so a holder's
   * `splice` reaches only its own. For the engine's own snapshot (`ExecutionRuntime · getSnapshot`, which
   * a subflow mount takes once per mount), so the run serves nothing; a reader is served by `list()` and
   * `getSnapshot().commitLog`. A known open door (CHANGELOG 9.44.2): a holder of these bundles can still
   * edit a Date, Map or buffer inside them.
   */
  recorded(): CommitBundle[] {
    return this.steps.slice();
  }

  /** Number of recorded commits. */
  get length(): number {
    return this.steps.length;
  }

  /**
   * Immutable identity of this log: the sink's address when the log was built with one, otherwise
   * absent until the engine binds it.
   */
  get address(): LogAddress | undefined {
    return this.sourceAddress;
  }

  /** @internal Bind once; resuming the same log must not rename its earlier positions. */
  bindAddress(logRunId: string, drillPath: readonly string[]): void {
    if (this.sourceAddressRetired) return;
    this.sourceAddress ??= Object.freeze({ logRunId, drillPath: Object.freeze([...drillPath]) });
  }

  /** O(1) source-time capture. No counter, observer bookkeeping, or future commit prediction. */
  capturePosition(runId: string): EmitSourcePosition | undefined {
    if (!this.sourceAddress) return undefined;
    return Object.freeze({ runId, ...this.sourceAddress, committedThroughIdx: this.steps.length - 1 });
  }

  /**
   * Wipes history (useful for test resets).
   *
   * @throws Error on a log built with a sink: what the sink stored cannot be wiped, and a second
   *   history under the same address would read back as one corrupted log. Start a fresh EventLog.
   */
  clear(): void {
    if (this.sink !== undefined) {
      throw new Error(
        'EventLog.clear: this log writes to a sink, and a stored record cannot be wiped — use a new EventLog',
      );
    }
    this.steps = [];
    // A reset prefix cannot reuse old coordinates, even if another stage of
    // the SAME leg binds it again. Keep clear's data behavior, but retire
    // addressing for this log; known coordinates require a fresh EventLog.
    this.sourceAddress = undefined;
    this.sourceAddressRetired = true;
  }
}
