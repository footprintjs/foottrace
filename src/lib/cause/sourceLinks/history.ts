import { rowsUnderRoot } from '../../memory/commitLogUtils.js';
import { nativeGet, nativeHas } from '../../memory/pathOps.js';
import type { CommitBundle } from '../../memory/types.js';
import { foldKey } from '../../memory/verbs.js';
import { pathSegments } from '../../record-paths/codec.js';

interface Transition {
  readonly before: unknown;
  readonly after: unknown;
  readonly beforePresent: boolean;
  readonly afterPresent: boolean;
}

/**
 * Count the contiguous prefix whose state can be replayed from the admitted base.
 * A bundle without an index cannot establish where an externally supplied slice starts.
 */
export function accountedCount(log: readonly CommitBundle[], base: object | undefined): number {
  if (base === undefined) return 0;
  let count = 0;
  while (log[count]?.idx === count) count++;
  return count;
}

/** Observe based commit generations with the ordinary replay verb law, once per key. */
export function keyHistory(log: readonly CommitBundle[], base: Record<string, unknown>, key: string, stop: number) {
  const segments = pathSegments(key);
  const root = segments.slice(0, 1);
  let beforePresent = false;
  const states = new Map<number, Transition>();
  const commits: number[] = [];
  foldKey(rowsUnderRoot(log, key, stop), segments, {
    start: nativeGet(base, root),
    startPresent: nativeHas(base, root),
    generations: {
      at(_, state) {
        beforePresent = nativeHas(state, segments);
        return true;
      },
      keep(index, before, after, state) {
        commits.push(index);
        states.set(index, { before, after, beforePresent, afterPresent: nativeHas(state, segments) });
      },
    },
  });
  return {
    commits,
    transition: (index: number) => states.get(index),
    at(index: number): { value: unknown; present: boolean } {
      let low = 0;
      let high = commits.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (commits[mid] <= index) low = mid + 1;
        else high = mid;
      }
      if (low === 0) return { value: nativeGet(base, segments), present: nativeHas(base, segments) };
      const state = states.get(commits[low - 1])!;
      return { value: state.after, present: state.afterPresent };
    },
  };
}

export type KeyHistory = ReturnType<typeof keyHistory>;

/**
 * A row belongs to this commit when the commit wrote its key and the
 * accounted list ended before its position. Compare lengths; no earlier
 * element is part of the row's proof.
 */
export function appendedStart(bundle: CommitBundle, key: string, change: Transition | undefined): number | undefined {
  if (!change || !Array.isArray(change.after) || !bundle.trace.some((row) => row.path === key)) return undefined;
  if (!change.beforePresent) return 0;
  if (!Array.isArray(change.before) || change.before.length >= change.after.length) return undefined;
  return change.before.length;
}
