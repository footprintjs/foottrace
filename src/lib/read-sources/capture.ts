import type { LogAddress } from '../memory/eventPosition.js';
import { DELIM } from '../memory/paths.js';
import type { TraceEntry } from '../memory/types.js';
import { sourceBytes, sourceKey, sourceList, sourceOwner } from './admission.js';
import { createOriginIndex, type OriginIndex } from './originIndex.js';
import { SourceStaging } from './staging.js';
import { confirmOrigins, invalidateOrigins } from './commitFacts.js';
import type {
  ReadSource,
  ReadSourceDisposition,
  ReadSourceGap,
  ReadSourceLimits,
  ReadSourceOccurrence,
  ReadSourceOwner,
  ReadSourceSnapshot,
} from './types.js';

export interface SourceFrame {
  readonly id: number;
  readonly clock: number;
  readonly staging: SourceStaging;
  disposition: ReadSourceDisposition;
}

/** One opted-in native log lifetime. Hosts cannot supply an observer that selects a read's value. */
export class ReadSourceCapture {
  readonly index: OriginIndex;
  private readonly occurrences: ReadSourceOccurrence[] = [];
  private readonly dispositions = new Map<number, ReadSourceDisposition>();
  private readonly executions = new Map<string, number>();
  private readonly abandoned = new Set<string>();
  private readonly gaps = new Map<ReadSourceGap, { reason: ReadSourceGap; count: number; exact: boolean }>();
  private bytes: number;
  private ordinal = 0;
  private pending = 0;
  private prunedThrough = -1;
  private frames = 0;
  private readonly active = new Map<number, number>();
  private readonly pins = new Map<number, number>();
  private readonly retainedFrames = new Set<number>();
  private generation = 0;
  private staged = 0;
  private stagedBytes = 0;
  private failed = false;
  private discardedAttemptsIncomplete = false;
  private stopped = false;
  constructor(readonly address: LogAddress, readonly segment: number, readonly limits: ReadSourceLimits) {
    this.index = createOriginIndex(limits.maxOrigins, segment, limits.maxBytes);
    this.bytes = sourceBytes({ version: 1, address, segment, status: 'captured', occurrences: [], gaps: [], limits });
    if (this.bytes + 1024 > limits.maxBytes) throw new TypeError('read sources: invalid limits');
  }
  get retired(): boolean {
    return this.stopped;
  }
  get clock(): number {
    return this.index.clock;
  }
  gap(reason: ReadSourceGap, exact = true): void {
    const previous = this.gaps.get(reason);
    if (!previous) this.gaps.set(reason, { reason, count: 1, exact });
    else if (previous.count < Number.MAX_SAFE_INTEGER) {
      previous.count++;
      previous.exact &&= exact;
    } else previous.exact = false;
    if (reason === 'capture-failed') this.failed = true;
  }
  frame(address: readonly string[]): SourceFrame | undefined {
    if (this.stopped) return undefined;
    if (this.active.size >= this.limits.maxOrigins || this.frames === Number.MAX_SAFE_INTEGER) {
      // Without a frame witness, later discard/reuse cannot be reconstructed safely.
      this.discardedAttemptsIncomplete = true;
      this.gap('budget-exhausted');
      return undefined;
    }
    const id = ++this.frames;
    const staging = new SourceStaging(
      id,
      (bytes, previousBytes) => {
        const added = previousBytes === undefined ? 1 : 0;
        const nextBytes = this.stagedBytes + bytes - (previousBytes ?? 0);
        if (
          this.staged + added > this.limits.maxStaging ||
          nextBytes > this.limits.maxBytes ||
          this.generation === Number.MAX_SAFE_INTEGER
        )
          return undefined;
        this.staged += added;
        this.stagedBytes = nextBytes;
        return ++this.generation;
      },
      sourceList(address, 64, sourceKey),
      (count, bytes) => {
        this.staged -= count;
        this.stagedBytes -= bytes;
      },
    );
    this.active.set(id, this.clock);
    return { id, clock: this.clock, staging, disposition: 'active' };
  }
  end(frame: SourceFrame | undefined, disposition: ReadSourceDisposition): void {
    if (!frame) return;
    if (frame.disposition !== 'discarded') frame.disposition = disposition;
    if (this.retainedFrames.has(frame.id)) this.dispositions.set(frame.id, frame.disposition);
    this.active.delete(frame.id);
    frame.staging.dispose();
    this.prune();
    if (frame && disposition === 'discarded') {
      for (const row of this.occurrences)
        if (row.frame === frame.id && row.attemptId) this.abandoned.add(row.attemptId);
    }
  }
  retire(): void {
    this.stopped = true;
    this.index.fail('scope-retired');
  }
  poison(): void {
    this.failed = true;
    this.index.fail('capture-failed');
    this.gap('capture-failed', false);
  }
  invalidate(path: readonly (string | number)[]): void {
    try {
      if (path.length > 64) {
        this.index.fail('budget-exhausted');
        return;
      }
      if (path.some((part) => typeof part !== 'string' && typeof part !== 'number')) {
        this.poison();
        return;
      }
      this.index.write(path.map(String), { kind: 'unavailable', reason: 'untracked-write' });
    } catch {
      this.poison();
    }
  }
  invalidateRows(trace: readonly TraceEntry[]): void {
    invalidateOrigins(this.index, trace, this.limits.maxOrigins);
  }
  confirm(clock: number, commitIdx: number, trace: readonly TraceEntry[], redacted: ReadonlySet<string>): void {
    if (this.stopped || this.clock !== clock) return;
    confirmOrigins(this.index, trace, redacted, commitIdx, this.limits.maxOrigins);
  }
  select(
    frame: SourceFrame | undefined,
    path: readonly string[],
    value: unknown,
    dataOnly: boolean,
    live: boolean,
    privacy: 'visible' | 'redacted',
    nested: boolean,
  ): ReadSource {
    if (this.stopped) return { kind: 'unavailable', reason: 'scope-retired' };
    if (privacy !== 'visible' && privacy !== 'redacted') return { kind: 'unavailable', reason: 'capture-failed' };
    if (privacy === 'redacted') return { kind: 'unavailable', reason: 'redacted' };
    if (!dataOnly) return { kind: 'unavailable', reason: 'untracked-write' };
    if (
      nested ||
      path.some((part) => part.includes(DELIM)) ||
      (value !== null && typeof value === 'object') ||
      typeof value === 'function' ||
      typeof value === 'symbol'
    )
      return { kind: 'unavailable', reason: 'composite-unsupported' };
    if (value === undefined) return { kind: 'unavailable', reason: 'undefined-presence-unknown' };
    if (!frame) return { kind: 'unavailable', reason: this.failed ? 'capture-failed' : 'budget-exhausted' };
    return (!live && frame.staging.resolve(path)) || this.index.resolve(path, live ? this.clock : frame.clock);
  }
  /** Reserve before the actual read: accessors may start another read synchronously. */
  begin(clock = this.clock): number | undefined {
    if (this.ordinal === Number.MAX_SAFE_INTEGER || this.pins.size >= this.limits.maxOrigins) {
      this.gap('budget-exhausted', false);
      return undefined;
    }
    this.pending++;
    this.pins.set(++this.ordinal, clock);
    return this.ordinal;
  }
  finish(ordinal: number | undefined): void {
    if (ordinal !== undefined && this.pins.delete(ordinal)) this.pending--;
    this.prune();
  }
  private prune(): void {
    let oldest = this.clock;
    for (const clock of this.active.values()) oldest = Math.min(oldest, clock);
    for (const clock of this.pins.values()) oldest = Math.min(oldest, clock);
    if (oldest > this.prunedThrough) {
      this.index.prune(oldest);
      this.prunedThrough = oldest;
    }
  }
  /** A successful read may lose metadata before retain() is even reached. */
  omitted(frame: SourceFrame | undefined, owner: ReadSourceOwner | undefined): void {
    if (frame?.disposition === 'discarded' && owner?.attemptId) this.discardedAttemptsIncomplete = true;
  }
  retain(
    ordinal: number | undefined,
    frame: SourceFrame | undefined,
    keyInput: unknown,
    stateAddressInput: readonly string[],
    ownerInput: ReadSourceOwner,
    source: ReadSource,
  ): ReadSourceOccurrence | undefined {
    let owner: ReadSourceOwner | undefined;
    let retained = false;
    try {
      owner = sourceOwner(ownerInput);
      if (!frame) {
        this.discardedAttemptsIncomplete = true;
        this.gap(source.kind === 'unavailable' ? source.reason : 'capture-failed');
        return undefined;
      }
      if (ordinal === undefined) return undefined;
      if (this.occurrences.length >= this.limits.maxOccurrences) {
        this.gap('budget-exhausted');
        return undefined;
      }
      const key = sourceKey(keyInput);
      const stateAddress = sourceList(stateAddressInput, 64, sourceKey);
      const count = this.executions.get(owner.runtimeStageId) ?? 0;
      if (count >= this.limits.maxPerExecution) {
        this.gap('budget-exhausted');
        return undefined;
      }
      // A verdict may discard the original frame before its pending read is retained.
      // Remember that attempt now too, so later calls cannot borrow a fresh incarnation.
      const discardedHere = frame?.disposition === 'discarded';
      const abandoned = owner.attemptId !== undefined && (discardedHere || this.abandoned.has(owner.attemptId));
      if (abandoned) source = { kind: 'unavailable', reason: 'scope-retired' };
      else if (owner.attemptId !== undefined && this.discardedAttemptsIncomplete)
        source = { kind: 'unavailable', reason: this.failed ? 'capture-failed' : 'budget-exhausted' };
      const occurrence: ReadSourceOccurrence = Object.freeze({
        ordinal,
        ...owner,
        attemptStatus: owner.attemptId === undefined ? 'unavailable' : 'known',
        ...(frame ? { frame: frame.id } : {}),
        key,
        stateAddress,
        source: Object.freeze(source),
        disposition: abandoned ? 'discarded' : frame?.disposition ?? 'active',
      });
      const bytes = sourceBytes({ ...occurrence, disposition: 'discarded' }) + 1;
      // Fixed bounded gap vocabulary and saturating counts have a separately reserved tail.
      if (this.bytes + bytes > this.limits.maxBytes - 1024) {
        this.gap('budget-exhausted');
        return undefined;
      }
      if (discardedHere && owner.attemptId) this.abandoned.add(owner.attemptId);
      if (frame) {
        this.retainedFrames.add(frame.id);
        if (frame.disposition !== 'active') this.dispositions.set(frame.id, frame.disposition);
      }
      this.bytes += bytes;
      this.executions.set(owner.runtimeStageId, count + 1);
      // Only callback reentrancy needs insertion; the usual monotonic path appends.
      let position = this.occurrences.length;
      while (position > 0 && this.occurrences[position - 1].ordinal > ordinal) position--;
      this.occurrences.splice(position, 0, occurrence);
      if (source.kind === 'unavailable') this.gap(source.reason);
      retained = true;
      return occurrence;
    } catch {
      this.poison();
      return undefined;
    } finally {
      // Every refusal door (including pending-pin/ordinal admission) loses the same
      // discard evidence. Quarantine precision with one bit rather than retaining IDs.
      if (!retained && frame?.disposition === 'discarded' && owner?.attemptId) this.discardedAttemptsIncomplete = true;
    }
  }
  snapshot(): ReadSourceSnapshot {
    const occurrences = this.occurrences.map((row) =>
      Object.freeze({
        ...row,
        disposition:
          row.disposition === 'discarded' || row.frame === undefined
            ? row.disposition
            : this.dispositions.get(row.frame) ?? row.disposition,
      }),
    );
    const gaps = [...this.gaps.values()].map((gap) => Object.freeze({ ...gap }));
    if (this.pending) {
      const index = gaps.findIndex((gap) => gap.reason === 'capture-failed');
      const pending = Object.freeze({
        reason: 'capture-failed' as const,
        count: this.pending + (index < 0 ? 0 : gaps[index].count),
        exact: false,
      });
      if (index < 0) gaps.push(pending);
      else gaps[index] = pending;
    }
    return Object.freeze({
      version: 1,
      address: this.address,
      segment: this.segment,
      status: this.stopped ? 'retired' : this.failed ? 'failed' : gaps.length ? 'partial' : 'captured',
      occurrences: Object.freeze(occurrences),
      gaps: Object.freeze(gaps),
      limits: this.limits,
    });
  }
}
