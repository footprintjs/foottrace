import type { GapCode } from './codes.js';

/** One refusal representation; subclasses preserve the graph-port and record-loader boundaries. */
export class EvidenceRefusal extends Error {
  constructor(readonly code: GapCode, message: string) {
    super(message);
  }
}

export type RefuseEvidence = (code?: GapCode) => Error;
interface DescriptorPolicy {
  readonly translateTrapErrors: boolean;
  readonly requireOwnValue: boolean;
}

/** Read data descriptors only; each boundary keeps its existing treatment of proxy traps. */
export function ownData(value: unknown, key: string, refuse: RefuseEvidence, policy: DescriptorPolicy): unknown {
  if (!value || typeof value !== 'object') throw refuse();
  let descriptor: PropertyDescriptor | undefined;
  if (policy.translateTrapErrors) {
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw refuse();
    }
  } else descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (policy.requireOwnValue ? !Object.hasOwn(descriptor, 'value') : !('value' in descriptor)) throw refuse();
  return descriptor.value;
}

/** Names share one grammar, with explicit limits and the record path separator exception. */
export function boundedName(value: unknown, maximum: number, refuse: RefuseEvidence, path = false): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > maximum ||
    (path ? /[\u0000-\u001e\u007f-\u009f]/ : /[\u0000-\u001f\u007f-\u009f]/).test(value)
  )
    throw refuse();
  return value;
}

/** Bound iteration before reading entries, without invoking element accessors. */
export function boundedList<T>(
  value: unknown,
  maximum: number,
  read: (item: unknown) => T,
  options: {
    readonly refuse: RefuseEvidence;
    readonly overflow: GapCode;
    readonly freeze: boolean;
    readonly descriptors: DescriptorPolicy;
    /** Optional prior shape inspection must refer to the same admitted length. */
    readonly expectedLength?: number;
    /** New boundaries may normalize revoked-array errors without changing existing reader policy. */
    readonly translateArrayErrors?: boolean;
  },
): readonly T[] {
  const { refuse, overflow, freeze, descriptors } = options;
  let array: boolean;
  if (options.translateArrayErrors) {
    try {
      array = Array.isArray(value);
    } catch {
      throw refuse();
    }
  } else array = Array.isArray(value);
  if (!array) throw refuse();
  const length = ownData(value, 'length', refuse, descriptors);
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) throw refuse();
  if (options.expectedLength !== undefined && length !== options.expectedLength) throw refuse();
  if (length > maximum) throw refuse(overflow);
  const result: T[] = [];
  for (let index = 0; index < length; index++) result.push(read(ownData(value, String(index), refuse, descriptors)));
  return freeze ? Object.freeze(result) : result;
}

/** Charge retained fields against the same mutable allowance across admission helpers. */
export function spendFields(budget: { left: number }, count: number, refuse: RefuseEvidence): void {
  budget.left -= count;
  if (budget.left < 0) throw refuse('node-limit');
}
