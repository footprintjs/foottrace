import type { StoredRecord } from '../time-travel/storedRecord.js';
import { addressKey, addressOf, count, omissionsOf, storedRow, subjectKey, subjectOf } from './codec.js';
import { arrayLength, fields, own } from './fields.js';
import { observationLimits, OBSERVATION_LIMITS, OBSERVATION_OMISSIONS, OBSERVATION_VERSION } from './limits.js';
import { ObservationError } from './types.js';
import type { ObservationEvidence, ObservationGap, ObservationReadRequest, ObservationRow } from './types.js';

const mapGet = Map.prototype.get;
const noRows = Object.freeze([]);
const result = (
  status: ObservationEvidence['status'],
  subjectBinding: ObservationEvidence['subjectBinding'],
  rows: readonly ObservationRow[],
  gaps: readonly ObservationGap[],
): ObservationEvidence =>
  Object.freeze({
    status,
    authenticity: 'unverified',
    subjectBinding,
    rows: Object.freeze(rows),
    gaps: Object.freeze(gaps),
  });
const absent = (code: ObservationGap['code']): ObservationEvidence =>
  result('not-collected', 'unmatched', noRows, [Object.freeze({ code })]);

/** Read typed observations beside existing logs; collection completeness is never authenticity or causation. */
export function readObservationRecord(stored: StoredRecord, request: ObservationReadRequest): ObservationEvidence {
  let address, subject, limits;
  try {
    const config = fields(request, ['address', 'subject', 'limits'], ['address', 'subject'], 'invalid-options');
    address = addressOf(config.address);
    subject = subjectOf(config.subject);
    limits = observationLimits(config.limits as ObservationReadRequest['limits']);
    if (addressKey(address) === addressKey(subject.nativeAddress)) throw new ObservationError('invalid-options');
  } catch {
    throw new ObservationError('invalid-options');
  }
  try {
    const logs = own(stored, 'logs');
    if (Object.getPrototypeOf(logs) !== Map.prototype) return absent('invalid-data');
    const log = Reflect.apply(mapGet, logs, [addressKey(address)]);
    if (log === undefined) return absent('not-collected');
    if (addressKey(addressOf(own(log, 'address'))) !== addressKey(address)) return absent('scope-mismatch');
    const meta = own(log, 'meta'),
      opened = own(meta, 'opened');
    const declaration = own(opened, 'observations');
    if (declaration === undefined) return absent('not-collected');
    const header = fields(declaration, ['v', 'subject']);
    if (header.v !== OBSERVATION_VERSION) return absent('unsupported-version');
    if (subjectKey(subjectOf(header.subject)) !== subjectKey(subject)) return absent('scope-mismatch');
    const gaps: ObservationGap[] = [],
      rows: ObservationRow[] = [];
    const gap = (code: ObservationGap['code'], sequence?: number) => {
      gaps.push(Object.freeze({ code, ...(sequence === undefined ? {} : { sequence }) }));
    };
    if (own(log, 'complete') !== true || arrayLength(own(log, 'gaps')) > 0) gap('incomplete-record');
    if (arrayLength(own(stored, 'unread')) > 0) gap('unread-entry');
    let expectedRows: number | undefined;
    try {
      const closed = own(meta, 'closed'),
        end = fields(own(closed, 'observations'), ['v', 'rows', 'omissions']);
      if (end.v !== OBSERVATION_VERSION) gap('unsupported-version');
      else if (!count(end.rows) || end.rows > OBSERVATION_LIMITS.maxRows) gap('invalid-data');
      else {
        expectedRows = end.rows;
        const omissions = omissionsOf(end.omissions);
        if (OBSERVATION_OMISSIONS.some((key) => omissions[key] > 0)) gap('omitted');
      }
    } catch {
      gap('incomplete-record');
    }
    const notes = own(log, 'notes'),
      length = arrayLength(notes),
      seen = new Set<number>();
    if (length > limits.maxRows) gap('row-limit');
    let bytes = 0,
      observationIndex = 0;
    for (let index = 0; index < Math.min(length, limits.maxRows); index++) {
      try {
        const note = own(notes, String(index));
        if (own(note, 'kind') !== 'observation') continue;
        observationIndex++;
        const row = storedRow(own(note, 'data'), limits);
        if (seen.has(row.sequence)) {
          gap('duplicate-sequence', row.sequence);
          continue;
        }
        seen.add(row.sequence);
        if (row.sequence !== observationIndex) gap('missing-note', row.sequence);
        if (bytes + row.bytes > limits.maxBytes) {
          gap('byte-limit', row.sequence);
          break;
        }
        bytes += row.bytes;
        rows.push(
          Object.freeze({
            ...row.payload,
            sequence: row.sequence,
            evidenceRef: JSON.stringify([address.logRunId, ...address.drillPath, 'observation', row.sequence]),
          }),
        );
      } catch (error) {
        gap(error instanceof ObservationError && error.code === 'byte-limit' ? 'byte-limit' : 'invalid-data');
      }
    }
    if (expectedRows === undefined || expectedRows !== rows.length) gap('count-mismatch');
    return result(gaps.length ? 'partial' : 'collected', 'matched', rows, gaps);
  } catch {
    return absent('invalid-data');
  }
}
