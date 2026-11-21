import type { LogAddress } from '../memory/eventPosition.js';
import { boundedList, boundedName, EvidenceRefusal, evidenceRefusalCode, ownData, spendFields } from './admission.js';
import type { GapCode } from './codes.js';

const recordFamily = Symbol();
/** Loader refusals stay distinct from graph-port refusals so a failed host load keeps its original classification. */
export class RecordRefusal extends EvidenceRefusal {
  constructor(readonly code: GapCode = 'invalid-data') {
    super(code, 'cause: record unavailable', recordFamily);
  }
}
export const recordRefusalCode = (error: unknown): GapCode | undefined => evidenceRefusalCode(error, recordFamily);
export const refuseRecord = (code?: GapCode): RecordRefusal => new RecordRefusal(code);
const recordDescriptors = { translateTrapErrors: true, requireOwnValue: true };
export function recordOwn(value: unknown, key: string): unknown {
  return ownData(value, key, refuseRecord, recordDescriptors);
}
export function names(value: unknown, maximum = 128, path = false, expectedLength?: number): string[] {
  return recordList(value, maximum, expectedLength).map((item) => recordName(item, path));
}
export function recordName(value: unknown, path = false): string {
  return boundedName(value, 1024, refuseRecord, path);
}
export function recordList(value: unknown, maximum: number, expectedLength?: number): readonly unknown[] {
  return boundedList(value, maximum, (item) => item, {
    refuse: refuseRecord,
    overflow: 'node-limit',
    freeze: false,
    descriptors: recordDescriptors,
    expectedLength,
  });
}
export const RECORD_ADDRESS_MAX_DEPTH = 16;

export function addressOf(value: unknown): LogAddress {
  const logRunId = recordName(recordOwn(value, 'logRunId')),
    drillPath = names(recordOwn(value, 'drillPath'), RECORD_ADDRESS_MAX_DEPTH);
  if (logRunId.length + drillPath.reduce((n, s) => n + s.length, 0) > 1536) throw new RecordRefusal();
  return Object.freeze({ logRunId, drillPath: Object.freeze(drillPath) });
}
export function spend(budget: { left: number }, count: number): void {
  spendFields(budget, count, refuseRecord);
}
export const addressKey = (a: LogAddress): string => JSON.stringify([a.logRunId, ...a.drillPath]);
