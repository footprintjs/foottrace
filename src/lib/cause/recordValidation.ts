/** Admission before the existing readers touch untrusted record fields. Payloads never leave this module's graph. */
import type { LogAddress } from '../memory/eventPosition.js';
import type { CommitBundle } from '../memory/types.js';
import type { GapCode } from './types.js';
import { attention as marksOf, AdmissionError, observePromise } from './validation.js';
export { marksOf };
export class RecordRefusal extends Error {
  constructor(readonly code: GapCode = 'invalid-data') {
    super('cause: record unavailable');
  }
}
export function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') throw new RecordRefusal();
  let d: PropertyDescriptor | undefined;
  try {
    d = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new RecordRefusal();
  }
  if (!d) return undefined;
  if (!Object.hasOwn(d, 'value')) throw new RecordRefusal();
  return d.value;
}
export function names(value: unknown, max = 128, path = false): string[] {
  const rows = list(value, max);
  return rows.map((v) => name(v, path));
}
export function name(value: unknown, path = false): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > 1024 ||
    (path ? /[\u0000-\u001e\u007f-\u009f]/ : /[\u0000-\u001f\u007f-\u009f]/).test(value)
  )
    throw new RecordRefusal();
  return value;
}
export function list(value: unknown, max: number): readonly unknown[] {
  if (!Array.isArray(value)) throw new RecordRefusal();
  const length = own(value, 'length');
  if (!Number.isSafeInteger(length) || (length as number) < 0) throw new RecordRefusal();
  if ((length as number) > max) throw new RecordRefusal('node-limit');
  const rows: unknown[] = [];
  for (let i = 0; i < (length as number); i++) rows.push(own(value, String(i)));
  return rows;
}
export function addressOf(value: unknown): LogAddress {
  const logRunId = name(own(value, 'logRunId')),
    drillPath = names(own(value, 'drillPath'), 16);
  if (logRunId.length + drillPath.reduce((n, s) => n + s.length, 0) > 1536) throw new RecordRefusal();
  return Object.freeze({ logRunId, drillPath: Object.freeze(drillPath) });
}
export function spend(budget: { left: number }, count: number): void {
  budget.left -= count;
  if (budget.left < 0) throw new RecordRefusal('node-limit');
}
export const addressKey = (a: LogAddress): string => JSON.stringify([a.logRunId, ...a.drillPath]);
/** Iterative bounded copy: data descriptors only, no getters/toJSON/prototypes or opaque class instances. */
export function dataCopy(value: unknown, budget: { left: number }): unknown {
  const leaf = (v: unknown): boolean => v === null || typeof v !== 'object';
  const check = (v: unknown): void => {
    if (--budget.left < 0) throw new RecordRefusal('node-limit');
    if (typeof v === 'function' || typeof v === 'symbol' || (typeof v === 'string' && v.length > 65536))
      throw new RecordRefusal();
  };
  check(value);
  if (leaf(value)) return value;
  const make = (v: object): unknown[] | Record<string, unknown> => {
    let p;
    try {
      p = Object.getPrototypeOf(v);
    } catch {
      throw new RecordRefusal();
    }
    if (!Array.isArray(v) && p !== Object.prototype && p !== null) throw new RecordRefusal();
    if (Array.isArray(v)) {
      const length = own(v, 'length');
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) throw new RecordRefusal();
      spend(budget, length);
      const array: unknown[] = [];
      array.length = length;
      return array;
    }
    return Object.create(null) as Record<string, unknown>;
  };
  const root = make(value as object),
    seen = new Set<object>([value as object]),
    work = [{ from: value as object, to: root }];
  while (work.length) {
    const { from, to } = work.pop()!;
    let keys: string[];
    try {
      keys = Object.keys(from);
    } catch {
      throw new RecordRefusal();
    }
    if (keys.length > budget.left) throw new RecordRefusal('node-limit');
    for (const key of keys) {
      if (key.length > 1024) throw new RecordRefusal('node-limit');
      const v = own(from, key);
      check(v);
      let copy = v;
      if (!leaf(v)) {
        if (seen.has(v as object)) throw new RecordRefusal();
        seen.add(v as object);
        copy = make(v as object);
        work.push({ from: v as object, to: copy as typeof root });
      }
      Object.defineProperty(to, key, { value: copy, enumerable: true, writable: true, configurable: true });
    }
  }
  return root;
}
export function bundleOf(value: unknown, idx: number, budget: { left: number }): CommitBundle {
  const runtimeStageId = name(own(value, 'runtimeStageId')),
    stageId = name(own(value, 'stageId'));
  const trace = list(own(value, 'trace'), 128).map((_, i) => {
    const t = own(own(value, 'trace'), String(i)),
      path = name(own(t, 'path'), true),
      verb = own(t, 'verb');
    if (!['set', 'merge', 'append', 'delete'].includes(verb as string)) throw new RecordRefusal();
    const readKeys = own(t, 'readKeys');
    return { path, verb: verb as 'set', ...(readKeys === undefined ? {} : { readKeys: names(readKeys, 128, true) }) };
  });
  spend(budget, trace.length + trace.reduce((n, t) => n + (t.readKeys?.length ?? 0), 0) + 1);
  const overwrite = dataCopy(own(value, 'overwrite'), budget),
    updates = dataCopy(own(value, 'updates'), budget);
  if (
    !overwrite ||
    typeof overwrite !== 'object' ||
    Array.isArray(overwrite) ||
    !updates ||
    typeof updates !== 'object' ||
    Array.isArray(updates)
  )
    throw new RecordRefusal();
  const redactedPaths = names(own(value, 'redactedPaths') ?? [], 128, true);
  const untracked = own(value, 'untrackedSources'),
    phase = own(value, 'phase');
  spend(budget, redactedPaths.length + (untracked === undefined ? 0 : list(untracked, 128).length));
  return {
    idx,
    stage: stageId,
    stageId,
    runtimeStageId,
    trace,
    overwrite,
    updates,
    redactedPaths,
    ...(untracked === undefined
      ? {}
      : {
          untrackedSources: names(untracked).map((s) => {
            if (!['args', 'env', 'silent'].includes(s)) throw new RecordRefusal();
            return s as 'args';
          }),
        }),
    ...(phase === undefined
      ? {}
      : {
          phase: (() => {
            if (phase !== 'exit' && phase !== 'repeat') throw new RecordRefusal();
            return phase;
          })(),
        }),
  };
}
export function mapOf<T>(
  value: unknown,
  limit: number,
  read: (v: unknown) => T,
  budget?: { left: number },
): Map<string, T> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RecordRefusal();
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    throw new RecordRefusal();
  }
  if (keys.length > limit) throw new RecordRefusal('node-limit');
  if (budget) spend(budget, keys.length);
  return new Map(keys.map((k) => [name(k), read(own(value, k))]));
}

/** Observe native promises by intrinsic without assimilating a data object's then accessor. */
export function projectLoaded<T, R>(work: () => T | Promise<T>, project: (value: T) => R): Promise<R> {
  return new Promise((resolve, reject) => {
    const accept = (value: T) => {
      try {
        resolve(project(value));
      } catch (error) {
        reject(error);
      }
    };
    let returned: T | Promise<T>;
    try {
      returned = work();
    } catch (error) {
      reject(error);
      return;
    }
    try {
      if (!observePromise(returned, (value) => accept(value as T), reject)) accept(returned as T);
    } catch (error) {
      reject(error instanceof AdmissionError ? new RecordRefusal(error.code) : error);
    }
  });
}
