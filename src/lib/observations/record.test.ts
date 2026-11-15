import { describe, expect, it } from 'vitest';
import { readObservationRecord, readStoredRecord } from '../../index.js';
import { createObservationRecord, memorySink } from '../../write.js';

const address = { logRunId: 'host-observations', drillPath: [] };
const subject = {
  nativeAddress: { logRunId: 'native-run', drillPath: [] },
  runId: 'native-run',
  runtimeStageId: 'request#0',
  attemptId: 'request#0@1.1@1',
  operationRef: 'operation-1',
};
const note = (event = 'gateway.response', elapsedMs = 50) => ({
  event,
  observedAt: { clock: 'local-observer', elapsedMs },
  facts: { status: 504 },
});

describe('optional observation records on the existing storage framing', () => {
  it('reopens actual writer entries without claiming authenticated cause or customer delivery', () => {
    const sink = memorySink();
    const writer = createObservationRecord({ sink, address, subject });
    expect(writer.note(note())).toEqual({ status: 'noted', sequence: 1 });
    expect(writer.note(note('service.response', 80))).toEqual({ status: 'noted', sequence: 2 });
    writer.close();
    const persisted = JSON.parse(JSON.stringify(sink.entries));
    const evidence = readObservationRecord(readStoredRecord(persisted), { address, subject });
    expect(evidence.status).toBe('collected');
    expect(evidence.authenticity).toBe('unverified');
    expect(evidence.subjectBinding).toBe('matched');
    expect(evidence.rows.map((row) => [row.event, row.sequence])).toEqual([
      ['gateway.response', 1],
      ['service.response', 2],
    ]);
    expect(evidence).not.toHaveProperty('rootCause');
    expect(evidence).not.toHaveProperty('customerDelivery');
  });
});
