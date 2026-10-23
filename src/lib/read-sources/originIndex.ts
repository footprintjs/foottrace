import type { ReadSource, ReadSourceGap } from './types.js';
import { sourceBytes, sourceKey } from './admission.js';

const unavailable = (reason: ReadSourceGap): ReadSource => ({ kind: 'unavailable', reason });
interface Fact {
  readonly at: number;
  readonly source: ReadSource;
}
interface Version extends Fact {
  readonly bytes: number;
  /** Latest descendant barrier at this version; a shallow fact, never a chain of old versions. */
  readonly barrier?: Fact;
}

/** Metadata-only per-key histories. No state generation, selected value or fingerprint is retained. */
export class OriginIndex {
  private readonly entries = new Map<string, Version[]>();
  private retained = 0;
  private tick = 0;
  private lostAt = Infinity;
  private loss: ReadSourceGap = 'budget-exhausted';
  private readonly seeded = new Set<string>();
  private retainedBytes = 0;
  constructor(private readonly maximum: number, readonly base: number, private readonly maxBytes = 4 * 1024 * 1024) {}
  get clock(): number {
    return this.tick;
  }
  get size(): number {
    return this.retained;
  }
  get bytes(): number {
    return this.retainedBytes;
  }
  get lost(): boolean {
    return this.lostAt !== Infinity;
  }
  fail(reason: ReadSourceGap): void {
    this.tick = Math.min(Number.MAX_SAFE_INTEGER, this.tick + 1);
    if (this.lostAt === Infinity) {
      this.lostAt = this.tick;
      this.loss = reason;
    }
  }
  /** Register a native frame namespace for future writes, without trusting a cloned base. */
  register(address: readonly string[]): boolean {
    if (this.lost) return false;
    if (address.length > 64) {
      this.fail('budget-exhausted');
      return false;
    }
    for (const part of address) sourceKey(part);
    const tuple = JSON.stringify(address);
    if (this.seeded.has(tuple)) return false;
    if (this.seeded.size >= this.maximum || this.retainedBytes + sourceBytes(tuple) > this.maxBytes) {
      this.fail('budget-exhausted');
      return false;
    }
    this.seeded.add(tuple);
    this.retainedBytes += sourceBytes(tuple);
    return true;
  }
  seed(state: unknown, address: readonly string[] = []): void {
    if (!this.register(address)) return;
    let container = state;
    for (const part of address) {
      sourceKey(part);
      if (!container || typeof container !== 'object') return;
      const descriptor = Object.getOwnPropertyDescriptor(container, part);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return;
      container = descriptor.value;
    }
    if (!container || typeof container !== 'object' || Array.isArray(container)) return;
    // Only native frame-address roots are admitted. Never enumerate private nested business fields.
    let work = 0;
    for (const key in container) {
      if (++work > this.maximum) {
        this.fail('budget-exhausted');
        return;
      }
      sourceKey(key);
      const slot = Object.getOwnPropertyDescriptor(container, key);
      if (!slot) continue;
      this.put(
        [...address, key],
        Object.hasOwn(slot, 'value') ? { kind: 'base', base: this.base } : unavailable('untracked-write'),
        0,
      );
    }
  }
  write(path: readonly string[], source: ReadSource): void {
    if (this.tick >= Number.MAX_SAFE_INTEGER - 1) {
      this.fail('budget-exhausted');
      return;
    }
    this.tick++;
    if (this.lostAt !== Infinity) return;
    if (path.length > 64) {
      this.fail('budget-exhausted');
      return;
    }
    try {
      for (const part of path) sourceKey(part);
    } catch {
      this.fail('budget-exhausted');
      return;
    }
    // Retain only roots under actual native frame namespaces, never private nested field names.
    for (let depth = 0; depth < path.length; depth++) {
      if (!this.seeded.has(JSON.stringify(path.slice(0, depth)))) continue;
      this.put(
        path.slice(0, depth + 1),
        depth + 1 === path.length ? source : unavailable('composite-unsupported'),
        this.tick,
        depth + 1 === path.length,
      );
    }
    // Replacing a native namespace invalidates its old descendants, even when its
    // parent is not a registered frame namespace. Only declared address names are retained.
    for (const tuple of this.seeded) {
      const namespace = JSON.parse(tuple) as string[];
      if (namespace.length >= path.length && path.every((part, index) => namespace[index] === part)) {
        this.put(namespace, source.kind === 'unavailable' ? source : unavailable('composite-unsupported'), this.tick);
      }
    }
  }
  private put(path: readonly string[], source: ReadSource, at: number, shadowsDescendants = true): void {
    if (this.lostAt !== Infinity) return;
    if (this.retained >= this.maximum) {
      this.fail('budget-exhausted');
      return;
    }
    const key = JSON.stringify(path);
    let versions = this.entries.get(key);
    if (at === 0 && versions?.[0]?.at === 0) return;
    const fact: Fact = { at, source: Object.freeze(source) };
    const barrier = shadowsDescendants ? fact : versions?.[versions.length - 1]?.barrier;
    const bytes = sourceBytes({ key, at, source, barrier });
    if (this.retainedBytes + bytes > this.maxBytes) {
      this.fail('budget-exhausted');
      return;
    }
    if (!versions) this.entries.set(key, (versions = []));
    if (at === 0) {
      if (versions[0]?.at === 0) return;
      versions.unshift({ ...fact, bytes, barrier });
    } else versions.push({ ...fact, bytes, barrier });
    this.retained++;
    this.retainedBytes += bytes;
  }
  /** Keep the last fact at/before the oldest live view, plus every newer fact.
   * Privacy and invalidation tombstones obey the same rule; loss is never repaired by pruning. */
  prune(oldestClock: number): void {
    for (const versions of this.entries.values()) {
      let keep = 0;
      while (keep + 1 < versions.length && versions[keep + 1].at <= oldestClock) keep++;
      for (let index = 0; index < keep; index++) {
        this.retained--;
        this.retainedBytes -= versions[index].bytes;
      }
      if (keep) versions.splice(0, keep);
    }
  }
  resolve(path: readonly string[], clock: number): ReadSource {
    if (clock >= this.lostAt) return unavailable(this.loss);
    let latest: Fact | undefined;
    for (let depth = 1; depth <= path.length; depth++) {
      const versions = this.entries.get(JSON.stringify(path.slice(0, depth)));
      if (!versions) continue;
      let lo = 0,
        hi = versions.length;
      while (lo < hi) {
        const middle = (lo + hi) >>> 1;
        if (versions[middle].at <= clock) lo = middle + 1;
        else hi = middle;
      }
      const version = versions[lo - 1];
      const candidate = depth === path.length ? version : version?.barrier;
      if (
        candidate &&
        (!latest ||
          candidate.at > latest.at ||
          (candidate.at === latest.at &&
            !(latest.at === 0 && latest.source.kind === 'unavailable' && candidate.source.kind === 'base')))
      )
        latest = candidate;
      if (depth === path.length && candidate && candidate === latest) return candidate.source;
    }
    // A missing index entry is NEVER silently interpreted as a base value.
    return latest?.source.kind === 'unavailable'
      ? latest.source
      : latest
      ? unavailable('composite-unsupported')
      : unavailable('untracked-write');
  }
}
export const createOriginIndex = (maximum: number, base: number, maxBytes?: number): OriginIndex =>
  new OriginIndex(maximum, base, maxBytes);
