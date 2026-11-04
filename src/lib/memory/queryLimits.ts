import type { CommitBundle } from './types.js';

/** Cooperative stops shared by synchronous root slice queries. */
export interface SliceQueryOptions {
  /** Signal checked before/after callbacks and at query checkpoints. */
  signal?: AbortSignal;
  /** Cooperative elapsed-time limit: default 1000ms, maximum 30000ms. */
  timeoutMs?: number;
  /** Charged input and traversal units: default 1000000, maximum 10000000. */
  maxWork?: number;
}

/** Bounded graph output. Integers only; exceeding a ceiling is refused. */
export interface SliceWalkOptions extends SliceQueryOptions {
  /** Default 20; maximum 1000; zero permits the root only. */
  maxDepth?: number;
  /** Default 100; maximum 10000 (including the root). */
  maxNodes?: number;
  /** Default 1000; maximum 100000 across the whole DAG. */
  maxEdges?: number;
}

/** A normal output cut; omitted when the corresponding allowance was sufficient. */
export interface SliceTruncation {
  byDepth: boolean;
  byNodes: boolean;
  byEdges?: boolean;
  byReads?: boolean;
}

/** A stopped query never returns an apparently complete or missing answer. */
export class SliceQueryError extends Error {
  constructor(readonly code: 'SLICE_CANCELLED' | 'SLICE_TIMEOUT' | 'SLICE_WORK_LIMIT') {
    super(code);
    this.name = 'SliceQueryError';
  }
}

const defaults = {
  maxDepth: 20,
  maxNodes: 100,
  maxEdges: 1000,
  maxReads: 1000,
  maxMoments: 1000,
  timeoutMs: 1000,
  maxWork: 1000000,
};
const ceilings = {
  maxDepth: 1000,
  maxNodes: 10000,
  maxEdges: 100000,
  maxReads: 100000,
  maxMoments: 100000,
  timeoutMs: 30000,
  maxWork: 10000000,
};
type Limit = keyof typeof defaults;
type Options = SliceQueryOptions & Partial<Record<Limit, number>>;

/** Internal per-invocation owner. Composition shares this object, never a fresh deadline. */
export class SliceQueryControl {
  readonly limits: Readonly<typeof defaults>;
  private readonly deadline: number;
  private work = 0;
  private readonly signal?: AbortSignal;

  constructor(options: Options = {}) {
    const limits = { ...defaults };
    for (const key of Object.keys(defaults) as Limit[]) {
      const value = options[key];
      if (value === undefined) continue;
      if (!Number.isSafeInteger(value) || value < (key === 'maxDepth' ? 0 : 1) || value > ceilings[key])
        throw new TypeError(`SLICE_CONFIGURATION_INVALID: ${key}`);
      limits[key] = value;
    }
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal))
      throw new TypeError('SLICE_CONFIGURATION_INVALID: signal');
    this.signal = options.signal;
    this.limits = Object.freeze(limits);
    this.deadline = performance.now() + limits.timeoutMs;
    this.check();
  }

  check(units = 0): void {
    if (this.signal?.aborted) throw new SliceQueryError('SLICE_CANCELLED');
    if (performance.now() >= this.deadline) throw new SliceQueryError('SLICE_TIMEOUT');
    this.work += units;
    if (this.work > this.limits.maxWork) throw new SliceQueryError('SLICE_WORK_LIMIT');
  }

  /** Check after result preparation, including every empty/missing fast path. */
  finish<T>(result: T): T {
    this.check();
    return result;
  }

  /** Bound preparation before it allocates indices. Never analyze an incomplete input prefix. */
  admit(log: readonly CommitBundle[]): void {
    this.check(log.length);
    for (const bundle of log) {
      this.check(bundle.trace.length);
      for (const row of bundle.trace) {
        this.check(row.path.length + (row.readKeys?.length ?? 0));
        for (const key of row.readKeys ?? []) this.check(key.length);
      }
    }
  }

  /** Callback errors retain their existing semantics; cancellation after a return always wins. */
  reads(lookup: (id: string) => string[], id: string): string[] {
    this.check(1);
    const keys = lookup(id);
    this.check(keys?.length ?? 0);
    for (const key of keys ?? []) this.check(key.length);
    return keys;
  }
}
