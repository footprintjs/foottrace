import { canonicalSnapshot } from '../canonical-json/canonical.js';
import { CanonicalJsonError } from '../canonical-json/types.js';
import { valueFields, valueRows } from './fields.js';
import { valueDigest } from './digest.js';
import { readableLabel, valueId, valueLimits } from './limits.js';
import { VALUE_OMISSION_REASONS, VALUE_RECORD_FORMAT, VALUE_TABLE_FORMAT, ValueTableError } from './types.js';
import type { JsonValue } from '../canonical-json/types.js';
import type {
  OpenValueRecord,
  ValueOmissionReason,
  ValueTableEntry,
  ValueTableLimits,
  ValueTableReader,
  ValueTableSnapshot,
} from './types.js';

const tableFields = ['format', 'entries', 'bytes', 'attempts', 'pending', 'omissions', 'atLeast'];
const count = (input: unknown): input is number =>
  typeof input === 'number' && Number.isSafeInteger(input) && input >= 0;

/** Own all table metadata and values before the first await; no borrowed input is frozen. */
function admitTable(input: unknown, limits: ValueTableLimits): { snapshot: ValueTableSnapshot; texts: string[] } {
  const fields = valueFields(input, tableFields);
  if (fields.format !== VALUE_TABLE_FORMAT) throw new ValueTableError('unsupported-format');
  if (!count(fields.bytes) || !count(fields.attempts) || !count(fields.pending) || typeof fields.atLeast !== 'boolean')
    throw new ValueTableError('invalid-table');
  if (fields.bytes > limits.maxBytes || fields.pending > limits.maxInFlight) throw new ValueTableError('table-limit');
  const declared = valueFields(fields.omissions, VALUE_OMISSION_REASONS);
  const omissions = Object.create(null) as Record<ValueOmissionReason, number>;
  for (const reason of VALUE_OMISSION_REASONS) {
    const value = declared[reason];
    if (!count(value)) throw new ValueTableError('invalid-table');
    omissions[reason] = value;
  }
  const entries: ValueTableEntry[] = [],
    texts: string[] = [];
  const ids = new Set<string>();
  let bytes = 0;
  for (const row of valueRows(fields.entries, limits.maxEntries)) {
    const entry = valueFields(row, ['id', 'label', 'value']);
    if (!valueId(entry.id) || ids.has(entry.id) || !readableLabel(entry.label))
      throw new ValueTableError('invalid-table');
    ids.add(entry.id);
    let owned: ReturnType<typeof canonicalSnapshot>;
    try {
      owned = canonicalSnapshot(entry.value, { maxBytes: limits.maxValueBytes, maxStringBytes: limits.maxValueBytes });
    } catch (error) {
      throw new ValueTableError(
        error instanceof CanonicalJsonError && !['unsupported', 'unicode', 'cycle', 'unreadable'].includes(error.code)
          ? 'table-limit'
          : 'invalid-table',
      );
    }
    bytes += owned.bytes;
    if (bytes > limits.maxBytes || bytes > limits.maxDigestBytes) throw new ValueTableError('table-limit');
    entries.push(Object.freeze({ id: entry.id, label: entry.label, value: owned.value }));
    texts.push(owned.text);
  }
  if (bytes !== fields.bytes || fields.attempts < entries.length) throw new ValueTableError('invalid-table');
  return {
    snapshot: Object.freeze({
      format: VALUE_TABLE_FORMAT,
      entries: Object.freeze(entries),
      bytes,
      attempts: fields.attempts,
      pending: fields.pending,
      omissions: Object.freeze(omissions),
      atLeast: fields.atLeast,
    }),
    texts,
  };
}

/** Verify every content id with SHA-256. A partial or unverifiable table never becomes a reader. */
export async function readValueTable(input: unknown, requested?: Partial<ValueTableLimits>): Promise<ValueTableReader> {
  const limits = valueLimits(requested);
  const { snapshot, texts } = admitTable(input, limits);
  const values = new Map<string, JsonValue>();
  for (let i = 0; i < snapshot.entries.length; i++) {
    const entry = snapshot.entries[i];
    if ((await valueDigest(texts[i], limits.digestTimeoutMs)) !== entry.id)
      throw new ValueTableError('digest-mismatch');
    values.set(entry.id, entry.value);
  }
  return Object.freeze({
    snapshot,
    resolve(input: unknown): JsonValue {
      const fields = valueFields(input, ['ref'], ['ref'], 'invalid-reference');
      if (!valueId(fields.ref)) throw new ValueTableError('invalid-reference');
      if (!values.has(fields.ref)) throw new ValueTableError('dangling-reference');
      return values.get(fields.ref)!;
    },
  });
}

/**
 * Open the opt-in envelope. Older records pass through by identity, without crypto or payload inspection.
 * The opaque record remains caller-owned; only the selected envelope fields and table are snapshotted.
 */
export async function readValueRecord(input: unknown, limits?: Partial<ValueTableLimits>): Promise<OpenValueRecord> {
  let format: unknown;
  try {
    const descriptor =
      input !== null && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'format') : undefined;
    format = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    throw new ValueTableError('invalid-record');
  }
  if (typeof format !== 'string' || !format.startsWith('foottrace.value-record.')) return { record: input };
  if (format !== VALUE_RECORD_FORMAT) throw new ValueTableError('unsupported-format');
  const fields = valueFields(input, ['format', 'record', 'valueTable'], undefined, 'invalid-record');
  const record = fields.record;
  return Object.freeze({ record, values: await readValueTable(fields.valueTable, limits) });
}
