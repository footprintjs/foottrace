import type { CauseGraph, ExplainOptions, Gap, GraphContext, NodeId, WalkLimits } from './types.js';
import { AdmissionError, gap, name, observePromise, own, plain } from './validation.js';

export interface Read<T> {
  readonly value?: T;
  readonly gap?: Gap;
}
type Method = 'parents' | 'children' | 'attention' | 'gaps' | 'roots';
const defaults = { maxNodes: 100, maxDepth: 20, maxEdges: 1000, maxCalls: 1000, timeoutMs: 1000 };
const ceilings = { maxNodes: 10000, maxDepth: 1000, maxEdges: 100000, maxCalls: 100000, timeoutMs: 30000 };
/** One deadline, memo table and work budget per public query, never per graph or store. */
export class Session {
  readonly limits: Required<WalkLimits>;
  readonly context: GraphContext;
  readonly nodes = new Set<NodeId>();
  readonly controller = new AbortController();
  private readonly cache = new Map<string, Promise<Read<unknown>>>();
  private calls = 0;
  edges = 0;
  private timedOut = false;
  private readonly deadline: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly external?: AbortSignal;
  private readonly onAbort = () => this.controller.abort();
  private readonly methods: Partial<Record<Method, (...args: any[]) => unknown>> = {};

  constructor(graph: CauseGraph, options: ExplainOptions = {}) {
    try {
      plain(options);
      const limits = { ...defaults };
      for (const key of Object.keys(defaults) as (keyof WalkLimits)[]) {
        const value = own(options, key);
        if (value !== undefined) {
          if (
            typeof value !== 'number' ||
            !Number.isSafeInteger(value) ||
            value < (key === 'maxDepth' ? 0 : 1) ||
            value > ceilings[key]
          )
            throw new TypeError();
          limits[key] = value;
        }
      }
      this.limits = Object.freeze(limits);
      const rank = own(options, 'rankRoots');
      if (rank !== undefined && typeof rank !== 'function') throw new TypeError();
      const impactRank = own(options, 'rankImpact');
      if (impactRank !== undefined && typeof impactRank !== 'function') throw new TypeError();
      const signal = own(options, 'signal');
      if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError();
      this.external = signal as AbortSignal | undefined;
      for (const key of ['parents', 'children', 'attention', 'gaps', 'roots'] as Method[]) {
        let cursor: object | null = graph,
          method: unknown;
        for (
          let depth = 0;
          cursor && cursor !== Object.prototype && depth < 8;
          depth++, cursor = Object.getPrototypeOf(cursor)
        ) {
          const field = Object.getOwnPropertyDescriptor(cursor, key);
          if (field) {
            if (!('value' in field)) throw new TypeError();
            method = field.value;
            break;
          }
        }
        if (typeof method !== 'function' && key !== 'roots') throw new TypeError();
        if (typeof method === 'function') this.methods[key] = method.bind(graph);
      }
    } catch {
      throw new TypeError('CAUSE_CONFIGURATION_INVALID');
    }
    this.context = Object.freeze({ signal: this.controller.signal });
    this.deadline = performance.now() + this.limits.timeoutMs;
    this.external?.addEventListener('abort', this.onAbort, { once: true });
    if (this.external?.aborted) this.onAbort();
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.controller.abort();
    }, this.limits.timeoutMs);
  }
  dispose(): void {
    clearTimeout(this.timer);
    this.external?.removeEventListener('abort', this.onAbort);
  }
  stopGap(id?: NodeId): Gap | undefined {
    // Resolved Promise chains can starve timers. Check the monotonic deadline too.
    if (!this.controller.signal.aborted && performance.now() >= this.deadline) {
      this.timedOut = true;
      this.controller.abort();
    }
    return this.controller.signal.aborted ? gap(this.timedOut ? 'timeout' : 'cancelled', id) : undefined;
  }
  admit(id: NodeId): Gap | undefined {
    name(id);
    if (this.nodes.has(id)) return undefined;
    if (this.nodes.size >= this.limits.maxNodes) return gap('node-limit', id);
    this.nodes.add(id);
    return undefined;
  }
  hasRoots(): boolean {
    return !!this.methods.roots;
  }
  read<T>(method: Method, id: NodeId | undefined, project: (raw: unknown) => T): Promise<Read<T>> {
    const key = JSON.stringify([method, id]);
    const cached = this.cache.get(key);
    if (cached) return cached as Promise<Read<T>>;
    const pending = this.invoke(
      id,
      () => {
        const fn = this.methods[method];
        if (!fn) throw new AdmissionError('not-collected');
        return id === undefined ? fn(this.context) : fn(id, this.context);
      },
      project,
    );
    this.cache.set(key, pending);
    return pending;
  }
  invoke<T>(id: NodeId | undefined, work: () => unknown, project: (raw: unknown) => T): Promise<Read<T>> {
    const stopped = this.stopGap(id);
    if (stopped) return Promise.resolve({ gap: stopped });
    if (++this.calls > this.limits.maxCalls) return Promise.resolve({ gap: gap('call-limit', id) });
    return new Promise((resolve) => {
      let finished = false;
      const finish = (result: Read<T>) => {
        if (finished) return;
        finished = true;
        this.controller.signal.removeEventListener('abort', abort);
        resolve(result);
      };
      const abort = () => finish({ gap: this.stopGap(id) ?? gap('cancelled', id) });
      const accept = (raw: unknown) => {
        if (finished) return;
        const stopped = this.stopGap(id);
        if (stopped) {
          finish({ gap: stopped });
          return;
        }
        try {
          const value = project(raw),
            expired = this.stopGap(id);
          finish(expired ? { gap: expired } : { value });
        } catch (error) {
          finish({ gap: gap(error instanceof AdmissionError ? error.code : 'invalid-data', id) });
        }
      };
      this.controller.signal.addEventListener('abort', abort, { once: true });
      if (this.controller.signal.aborted) {
        abort();
        return;
      }
      try {
        const returned = work();
        // Observe native Promises by intrinsic, never assimilate a payload's `then` getter.
        if (!observePromise(returned, accept, () => finish({ gap: gap('unavailable', id) }))) accept(returned);
      } catch (error) {
        finish({ gap: gap(error instanceof AdmissionError ? error.code : 'unavailable', id) });
      }
    });
  }
}
