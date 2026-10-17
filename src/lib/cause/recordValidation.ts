/** Admission before the existing readers touch untrusted record fields. Payloads never leave this module's graph. */
import type { LogAddress } from '../memory/eventPosition.js';
import type { CommitBundle } from '../memory/types.js';
import type { GapCode } from './types.js';
import { attention as marksOf, AdmissionError, observePromise } from './validation.js';
import { boundedList, boundedName, EvidenceRefusal, ownData, spendFields } from './admission.js';

export { marksOf };

/** Loader refusals stay distinct from graph-port refusals so a failed host load keeps its original classification. */
export class RecordRefusal extends EvidenceRefusal {
  constructor(readonly code: GapCode = 'invalid-data') {
    super(code, 'cause: record unavailable');
  }
}
const refuseRecord = (code?: GapCode): RecordRefusal => new RecordRefusal(code);
const recordDescriptors = { translateTrapErrors: true, requireOwnValue: true };
export function recordOwn(value: unknown, key: string): unknown {
  return ownData(value, key, refuseRecord, recordDescriptors);
}
export function names(value: unknown, maximum = 128, path = false): string[] {
  return recordList(value, maximum).map((item) => recordName(item, path));
}
export function recordName(value: unknown, path = false): string {
  return boundedName(value, 1024, refuseRecord, path);
}
export function recordList(value: unknown, maximum: number): readonly unknown[] {
  return boundedList(value, maximum, (item) => item, {
    refuse: refuseRecord,
    overflow: 'node-limit',
    freeze: false,
    descriptors: recordDescriptors,
  });
}
export function addressOf(value: unknown): LogAddress {
  const logRunId = recordName(recordOwn(value, 'logRunId')),
    drillPath = names(recordOwn(value, 'drillPath'), 16);
  if (logRunId.length + drillPath.reduce((n, s) => n + s.length, 0) > 1536) throw new RecordRefusal();
  return Object.freeze({ logRunId, drillPath: Object.freeze(drillPath) });
}
export function spend(budget: { left: number }, count: number): void {
  spendFields(budget, count, refuseRecord);
}
export const addressKey = (a: LogAddress): string => JSON.stringify([a.logRunId, ...a.drillPath]);
/** Iterative bounded copy: data descriptors only, no getters/toJSON/prototypes or opaque class instances. */
export function dataCopy(value: unknown, budget: { left: number }): unknown {
  const leaf = (v: unknown): boolean => v === null || typeof v !== 'object';
  const check = (v: unknown): void => {
    spend(budget, 1);
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
      const length = recordOwn(v, 'length');
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
      const v = recordOwn(from, key);
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
  const runtimeStageId = recordName(recordOwn(value, 'runtimeStageId')),
    stageId = recordName(recordOwn(value, 'stageId'));
  const trace = recordList(recordOwn(value, 'trace'), 128).map((_, i) => {
    const t = recordOwn(recordOwn(value, 'trace'), String(i)),
      path = recordName(recordOwn(t, 'path'), true),
      verb = recordOwn(t, 'verb');
    if (!['set', 'merge', 'append', 'delete'].includes(verb as string)) throw new RecordRefusal();
    const readKeys = recordOwn(t, 'readKeys');
    return { path, verb: verb as 'set', ...(readKeys === undefined ? {} : { readKeys: names(readKeys, 128, true) }) };
  });
  spend(budget, trace.length + trace.reduce((n, t) => n + (t.readKeys?.length ?? 0), 0) + 1);
  const overwrite = dataCopy(recordOwn(value, 'overwrite'), budget),
    updates = dataCopy(recordOwn(value, 'updates'), budget);
  if (
    !overwrite ||
    typeof overwrite !== 'object' ||
    Array.isArray(overwrite) ||
    !updates ||
    typeof updates !== 'object' ||
    Array.isArray(updates)
  )
    throw new RecordRefusal();
  const redactedPaths = names(recordOwn(value, 'redactedPaths') ?? [], 128, true);
  const untracked = recordOwn(value, 'untrackedSources'),
    phase = recordOwn(value, 'phase');
  spend(budget, redactedPaths.length + (untracked === undefined ? 0 : recordList(untracked, 128).length));
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
  return new Map(keys.map((k) => [recordName(k), read(recordOwn(value, k))]));
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
