import { readObservationRecord, readStoredRecord } from '../../../src/index.js';
import { createObservationRecord, memorySink } from '../../../src/write.js';
import type { ObservationLimits, ObservationSubject, StoredRecord } from '../../../src/index.js';
import type { RecordEntry } from '../../../src/write.js';

export const address = { logRunId: 'host-observations', drillPath: [] };
export const subject: ObservationSubject = {
  nativeAddress: { logRunId: 'native-run', drillPath: [] },
  runId: 'native-run',
  runtimeStageId: 'request#0',
  attemptId: 'request#0@1.1@1',
  operationRef: 'operation-1',
};
export const observation = (event = 'gateway.response', elapsedMs = 50) => ({
  event,
  observedAt: { clock: 'local-observer', elapsedMs },
  facts: { status: 504 },
});
export function saved(count = 2, limits?: ObservationLimits): RecordEntry[] {
  const sink = memorySink(),
    writer = createObservationRecord({ sink, address, subject, limits });
  for (let i = 0; i < count; i++) writer.note(observation(i ? 'service.response' : 'gateway.response', 50 + i));
  writer.close();
  return JSON.parse(JSON.stringify(sink.entries)) as RecordEntry[];
}
export const reopen = (entries: unknown[], limits?: ObservationLimits) =>
  readObservationRecord(readStoredRecord(entries), { address, subject, limits });
export const fromStored = (stored: StoredRecord) => readObservationRecord(stored, { address, subject });
export const gapCodes = (entries: unknown[]) => reopen(entries).gaps.map((gap) => gap.code);
