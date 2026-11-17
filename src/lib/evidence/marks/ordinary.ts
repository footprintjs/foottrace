import { boundedSlots, ownData } from '../admission.js';
import type { MarkAdmission } from './contract.js';

/** Both mark strategies admit the same outer shape and raw length before any slot policy. */
export function ordinarySlots<T>(
  value: unknown,
  maximum: number,
  read: (index: number) => T,
  { refuse, descriptors, overflow = 'invalid-data' }: MarkAdmission,
): readonly T[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw refuse();
  return boundedSlots(value, maximum, read, { refuse, overflow, freeze: true, descriptors });
}

/** Strict lists read every slot through the caller's unchanged descriptor policy. */
export function ordinaryList<T>(
  value: unknown,
  maximum: number,
  read: (item: unknown) => T,
  admission: MarkAdmission,
): readonly T[] {
  return ordinarySlots(
    value,
    maximum,
    (index) => read(ownData(value, String(index), admission.refuse, admission.descriptors)),
    admission,
  );
}
