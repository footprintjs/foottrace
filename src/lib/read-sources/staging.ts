import type { ReadSource, ReadSourceGap } from './types.js';
import { sourceBytes } from './admission.js';

/** Only current staging facts; earlier selected generations live in bounded occurrences. */
export class SourceStaging {
  private readonly entries = new Map<string, { generation: number; source: ReadSource; bytes: number }>();
  private lost?: ReadSourceGap;
  private pending = 0;
  private closed = false;
  beginMutation(): void {
    this.pending++;
  }
  endMutation(succeeded: boolean): void {
    this.pending--;
    if (!succeeded) this.fail();
  }
  /** A native partial/abandoned mutation cannot be reconstructed from its later final stage stamp. */
  fail(): void {
    this.lost = 'capture-failed';
  }
  constructor(
    readonly frame: number,
    private readonly generation: (bytes: number, previousBytes?: number) => number | undefined,
    private readonly address: readonly string[] = [],
    private readonly release: (count: number, bytes: number) => void = () => {},
  ) {}
  private rootPath(path: readonly (string | number)[]): readonly (string | number)[] {
    const under = this.address.every((part, index) => path[index] === part);
    return path.slice(0, under ? this.address.length + 1 : Math.min(path.length, 1));
  }
  write(path: readonly (string | number)[], verb: string, redacted: boolean): void {
    if (this.closed) return;
    if (
      path.length > 64 ||
      path.some((part) => (typeof part !== 'string' && typeof part !== 'number') || String(part).length > 1024)
    ) {
      this.lost = 'budget-exhausted';
      return;
    }
    const root = this.rootPath(path);
    const nested = root.length !== path.length;
    const key = JSON.stringify(root.map(String));
    const bytes = sourceBytes(key) + 128;
    const generation = this.generation(bytes, this.entries.get(key)?.bytes);
    if (generation === undefined) {
      this.lost = 'budget-exhausted';
      return;
    }
    this.entries.set(key, {
      generation,
      bytes,
      source: redacted
        ? { kind: 'unavailable', reason: 'redacted' }
        : verb === 'merge' || nested
        ? { kind: 'unavailable', reason: 'composite-unsupported' }
        : { kind: 'staged', frame: this.frame, generation },
    });
  }
  /** Return live credits once; retained occurrences keep only immutable generation IDs. */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    let bytes = 0;
    for (const entry of this.entries.values()) bytes += entry.bytes;
    this.release(this.entries.size, bytes);
    this.entries.clear();
  }
  redact(path: readonly (string | number)[]): void {
    const entry = this.entries.get(JSON.stringify(this.rootPath(path).map(String)));
    if (entry) entry.source = { kind: 'unavailable', reason: 'redacted' };
  }
  resolve(path: readonly string[]): ReadSource | undefined {
    if (this.closed) return { kind: 'unavailable', reason: 'scope-retired' };
    if (this.lost || this.pending) return { kind: 'unavailable', reason: this.lost ?? 'capture-failed' };
    let latest: { generation: number; source: ReadSource; bytes: number } | undefined;
    for (let depth = 1; depth <= path.length; depth++) {
      const entry = this.entries.get(JSON.stringify(path.slice(0, depth)));
      // An ancestor privacy mark still covers later descendant writes.
      if (entry?.source.kind === 'unavailable' && entry.source.reason === 'redacted') return entry.source;
      if (entry && (!latest || entry.generation >= latest.generation)) latest = entry;
      if (depth === path.length && latest === entry && entry) return entry.source;
    }
    return latest ? { kind: 'unavailable', reason: 'composite-unsupported' } : undefined;
  }
}
