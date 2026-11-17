import { nativeExecution } from '../../ids/nativeExecution.js';
import type { LogAddress } from '../../memory/eventPosition.js';
import { addressOf, recordName, recordOwn, RecordRefusal, spend } from '../recordValidation.js';

export interface SubflowAdmission {
  readonly budget: { left: number };
  bytes: number;
  references: number;
}
export const admission = (budget: { left: number }): SubflowAdmission => ({ budget, bytes: 0, references: 0 });
export const refuse = (): never => {
  throw new RecordRefusal();
};

/** Exact own-data records; a null prototype is inert, an inherited/custom object is not evidence. */
export function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  state: SubflowAdmission,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return refuse();
  const keys = Reflect.ownKeys(value);
  spend(state.budget, keys.length + 1);
  if (
    keys.some((key) => typeof key !== 'string' || (!required.includes(key) && !optional.includes(key))) ||
    required.some((key) => !keys.includes(key))
  )
    return refuse();
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return refuse();
    copy[key as string] = descriptor.value;
  }
  return copy;
}

/** Check the count before inspecting entries; no element getter or custom array property is accepted. */
export function list<T>(
  value: unknown,
  maximum: number,
  read: (value: unknown) => T,
  state: SubflowAdmission,
): readonly T[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return refuse();
  const length = integer(recordOwn(value, 'length'));
  if (length > maximum) throw new RecordRefusal('node-limit');
  spend(state.budget, length + 1);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== length + 1 ||
    keys.some(
      (key) =>
        typeof key !== 'string' || (key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)),
    )
  )
    return refuse();
  const result: T[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return refuse();
    result.push(read(descriptor.value));
  }
  return Object.freeze(result);
}

/** UTF-8 byte size without allocation; lone surrogates encode as the three-byte replacement character. */
function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit < 0x80) bytes++;
    else if (unit < 0x800) bytes += 2;
    else if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

export function name(value: unknown, state: SubflowAdmission, path = false): string {
  const result = recordName(value, path);
  spend(state.budget, 1);
  state.bytes += utf8Bytes(result);
  if (state.bytes > 64 * 1024) throw new RecordRefusal('node-limit');
  return result;
}
export function execution(value: unknown, state: SubflowAdmission): string {
  const result = name(value, state);
  return nativeExecution(result) ? result : refuse();
}
export function address(value: unknown, state: SubflowAdmission): LogAddress {
  const raw = object(value, ['logRunId', 'drillPath'], [], state);
  const logRunId = name(raw.logRunId, state);
  const drillPath = list(raw.drillPath, 16, (id) => execution(id, state), state);
  return addressOf({ logRunId, drillPath });
}
export function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : refuse();
}
export function literal<T extends string>(value: unknown, allowed: readonly T[]): T {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : refuse();
}
export function status(value: unknown): 'captured' | 'partial' {
  return literal(value, ['captured', 'partial']);
}
export function version(value: unknown): 1 {
  return value === 1 ? 1 : refuse();
}
export function limitations<T extends string>(
  value: unknown,
  allowed: readonly T[],
  capture: 'captured' | 'partial',
  state: SubflowAdmission,
): readonly T[] {
  const values = list(value, allowed.length, (item) => literal(item, allowed), state);
  if (new Set(values).size !== values.length || (values.length > 0 && capture === 'captured')) return refuse();
  return values;
}
export function sameAddress(a: LogAddress, b: LogAddress): boolean {
  return (
    a.logRunId === b.logRunId &&
    a.drillPath.length === b.drillPath.length &&
    a.drillPath.every((id, index) => id === b.drillPath[index])
  );
}
