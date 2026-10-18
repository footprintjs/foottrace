import type { CauseGraph, ExplainOptions, Gap, GraphContext, NodeId, WalkLimits } from './types.js';
import { AdmissionError, gap, observePromise, graphOwn, plain } from './validation.js';
import { beginQueryMemo, endQueryMemo } from './queryMemo.js';
import { QueryBudget, type BudgetView } from './queryBudget.js';

export interface Read<T> {
  readonly value?: T;
  readonly gap?: Gap;
}
type Method = 'parents' | 'children' | 'attention' | 'gaps' | 'roots';
/** One deadline, memo table and work budget per public query, never per graph or store. */
export class Session {
  readonly limits: Required<WalkLimits>;
  readonly context: GraphContext;
  readonly controller = new AbortController();
  private readonly cache = new Map<string, Promise<Read<unknown>>>();
  private readonly budget: QueryBudget;
  private timedOut = false;
  private readonly deadline: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly external?: AbortSignal;
  private readonly onAbort = () => this.controller.abort();
  private readonly methods: Partial<Record<Method, (...args: any[]) => unknown>> = {};

  constructor(graph: CauseGraph, options: ExplainOptions = {}) {
    try {
      plain(options);
      this.budget = new QueryBudget(options);
      this.limits = this.budget.limits;
      const rank = graphOwn(options, 'rankRoots');
      if (rank !== undefined && typeof rank !== 'function') throw new TypeError();
      const impactRank = graphOwn(options, 'rankImpact');
      if (impactRank !== undefined && typeof impactRank !== 'function') throw new TypeError();
      const signal = graphOwn(options, 'signal');
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
    beginQueryMemo(this.context, this.limits.maxNodes);
  }
  dispose(): void {
    endQueryMemo(this.context);
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
  direction(direction: 'backward' | 'impact'): BudgetView {
    return this.budget.direction(direction);
  }
  get total(): BudgetView {
    return this.budget.total;
  }
  hasRoots(): boolean {
    return !!this.methods.roots;
  }
  read<T>(budget: BudgetView, method: Method, id: NodeId | undefined, project: (raw: unknown) => T): Promise<Read<T>> {
    const key = JSON.stringify([method, id]);
    const cached = this.cache.get(key);
    if (cached) return cached as Promise<Read<T>>;
    return this.invoke(
      budget,
      id,
      () => {
        const fn = this.methods[method];
        if (!fn) throw new AdmissionError('not-collected');
        return id === undefined ? fn(this.context) : fn(id, this.context);
      },
      project,
      key,
    );
  }
  invoke<T>(
    budget: BudgetView,
    id: NodeId | undefined,
    work: () => unknown,
    project: (raw: unknown) => T,
    cacheKey?: string,
  ): Promise<Read<T>> {
    const stopped = this.stopGap(id);
    if (stopped) return Promise.resolve({ gap: stopped });
    const refusal = budget.takeCall(id);
    if (refusal) return Promise.resolve({ gap: refusal });
    const pending = new Promise<Read<T>>((resolve) => {
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
    // A local allowance refusal is not evidence and must never poison the other direction's cache.
    if (cacheKey !== undefined) this.cache.set(cacheKey, pending);
    return pending;
  }
}
