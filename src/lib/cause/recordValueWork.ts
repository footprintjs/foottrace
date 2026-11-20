import { equalWithTextWork } from '../memory/equality.js';
import { withLogValueReader } from '../memory/logModel.js';
import type { CommitBundle } from '../memory/types.js';
import type { RecordInspection } from './recordTypes.js';
import { copyRecordValue, RecordRefusal, recordRefusalCode } from './recordValidation.js';

/** Selected text comparisons have their own allowance. Admission counts structure only. */
export function recordTextEquality(maximum: number) {
  let left = maximum;
  return (a: unknown, b: unknown): boolean =>
    equalWithTextWork(a, b, (units) => {
      left -= units;
      if (left < 0) throw new RecordRefusal('truncated');
    });
}

/** Synchronous fold work keeps no allowance or result after its owning read completes. */
export function withRecordValueReads<T>(log: readonly CommitBundle[], maximum: number, read: () => T): T {
  return withLogValueReader(log, { copyValue: copyRecordValue, equal: recordTextEquality(maximum) }, read);
}

export function withRecordValueFallback<T>(read: () => T, truncated: () => T): T {
  try {
    return read();
  } catch (error) {
    if (recordRefusalCode(error) !== 'truncated') throw error;
    return truncated();
  }
}

export function truncatedRecordRead(): RecordInspection {
  const gaps = [{ code: 'truncated' as const, evidence: [] }];
  return { adjacency: { edges: [], complete: false, gaps }, gaps };
}
