/**
 * fields.ts — the primitives every row check is built from. Own data descriptors only, on plain current-realm objects and
 * ordinary arrays: an accessor, a custom prototype or a sparse array is refused, and no getter ever runs. Past a cap a
 * refusal is `truncated`; anything else is `invalid-data`. A refusal carries no text from the file.
 */

import { boundedList, boundedName, EvidenceRefusal, ownData, spendFields } from '../evidence/admission.js';
import type { GapCode } from '../evidence/codes.js';
import { executionIndexOf } from '../ids/runtimeStageId.js';
import { isCount, type RUN_EVIDENCE_LIMITS } from './kinds.js';

/** One refused row: never a partial one. */
export class RowRefusal extends EvidenceRefusal {
  constructor(code: GapCode = 'invalid-data') {
    super(code, 'RUN_EVIDENCE_ROW_REFUSED');
  }
}

/** What a row is checked against: the caps of this read, and the one field budget they all spend. */
export interface Admission {
  readonly limits: typeof RUN_EVIDENCE_LIMITS;
  readonly budget: { left: number };
}

export const refuse = (code?: GapCode): RowRefusal => new RowRefusal(code);
export const tooMany = (): RowRefusal => new RowRefusal('truncated');
export const DATA_ONLY = { translateTrapErrors: true, requireOwnValue: true };

/** The own data field `key`, or `undefined` when there is none. An accessor is refused, unread. */
export function ownField(value: unknown, key: string): unknown {
  return ownData(value, key, refuse, DATA_ONLY);
}

/** Charge the read's one budget. */
export function spend(a: Admission, count: number): void {
  spendFields(a.budget, count, tooMany);
}

export function plain(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw refuse();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw refuse();
}

export function list<T>(value: unknown, maximum: number, read: (item: unknown) => T, a: Admission): readonly T[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw refuse();
  const length = ownField(value, 'length');
  if (typeof length !== 'number') throw refuse();
  if (length > maximum) throw tooMany();
  spend(a, length + 1);
  return boundedList(value, maximum, read, {
    refuse,
    overflow: 'truncated',
    freeze: true,
    descriptors: DATA_ONLY,
    expectedLength: length,
    translateArrayErrors: true,
  });
}

export function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string') throw refuse();
  if (value.length > maximum) throw tooMany();
  return value;
}

export function count(value: unknown): number {
  if (!isCount(value)) throw refuse();
  return value;
}

export function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw refuse();
  return value;
}

export function exactlyTrue(value: unknown): true {
  if (value !== true) throw refuse();
  return true;
}

/** `{ [name]: value }`, or nothing for an absent field: a row never holds an `undefined` key. */
export function field<K extends string, T>(name: K, raw: unknown, read: (value: unknown) => T): { [P in K]?: T } {
  return (raw === undefined ? {} : { [name]: read(raw) }) as { [P in K]?: T };
}

const ID_GRAMMAR = /^[^#]+#(0|[1-9]\d*)$/;

/** A runtimeStageId that passes the grammar: one `#`, a safe execution index, no control characters. */
export function executionId(value: unknown, a: Admission): string {
  const id = boundedName(value, a.limits.text, refuse);
  if (!ID_GRAMMAR.test(id) || !Number.isSafeInteger(executionIndexOf(id))) throw refuse();
  return id;
}

/** Is `value` a runtimeStageId? For text that is only named, such as a mount's segment of an address. */
export function isExecutionId(value: string, a: Admission): boolean {
  try {
    executionId(value, a);
    return true;
  } catch {
    return false;
  }
}

/** An id that points back: a parent or a paused execution must have run first, so a chain can never cycle. */
export function earlier(value: unknown, childIndex: number, a: Admission): string {
  const id = executionId(value, a);
  if (executionIndexOf(id) >= childIndex) throw refuse();
  return id;
}

/**
 * A stored value of unknown shape, copied and frozen, inside a depth and a size. An explicit stack: never a recursion. A
 * cycle is stopped by the depth, and a value shared many times is charged each time, so neither costs more than its caps.
 */
export function boundedValue(value: unknown, maxSize: number, a: Admission): unknown {
  let size = 0;
  const charge = (amount: number): void => {
    size += amount;
    if (size > maxSize) throw tooMany();
    spend(a, 1);
  };
  const made: object[] = [];
  const work: { from: object; to: object; depth: number }[] = [];
  const copyOf = (item: unknown, depth: number): unknown => {
    if (typeof item === 'string') {
      charge(item.length);
      return item;
    }
    if (item === null || item === undefined || typeof item === 'number' || typeof item === 'boolean') {
      charge(8);
      return item;
    }
    if (typeof item !== 'object') throw refuse();
    if (depth >= a.limits.payloadDepth) throw tooMany();
    const isList = Array.isArray(item);
    const prototype: unknown = Object.getPrototypeOf(item);
    if (isList ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw refuse();
    charge(2);
    const to: object = isList ? [] : {};
    made.push(to);
    work.push({ from: item, to, depth });
    return to;
  };
  const put = (from: object, to: object, key: string, depth: number): void => {
    const copy = copyOf(ownField(from, key), depth + 1);
    Object.defineProperty(to, key, { value: copy, enumerable: true, writable: true, configurable: true });
  };
  const root = copyOf(value, 0);
  while (work.length > 0) {
    const { from, to, depth } = work.pop()!;
    if (Array.isArray(from)) {
      const length = ownField(from, 'length') as number;
      for (let i = 0; i < length; i++) {
        if (!Object.hasOwn(from, String(i))) throw refuse();
        put(from, to, String(i), depth);
      }
    } else {
      for (const key of Object.keys(from)) {
        charge(key.length);
        put(from, to, key, depth);
      }
    }
  }
  for (const container of made) Object.freeze(container);
  return root;
}
