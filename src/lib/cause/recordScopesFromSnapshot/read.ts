import { boundedList } from '../../evidence/admission.js';
import { recordName, recordOwn, refuseRecord, spend } from '../../evidence/recordData.js';
import type { LogAddress } from '../../memory/eventPosition.js';

export const MAX_SCOPES = 256;
export const MAX_LOG = 4096;
export const MAX_DISCOVERY_DEPTH = 64;
export const MAX_WORK = 100_000;

export type Budget = { left: number };

export function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? recordOwn(value, key) : undefined;
}

export function plain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function list(value: unknown, budget: Budget, maximum = budget.left): readonly unknown[] {
  const count = field(value, 'length');
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw refuseRecord();
  if (count > maximum) throw refuseRecord('node-limit');
  spend(budget, count);
  return boundedList(
    value,
    maximum,
    (item) => {
      // An explicit undefined has no meaning in an admitted snapshot array.
      if (item === undefined) throw refuseRecord();
      return item;
    },
    {
      refuse: refuseRecord,
      overflow: 'node-limit',
      freeze: true,
      descriptors: { translateTrapErrors: true, requireOwnValue: true },
      translateArrayErrors: true,
      expectedLength: count,
    },
  );
}

export function snapshotAddress(value: unknown, budget: Budget): LogAddress {
  if (!plain(value)) throw refuseRecord();
  const logRunId = recordName(field(value, 'logRunId'));
  const drillPath = list(field(value, 'drillPath'), budget, MAX_DISCOVERY_DEPTH + 1).map((id) => recordName(id));
  if (drillPath.reduce((size, id) => size + id.length, logRunId.length) > 1536) throw refuseRecord();
  return Object.freeze({ logRunId, drillPath: Object.freeze(drillPath) });
}

export function sameAddress(a: LogAddress, b: LogAddress): boolean {
  return (
    a.logRunId === b.logRunId &&
    a.drillPath.length === b.drillPath.length &&
    a.drillPath.every((part, index) => part === b.drillPath[index])
  );
}
