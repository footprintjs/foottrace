import { sourceBytes } from '../admission.js';
import { DELIM } from '../../record-paths/codec.js';
import type { CommitBundle } from '../../memory/types.js';
import type { ReadSourceOwner } from '../types.js';
import type { WriteReadFrame, WriteReadPrefix, WriteReadPrefixes } from './types.js';

interface StagedPrefix {
  count: number;
  through: number;
  touches: number;
  supported: boolean;
  redacted: boolean;
}
export interface PrefixFrame {
  readonly id: number;
  readonly root: boolean;
  readonly writes: Map<string, StagedPrefix>;
  count: number;
  committedWrites: number;
  owner?: ReadSourceOwner;
  invalid: boolean;
}
const scalar = (value: unknown): boolean =>
  value === null ||
  typeof value === 'boolean' ||
  typeof value === 'string' ||
  (typeof value === 'number' && Number.isFinite(value));
const sameOwner = (a: ReadSourceOwner, b: ReadSourceOwner): boolean =>
  a.runtimeStageId === b.runtimeStageId && a.attemptId === b.attemptId;

/** Native observations only. No business values, frame objects or staged path maps survive release. */
export class WritePrefixBook {
  private completion = 0;
  private staged = 0;
  private omitted = 0;
  private readonly frames = new Map<number, WriteReadFrame>();
  private readonly writes: WriteReadPrefix[] = [];
  constructor(
    private readonly maximum: number,
    private readonly frameMaximum: number,
    private readonly reserve: (bytes: number) => boolean,
  ) {}
  get nextCompletion(): number | undefined {
    return this.completion < Number.MAX_SAFE_INTEGER ? this.completion + 1 : undefined;
  }
  frame(id: number, address: readonly string[]): PrefixFrame {
    return { id, root: address.length === 0, writes: new Map(), count: 0, committedWrites: 0, invalid: false };
  }
  private lose(): void {
    this.omitted = Math.min(Number.MAX_SAFE_INTEGER, this.omitted + 1);
  }
  bind(frame: PrefixFrame, owner: ReadSourceOwner): void {
    if (!owner.attemptId) {
      frame.invalid = true;
      this.lose();
      return;
    }
    if (frame.owner && !sameOwner(frame.owner, owner)) {
      frame.invalid = true;
      this.lose();
      return;
    }
    frame.owner = Object.freeze({ ...owner });
    this.manifest(frame);
  }
  private manifest(frame: PrefixFrame): void {
    if (!frame.owner) return;
    const next = Object.freeze({ frame: frame.id, ...frame.owner, count: frame.count, writes: frame.committedWrites });
    const previous = this.frames.get(frame.id);
    if (
      (!previous && this.frames.size >= this.frameMaximum) ||
      !this.reserve(Math.max(0, sourceBytes(next) - (previous ? sourceBytes(previous) : 0)) + (previous ? 0 : 1))
    ) {
      frame.invalid = true;
      this.lose();
      return;
    }
    this.frames.set(frame.id, next);
  }
  completed(frame: PrefixFrame, owner: ReadSourceOwner): number | undefined {
    if (this.completion === Number.MAX_SAFE_INTEGER) {
      frame.invalid = true;
      this.lose();
      return undefined;
    }
    this.bind(frame, owner);
    frame.count++;
    this.manifest(frame);
    return ++this.completion;
  }
  stage(frame: PrefixFrame, path: readonly (string | number)[], verb: string, redacted: boolean): void {
    if (++this.staged > this.maximum) {
      frame.invalid = true;
      this.lose();
      return;
    }
    if (
      path.length > 64 ||
      path.some((p) => (typeof p !== 'string' && typeof p !== 'number') || String(p).length > 1024)
    ) {
      frame.invalid = true;
      this.lose();
      return;
    }
    const key = path.map(String).join(DELIM);
    const previous = frame.writes.get(key);
    if (!previous && !this.reserve(sourceBytes(key) + 160)) {
      frame.invalid = true;
      this.lose();
      return;
    }
    frame.writes.set(key, {
      count: frame.count,
      through: this.completion,
      touches: (previous?.touches ?? 0) + 1,
      supported: frame.root && path.length === 1 && verb === 'set',
      redacted: redacted || previous?.redacted === true,
    });
  }
  commit(frame: PrefixFrame, bundle: CommitBundle): void {
    if (bundle.idx === undefined) {
      this.lose();
      return;
    }
    // Count the actual recorded rows before any optional prefix retention can fail.
    const committed = frame.committedWrites + bundle.trace.length;
    frame.committedWrites = Math.min(Number.MAX_SAFE_INTEGER, committed);
    if (!Number.isSafeInteger(committed)) {
      frame.invalid = true;
      this.lose();
    }
    this.manifest(frame);
    if (this.writes.length >= this.maximum || bundle.trace.length > this.maximum) {
      this.lose();
      return;
    }
    const counts = new Map<string, number>();
    for (const row of bundle.trace) counts.set(row.path, (counts.get(row.path) ?? 0) + 1);
    for (let rowIdx = 0; rowIdx < bundle.trace.length; rowIdx++) {
      const row = bundle.trace[rowIdx],
        staged = frame.writes.get(row.path);
      if (!staged) {
        this.lose();
        continue;
      }
      const owner = frame.owner;
      // An unknown owner is never filled from an arbitrary caller-selected committed label.
      if (!owner || frame.invalid || owner.runtimeStageId !== bundle.runtimeStageId || !owner.attemptId) {
        this.lose();
        continue;
      }
      const supported =
        staged.supported &&
        staged.touches === 1 &&
        counts.get(row.path) === 1 &&
        row.verb === 'set' &&
        scalar(bundle.overwrite[row.path]);
      const status = staged.redacted ? 'unavailable' : supported ? 'observed' : 'unavailable';
      const next: WriteReadPrefix = Object.freeze({
        commitIdx: bundle.idx,
        rowIdx,
        frame: frame.id,
        ...owner,
        through: staged.through,
        count: staged.count,
        status,
        ...(status === 'unavailable'
          ? { reason: staged.redacted ? ('redacted' as const) : ('unsupported-write' as const) }
          : {}),
      });
      if (this.writes.length >= this.maximum || !this.reserve(sourceBytes(next) + 1)) {
        this.lose();
        continue;
      }
      this.writes.push(next);
    }
  }
  snapshot(): WriteReadPrefixes {
    return Object.freeze({
      version: 1,
      status: this.omitted ? 'partial' : 'captured',
      frames: Object.freeze([...this.frames.values()]),
      writes: Object.freeze([...this.writes]),
      omitted: this.omitted,
    });
  }
}
