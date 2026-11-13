import { canonicalSnapshot } from '../canonical-json/canonical.js';
import { CanonicalJsonError } from '../canonical-json/types.js';
import { valueFields } from './fields.js';
import { valueDigest } from './digest.js';
import { readableLabel, valueLimits } from './limits.js';
import { VALUE_OMISSION_REASONS, VALUE_RECORD_FORMAT, VALUE_TABLE_FORMAT, ValueTableError } from './types.js';
import type {
  ValueOmissionReason,
  ValueRecord,
  ValueReference,
  ValueTableEntry,
  ValueTableLimits,
  ValueTableOptions,
  ValueTableSnapshot,
  ValueTableWriter,
  ValueWriteResult,
} from './types.js';

/**
 * One record's bounded dictionary. The caller explicitly supplies its inline serving/redaction law.
 * Admission owns a complete served JSON snapshot before crypto. No original value or exception text is retained.
 */
export function createValueTable(options: ValueTableOptions): ValueTableWriter {
  const fields = valueFields(options, ['redact', 'limits'], ['redact'], 'invalid-options');
  if (typeof fields.redact !== 'function') throw new ValueTableError('invalid-options');
  const redact = fields.redact as (value: unknown) => unknown;
  const limits = valueLimits(fields.limits as Partial<ValueTableLimits> | undefined);
  const entries: ValueTableEntry[] = [];
  const byText = new Map<string, ValueReference>();
  const byId = new Map<string, string>();
  const omissions = Object.fromEntries(VALUE_OMISSION_REASONS.map((reason) => [reason, 0])) as Record<
    ValueOmissionReason,
    number
  >;
  let bytes = 0,
    attempts = 0,
    pending = 0,
    digestBytes = 0,
    atLeast = false;
  let stopped: ValueOmissionReason | undefined;
  const omit = (reason: ValueOmissionReason): ValueWriteResult => {
    if (omissions[reason] === Number.MAX_SAFE_INTEGER) atLeast = true;
    else omissions[reason]++;
    return { status: 'omitted', reason };
  };
  const stored = (reference: ValueReference, reused: boolean): ValueWriteResult => ({
    status: 'stored',
    reference,
    reused,
  });
  const capacity = (size: number): ValueOmissionReason | undefined =>
    entries.length >= limits.maxEntries ? 'entry-limit' : size > limits.maxBytes - bytes ? 'byte-limit' : undefined;
  const snapshot = (): ValueTableSnapshot =>
    Object.freeze({
      format: VALUE_TABLE_FORMAT,
      entries: Object.freeze([...entries]),
      bytes,
      attempts,
      pending,
      omissions: Object.freeze({ ...omissions }),
      atLeast,
    });
  return Object.freeze({
    async intern(label: string, value: unknown): Promise<ValueWriteResult> {
      const exceeded = attempts >= limits.maxAttempts;
      if (attempts === Number.MAX_SAFE_INTEGER) atLeast = true;
      else attempts++;
      if (exceeded) return omit('attempt-limit');
      if (!readableLabel(label)) return omit('invalid-label');
      let served: unknown;
      try {
        served = redact(value);
      } catch {
        return omit('redaction-failed');
      }
      let owned: ReturnType<typeof canonicalSnapshot>;
      try {
        owned = canonicalSnapshot(served, { maxBytes: limits.maxValueBytes, maxStringBytes: limits.maxValueBytes });
      } catch (error) {
        return omit(
          error instanceof CanonicalJsonError && !['unsupported', 'unicode', 'cycle', 'unreadable'].includes(error.code)
            ? 'value-limit'
            : 'invalid-value',
        );
      }
      const known = byText.get(owned.text);
      if (known) return stored(known, true);
      const full = capacity(owned.bytes);
      if (full) return omit(full);
      if (stopped) return omit(stopped);
      if (pending >= limits.maxInFlight) return omit('concurrency-limit');
      if (owned.bytes > limits.maxDigestBytes - digestBytes) return omit('digest-budget');
      digestBytes += owned.bytes;
      pending++;
      try {
        const id = await valueDigest(owned.text, limits.digestTimeoutMs);
        // Concurrent writes recheck both identity and capacity after their awaits, before one atomic admission.
        const held = byText.get(owned.text);
        if (held) return stored(held, true);
        if (byId.has(id)) {
          stopped = 'digest-collision';
          return omit(stopped);
        }
        const nowFull = capacity(owned.bytes);
        if (nowFull) return omit(nowFull);
        const reference = Object.freeze({ ref: id });
        entries.push(Object.freeze({ id, label, value: owned.value }));
        byText.set(owned.text, reference);
        byId.set(id, owned.text);
        bytes += owned.bytes;
        return stored(reference, false);
      } catch (error) {
        const reason =
          error instanceof ValueTableError && ['crypto-unavailable', 'digest-timeout'].includes(error.code)
            ? (error.code as 'crypto-unavailable' | 'digest-timeout')
            : 'digest-failed';
        if (reason !== 'digest-failed') stopped = reason;
        return omit(reason);
      } finally {
        pending--;
      }
    },
    snapshot,
    record<T>(record: T): ValueRecord<T> {
      return Object.freeze({ format: VALUE_RECORD_FORMAT, record, valueTable: snapshot() });
    },
  });
}
