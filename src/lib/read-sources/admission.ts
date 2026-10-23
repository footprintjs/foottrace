import { boundedList, boundedName, ownData } from '../evidence/admission.js';
import { parseAttemptId } from '../ids/attemptId.js';
import { nativeExecution } from '../prov/ids.js';
import type { LogAddress } from '../memory/eventPosition.js';
import { utf8Bytes } from '../prov/encoding.js';
import type { ReadSourceLimits, ReadSourceOwner } from './types.js';

const refuse = () => new TypeError('read sources: invalid data');
const descriptors = { translateTrapErrors: true, requireOwnValue: true };
export const sourceOwn = (value: unknown, key: string): unknown => ownData(value, key, refuse, descriptors);
export const sourceList = <T>(value: unknown, maximum: number, read: (value: unknown) => T): readonly T[] =>
  boundedList(value, maximum, read, {
    refuse,
    overflow: 'node-limit',
    freeze: true,
    descriptors,
    translateArrayErrors: true,
  });
export function sourceName(value: unknown): string {
  const name = boundedName(value, 1024, refuse);
  if (utf8Bytes(JSON.stringify(name)) > 1026) throw refuse();
  return name;
}
/** A user key is data, not an ID: empty, dotted, slashed and Unicode keys stay literal. */
export function sourceKey(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024 || utf8Bytes(JSON.stringify(value)) > 1026) throw refuse();
  return value;
}
export function sourceAddress(value: unknown, name: (value: unknown) => string = sourceName): LogAddress {
  return Object.freeze({
    logRunId: name(sourceOwn(value, 'logRunId')),
    drillPath: sourceList(sourceOwn(value, 'drillPath'), 16, name),
  });
}
export function sourceOwner(value: unknown): ReadSourceOwner {
  const runtimeStageId = sourceName(sourceOwn(value, 'runtimeStageId'));
  if (!nativeExecution(runtimeStageId)) throw refuse();
  const attempt = sourceOwn(value, 'attemptId');
  if (attempt === undefined) return { runtimeStageId };
  const attemptId = sourceName(attempt);
  if (parseAttemptId(attemptId)?.runtimeStageId !== runtimeStageId) throw refuse();
  return { runtimeStageId, attemptId };
}

/** Measured ceilings: see docs/read-sources.md and bench/read-sources.mjs. Hosts may only reduce them. */
export const READ_SOURCE_DEFAULTS: ReadSourceLimits = Object.freeze({
  maxOccurrences: 4096,
  maxPerExecution: 1024,
  maxBytes: 1024 * 1024,
  maxOrigins: 4096,
  maxStaging: 2048,
});
export function sourceLimits(value?: unknown): ReadSourceLimits {
  const result = { ...READ_SOURCE_DEFAULTS };
  for (const key of Object.keys(result) as (keyof ReadSourceLimits)[]) {
    const limit = value === undefined ? undefined : sourceOwn(value, key);
    if (limit === undefined) continue;
    if (
      typeof limit !== 'number' ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > result[key] ||
      (key === 'maxBytes' && limit < 2048)
    )
      throw new TypeError('read sources: invalid limits');
    result[key] = limit;
  }
  return Object.freeze(result);
}
export const sourceBytes = (value: unknown): number => utf8Bytes(JSON.stringify(value));
export function sourceInteger(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw refuse();
  return value;
}

/** Declared native namespaces are inspected before clone, never inferred by traversing business objects. */
export function sourceNamespaces(value: unknown, limits: ReadSourceLimits): readonly (readonly string[])[] {
  if (value === undefined) return [];
  let bytes = 0,
    components = 0;
  return sourceList(value, limits.maxOrigins, (path) =>
    sourceList(path, 64, (part) => {
      const key = sourceKey(part);
      bytes += sourceBytes(key) + 1;
      if (++components > limits.maxOrigins || bytes > limits.maxBytes)
        throw new TypeError('read sources: invalid namespaces');
      return key;
    }),
  );
}
