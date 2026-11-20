import type { Touch } from '../../memory/verbs.js';
import { ABSENT, applyVerb, RecordedPayload, recordsTail } from '../../memory/verbs.js';
import { nativeGet } from '../../memory/pathOps.js';
import { spend } from '../recordValidation.js';
import { historyLookup, historyValue, type HistoryValue, type Transition } from './historyValue.js';

interface Chunk {
  readonly start: number;
  readonly data: readonly unknown[];
}

/**
 * Keep exact list writes as prefix lengths over immutable admitted chunks.
 * Each length is an independent snapshot. Appends preserve old entry values
 * without allocating or retaining a separate copy of the growing prefix.
 */
export function directHistory(
  touches: readonly Touch[],
  parts: string[],
  base: HistoryValue,
  budget: { left: number },
) {
  let current = base;
  let chunks: Chunk[] | undefined;
  const commits: number[] = [];
  const states = new Map<number, Transition>();
  for (const touch of touches) {
    const { bundle, commitIdx, verb } = touch;
    spend(budget, 4);
    const before = states.get(commitIdx)?.before ?? current;
    const payload = new RecordedPayload(bundle.updates, bundle.overwrite, false);
    const tail = recordsTail(verb) ? nativeGet(bundle.overwrite, parts) : undefined;
    if (Array.isArray(tail) && current.list) {
      // Reserve the referenced slots without visiting rows before the selected one.
      spend(budget, 4 * tail.length);
      const length: number = current.list.length + tail.length;
      const series: Chunk[] = chunks ?? [{ start: 0, data: current.value as readonly unknown[] }];
      // Empty operand chunks have no addressable data.
      if (tail.length) series.push({ start: current.list.length, data: tail });
      chunks = series;
      current = {
        present: true,
        value: undefined,
        list: {
          length,
          element(index) {
            if (index < 0 || index >= length) return historyValue(false, undefined);
            let low = 0;
            let high = series.length;
            while (low < high) {
              const middle = (low + high) >>> 1;
              if (series[middle].start <= index) low = middle + 1;
              else high = middle;
            }
            const chunk = series[low - 1];
            // Native append spreads the list and its tail, making a hole an own undefined.
            const offset = index - chunk.start;
            return historyValue(true, Object.hasOwn(chunk.data, offset) ? chunk.data[offset] : undefined);
          },
        },
      };
    } else {
      const value = applyVerb(verb, current.value, payload, parts);
      if (Array.isArray(value)) spend(budget, 4 * value.length);
      current = historyValue(value !== ABSENT, value);
      chunks = undefined;
    }
    if (!states.has(commitIdx)) commits.push(commitIdx);
    states.set(commitIdx, { before, after: current });
  }
  return historyLookup(commits, states, base);
}
