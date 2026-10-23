import { DELIM, pathSegments } from '../memory/paths.js';
import type { TraceEntry } from '../memory/types.js';
import type { OriginIndex } from './originIndex.js';

/** Bound the extra metadata work before calling the record's one canonical path codec. */
function segments(path: string): string[] {
  if (typeof path !== 'string' || path.length > 64 * 1024) throw new RangeError();
  let count = 1;
  for (let index = 0; index < path.length; index++) if (path[index] === DELIM && ++count > 64) throw new RangeError();
  return pathSegments(path);
}

export function invalidateOrigins(index: OriginIndex, trace: readonly TraceEntry[], maximum: number): void {
  if (index.lost) return;
  if (trace.length > maximum) {
    index.fail('budget-exhausted');
    return;
  }
  try {
    for (const row of trace) index.write(segments(row.path), { kind: 'unavailable', reason: 'untracked-write' });
  } catch {
    index.fail('capture-failed');
  }
}

export function confirmOrigins(
  index: OriginIndex,
  trace: readonly TraceEntry[],
  redacted: ReadonlySet<string>,
  commitIdx: number,
  maximum: number,
): void {
  if (index.lost) return;
  if (trace.length + redacted.size > maximum) {
    index.fail('budget-exhausted');
    return;
  }
  let work = trace.length;
  const hidden = new Set<string>();
  const ancestors = new Set<string>();
  try {
    // Ephemeral privacy verdicts, never retained in the source index. Charge before each prefix.
    for (const mark of redacted) {
      const path = segments(mark);
      ancestors.add(JSON.stringify(path));
      for (let depth = 1; depth <= path.length; depth++) {
        if (++work > maximum) {
          index.fail('budget-exhausted');
          return;
        }
        hidden.add(JSON.stringify(path.slice(0, depth)));
      }
    }
    for (const row of trace) {
      const path = segments(row.path);
      let redacted = hidden.has(JSON.stringify(path));
      if (ancestors.size && !redacted)
        for (let depth = 1; depth < path.length; depth++) {
          if (++work > maximum) {
            index.fail('budget-exhausted');
            return;
          }
          if (ancestors.has(JSON.stringify(path.slice(0, depth)))) {
            redacted = true;
            break;
          }
        }
      index.write(path, redacted ? { kind: 'unavailable', reason: 'redacted' } : { kind: 'committed', commitIdx });
    }
  } catch {
    index.fail('capture-failed');
  }
}
