import { EventLog } from '../memory/EventLog.js';
import type { RecordSink } from '../memory/sink.js';
import { addressKey, addressOf, inputPayload, storedRow, subjectOf } from './codec.js';
import { fields, own } from './fields.js';
import { observationLimits, OBSERVATION_VERSION } from './limits.js';
import { ObservationError } from './types.js';
import type { ObservationOmission, ObservationRecordOptions, ObservationWriter } from './types.js';

function sinkOf(input: unknown): RecordSink {
  if (!input || typeof input !== 'object') throw new ObservationError('invalid-options');
  for (const name of ['opened', 'commit', 'note', 'closed'])
    if (typeof own(input, name) !== 'function') throw new ObservationError('invalid-options');
  for (const name of ['flush', 'onFailure']) {
    const value = own(input, name);
    if (value !== undefined && typeof value !== 'function') throw new ObservationError('invalid-options');
  }
  return input as RecordSink;
}

/** Opt-in notes on an independent existing EventLog. The host serves/redacts input before this call. */
export function createObservationRecord(options: ObservationRecordOptions): ObservationWriter {
  let config: Record<string, unknown>, sink: RecordSink, address, subject, limits;
  try {
    config = fields(
      options,
      ['sink', 'address', 'subject', 'limits'],
      ['sink', 'address', 'subject'],
      'invalid-options',
    );
    limits = observationLimits(config.limits as ObservationRecordOptions['limits']);
    address = addressOf(config.address);
    subject = subjectOf(config.subject);
    sink = sinkOf(config.sink);
    if (addressKey(address) === addressKey(subject.nativeAddress)) throw new ObservationError('invalid-options');
  } catch {
    throw new ObservationError('invalid-options');
  }
  const log = new EventLog({}, { sink, address, meta: { observations: { v: OBSERVATION_VERSION, subject } } });
  const omissions: Record<ObservationOmission, number> = { 'invalid-data': 0, 'row-limit': 0, 'byte-limit': 0 };
  let rows = 0,
    bytes = 0,
    closed = false;
  const omitted = (reason: ObservationOmission) => {
    omissions[reason] = Math.min(Number.MAX_SAFE_INTEGER, omissions[reason] + 1);
    return Object.freeze({ status: 'omitted' as const, reason });
  };
  return Object.freeze({
    note(input: unknown) {
      if (closed) return Object.freeze({ status: 'omitted' as const, reason: 'closed' as const });
      if (rows >= limits.maxRows) return omitted('row-limit');
      try {
        const payload = inputPayload(input, limits),
          sequence = rows + 1;
        const data = { v: OBSERVATION_VERSION, sequence, ...payload },
          admitted = storedRow(data, limits);
        if (bytes + admitted.bytes > limits.maxBytes) return omitted('byte-limit');
        rows = sequence;
        bytes += admitted.bytes;
        log.note('observation', data);
        return Object.freeze({ status: 'noted' as const, sequence });
      } catch (error) {
        return omitted(
          error instanceof ObservationError && error.code === 'byte-limit' ? 'byte-limit' : 'invalid-data',
        );
      }
    },
    close() {
      if (closed) return;
      closed = true;
      log.close('ok', { observations: { v: OBSERVATION_VERSION, rows, omissions: { ...omissions } } });
    },
  });
}
