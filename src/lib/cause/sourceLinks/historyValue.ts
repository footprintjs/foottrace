export interface HistoryValue {
  readonly present: boolean;
  readonly value: unknown;
  readonly list?: {
    readonly length: number;
    element(index: number): HistoryValue;
  };
}

const absent: HistoryValue = { present: false, value: undefined };

export function historyValue(present: boolean, value: unknown): HistoryValue {
  if (!present) return absent;
  if (!Array.isArray(value)) return { present, value };
  return {
    present,
    value,
    list: {
      length: value.length,
      element: (index) => historyValue(index >= 0 && index < value.length && Object.hasOwn(value, index), value[index]),
    },
  };
}

export interface Transition {
  readonly before: HistoryValue;
  readonly after: HistoryValue;
}

/** The last value before the first position greater than index, or the admitted base. */
export function historyLookup(commits: readonly number[], states: ReadonlyMap<number, Transition>, base: HistoryValue) {
  return {
    commits,
    transition: (index: number) => states.get(index),
    at(index: number): HistoryValue {
      let low = 0;
      let high = commits.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (commits[mid] <= index) low = mid + 1;
        else high = mid;
      }
      return low === 0 ? base : states.get(commits[low - 1])!.after;
    },
  };
}
