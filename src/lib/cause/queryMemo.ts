import type { GraphContext } from './types.js';

/** Share bounded derived work within one query without retaining it in the graph's storage cache. */
class QueryMemo {
  private readonly owners = new Map<object, Map<unknown, unknown>>();
  private entries = 0;
  private closed = false;

  constructor(private readonly maximumEntries: number) {}

  remember<T>(owner: object, key: unknown, create: () => T): T {
    const previous = this.owners.get(owner);
    if (previous?.has(key)) return previous.get(key) as T;
    if (this.closed || this.entries >= this.maximumEntries) return create();
    const value = create();
    // Creation can finish after disposal or re-enter other readers; neither may refill a closed/full memo.
    if (!this.closed && this.entries < this.maximumEntries) {
      const bucket = this.owners.get(owner) ?? new Map<unknown, unknown>();
      if (!bucket.has(key)) this.entries++;
      bucket.set(key, value);
      this.owners.set(owner, bucket);
    }
    return value;
  }

  close(): void {
    this.closed = true;
    this.owners.clear();
    this.entries = 0;
  }
}

const queries = new WeakMap<GraphContext, QueryMemo>();

/** Reserve one resolution and one inspection per admitted node, shared across all adapter owners. */
export function beginQueryMemo(context: GraphContext, maximumNodes: number): void {
  queries.set(context, new QueryMemo(maximumNodes * 2));
}

/** Direct graph calls have no managed query lifetime and deliberately remain uncached. */
export function queryMemo(context: GraphContext): QueryMemo | undefined {
  return queries.get(context);
}

/** Clear synchronously without aborting an otherwise successful query's public signal. */
export function endQueryMemo(context: GraphContext): void {
  queries.get(context)?.close();
  queries.delete(context);
}
