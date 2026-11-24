import { viewStampFits } from '../memory/builtOn.js';
import { admitStamps, placedAt } from '../memory/readWindow.js';
import { readAttemptWindow } from '../evidence/readAttempts.js';
import { parseAttemptId } from '../ids/attemptId.js';
import { readerLimits } from '../evidence/readerLimits.js';
/** Admission before the existing readers touch untrusted record fields. Payloads never leave this module's graph. */
import type { CommitBundle } from '../memory/types.js';
import { attention as marksOf, admissionCode, observePromise } from './validation.js';
import {
  names,
  recordList,
  recordName,
  recordOwn,
  RecordRefusal,
  refuseRecord,
  spend,
} from '../evidence/recordData.js';

export { marksOf };
export {
  addressKey,
  addressOf,
  names,
  recordList,
  recordName,
  recordOwn,
  RecordRefusal,
  recordRefusalCode,
  spend,
} from '../evidence/recordData.js';

export interface RecordBudget {
  left: number;
  readonly workExhaustion?: 'truncated';
}

/** Iterative bounded copy: data descriptors only, no getters/toJSON/prototypes or opaque class instances. */
export function dataCopy(value: unknown, budget: RecordBudget, separatelyReadKey?: string): unknown {
  const leaf = (v: unknown): boolean => v === null || typeof v !== 'object';
  const check = (v: unknown): void => {
    spend(budget, 1);
    if (typeof v === 'function' || typeof v === 'symbol') throw new RecordRefusal();
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
      // The optional evidence's descriptor is read by its own admission, even when it throws.
      keys =
        from === value && separatelyReadKey !== undefined
          ? Reflect.ownKeys(from).filter(
              (key): key is string =>
                typeof key === 'string' &&
                key !== separatelyReadKey &&
                Object.prototype.propertyIsEnumerable.call(from, key),
            )
          : Object.keys(from);
    } catch {
      throw new RecordRefusal();
    }
    // Optional record channels can refuse a copy and still share the remaining allowance.
    if (keys.length > budget.left) throw new RecordRefusal(budget.workExhaustion ?? 'node-limit');
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
/** Copy previously admitted plain operands without cloning immutable scalars. */
export function copyRecordValue<T>(value: T): T {
  return dataCopy(value, { left: Number.MAX_SAFE_INTEGER }) as T;
}
/** `after`: the index of the copy before this one in the log (-1 for the first); the copy's own rises past it. */
export function bundleOf(value: unknown, after: number, budget: RecordBudget): CommitBundle {
  const runtimeStageId = recordName(recordOwn(value, 'runtimeStageId')),
    stageId = recordName(recordOwn(value, 'stageId'));
  const trace = recordList(recordOwn(value, 'trace'), readerLimits.traceRows.maximum).map((_, i) => {
    const t = recordOwn(recordOwn(value, 'trace'), String(i)),
      path = recordName(recordOwn(t, 'path'), true),
      verb = recordOwn(t, 'verb');
    if (!['set', 'merge', 'append', 'delete'].includes(verb as string)) throw new RecordRefusal();
    const readKeys = recordOwn(t, 'readKeys'),
      rawAttempts = recordOwn(t, 'readAttempts');
    const window = readAttemptWindow(t, rawAttempts, recordOwn, refuseRecord);
    const readAttemptsOmitted = window.omitted;
    const readAttempts = rawAttempts === undefined ? undefined : names(rawAttempts, 128, true, window.expectedLength);
    if (readAttempts?.some((id) => !parseAttemptId(id))) throw new RecordRefusal();
    // The writer's mark on a `set` row it built on the step's view. Kept, never dropped: without it the
    // row reads as a replacement and the walk leaves out every step whose write is still in the value.
    // A value that cannot be the mark, or the mark on another verb, refuses the bundle.
    const builtOnView = recordOwn(t, 'builtOnView');
    if (builtOnView !== undefined && (builtOnView !== true || verb !== 'set')) throw new RecordRefusal();
    return {
      path,
      verb: verb as 'set',
      ...(readKeys === undefined ? {} : { readKeys: names(readKeys, 128, true) }),
      ...(readAttempts?.length ? { readAttempts } : {}),
      ...(readAttemptsOmitted === undefined ? {} : { readAttemptsOmitted }),
      ...(builtOnView === true ? { builtOnView: true as const } : {}),
    };
  });
  spend(
    budget,
    trace.length + trace.reduce((n, t) => n + (t.readKeys?.length ?? 0) + (t.readAttempts?.length ?? 0), 0) + 1,
  );
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
  // The walk dates this step's reads by its stamps, read against each bundle's own `idx`. So the copy keeps
  // both, and stamps that cannot be stamps refuse the record (`memory/readWindow.ts · admitStamps`). The
  // same for `viewAt`, which dates the rows the writer built on the step's view: it must fit the index,
  // and the bundle must hold such a row.
  const placed = admitStamps(
    recordOwn(value, 'beganAt'),
    recordOwn(value, 'sawUntil'),
    recordOwn(value, 'idx'),
    after,
    recordOwn(value, 'viewAt'),
  );
  if (!placed || !viewStampFits(placed, trace)) throw new RecordRefusal();
  spend(budget, redactedPaths.length + (untracked === undefined ? 0 : recordList(untracked, 128).length));
  return {
    ...placed,
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

/**
 * Admit a whole log in recorded order under the caller's shared field allowance.
 * The scope's internal hook may admit optional evidence using its own allowance.
 */
export function prepareRecordLog(
  value: unknown,
  maximum: number,
  budget: { left: number },
  onBundle?: (raw: unknown, bundle: CommitBundle) => void,
): CommitBundle[] {
  const rows = recordList(value, maximum);
  let after = -1;
  return rows.map((_, index) => {
    const raw = recordOwn(rows, String(index));
    const bundle = bundleOf(raw, after, budget);
    after = placedAt(bundle, after);
    onBundle?.(raw, bundle);
    return bundle;
  });
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
      const code = admissionCode(error);
      reject(code === undefined ? error : new RecordRefusal(code));
    }
  });
}
