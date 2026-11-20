import { addressOf, recordOwn } from '../recordData.js';
import {
  BOUNDARIES,
  FAILURE_CATEGORIES,
  type CaptureFailure,
  type CaptureInterval,
  type CaptureWitness,
} from './types.js';

export function member<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

export function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): boolean {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => typeof key === 'string' && (required.includes(key) || optional.includes(key)))
  );
}

export function identifier(value: unknown, maximum = 2048): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  );
}

export function interval(value: unknown): CaptureInterval | undefined {
  if (!exact(value, ['from', 'to'])) return undefined;
  const from = recordOwn(value, 'from');
  const to = recordOwn(value, 'to');
  if (
    typeof from !== 'number' ||
    typeof to !== 'number' ||
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    from > to
  )
    return undefined;
  return { from, to };
}

export function witness(value: unknown): CaptureWitness | undefined {
  if (!exact(value, ['logAddress', 'runId', 'commits', 'boundary', 'source'])) return undefined;
  const logAddress = recordOwn(value, 'logAddress');
  const runId = recordOwn(value, 'runId');
  const commits = interval(recordOwn(value, 'commits'));
  const boundary = recordOwn(value, 'boundary');
  const source = recordOwn(value, 'source');
  if (
    !exact(logAddress, ['logRunId', 'drillPath']) ||
    !identifier(runId) ||
    !commits ||
    !member(boundary, BOUNDARIES) ||
    (source !== 'live' && source !== 'saved')
  )
    return undefined;
  return { logAddress: addressOf(logAddress), runId, commits, boundary, source };
}

export function safelyCopyFailure(value: unknown, runId: string, retainCategory: boolean): CaptureFailure | undefined {
  if (!exact(value, ['category'], ['stage'])) return undefined;
  const category = recordOwn(value, 'category');
  if (!member(category, FAILURE_CATEGORIES)) return undefined;
  try {
    const stage = recordOwn(value, 'stage');
    if (stage === undefined) return { category };
    if (exact(stage, ['runId', 'runtimeStageId']) && recordOwn(stage, 'runId') === runId) {
      const runtimeStageId = recordOwn(stage, 'runtimeStageId');
      if (identifier(runtimeStageId, 1024)) return { category, stage: { runId, runtimeStageId } };
    }
  } catch {
    // An unreadable optional identity has the same force as a withheld identity.
  }
  return retainCategory ? { category } : undefined;
}
