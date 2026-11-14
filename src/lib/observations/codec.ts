import { canonicalSnapshot } from '../canonical-json/canonical.js';
import { CanonicalJsonError } from '../canonical-json/types.js';
import { boundedName } from '../evidence/admission.js';
import { parseAttemptId } from '../ids/attemptId.js';
import type { LogAddress } from '../memory/eventPosition.js';
import { arrayLength, fields, own } from './fields.js';
import { OBSERVATION_MAX_FACTS, OBSERVATION_OMISSIONS, OBSERVATION_VERSION } from './limits.js';
import { ObservationError } from './types.js';
import type { ObservationBounds } from './limits.js';
import type { ObservationInput, ObservationOmission, ObservationSubject } from './types.js';

const refuse = () => new ObservationError('invalid-data');
const label = (input: unknown, max = 128): string => boundedName(input, max, refuse);
const machine = (input: unknown): string => {
  const value = label(input);
  if (!/^[a-z][a-z0-9.-]*$/.test(value)) throw refuse();
  return value;
};
export const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export function addressOf(input: unknown): LogAddress {
  const value = fields(input, ['logRunId', 'drillPath']);
  const logRunId = label(value.logRunId, 1024),
    length = arrayLength(value.drillPath);
  if (length > 32) throw refuse();
  const drillPath: string[] = [];
  for (let i = 0; i < length; i++) drillPath.push(label(own(value.drillPath, String(i)), 1024));
  if (logRunId.length + drillPath.reduce((n, part) => n + part.length, 0) > 4096) throw refuse();
  return Object.freeze({ logRunId, drillPath: Object.freeze(drillPath) });
}
export const addressKey = (address: LogAddress): string => JSON.stringify([address.logRunId, ...address.drillPath]);
export function subjectOf(input: unknown): ObservationSubject {
  const snapshot = canonicalSnapshot(input, { maxBytes: 8192, maxStringBytes: 8192, maxNodes: 128, maxFields: 128 });
  const value = fields(
    snapshot.value,
    ['nativeAddress', 'runId', 'runtimeStageId', 'attemptId', 'operationRef'],
    ['nativeAddress', 'runId', 'runtimeStageId', 'operationRef'],
  );
  const nativeAddress = addressOf(value.nativeAddress),
    runId = label(value.runId, 1024);
  const runtimeStageId = label(value.runtimeStageId, 1024),
    operationRef = label(value.operationRef, 1024);
  if (!parseAttemptId(runtimeStageId + '@1')) throw refuse();
  const attemptId = value.attemptId === undefined ? undefined : label(value.attemptId, 1024);
  if (attemptId !== undefined && parseAttemptId(attemptId)?.runtimeStageId !== runtimeStageId) throw refuse();
  return Object.freeze({
    nativeAddress,
    runId,
    runtimeStageId,
    ...(attemptId === undefined ? {} : { attemptId }),
    operationRef,
  });
}
export const subjectKey = (subject: ObservationSubject): string => canonicalSnapshot(subject).text;

function inputOf(value: Record<string, unknown>): ObservationInput {
  const event = machine(value.event);
  let observedAt: ObservationInput['observedAt'];
  if (value.observedAt !== undefined) {
    const time = fields(value.observedAt, ['clock', 'elapsedMs']);
    if (
      typeof time.elapsedMs !== 'number' ||
      !Number.isFinite(time.elapsedMs) ||
      time.elapsedMs < 0 ||
      time.elapsedMs > Number.MAX_SAFE_INTEGER
    )
      throw refuse();
    observedAt = Object.freeze({ clock: machine(time.clock), elapsedMs: time.elapsedMs });
  }
  let facts: ObservationInput['facts'];
  if (value.facts !== undefined) {
    const raw = value.facts;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw refuse();
    const keys = Object.keys(raw);
    if (keys.length > OBSERVATION_MAX_FACTS) throw refuse();
    const held: Record<string, string | number | boolean | null> = Object.create(null);
    for (const key of keys) {
      if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(key)) throw refuse();
      const item = own(raw, key);
      if (typeof item === 'string') {
        if (item.length > 256) throw refuse();
      } else if (item !== null && typeof item !== 'number' && typeof item !== 'boolean') throw refuse();
      held[key] = item as string | number | boolean | null;
    }
    facts = Object.freeze(held);
  }
  return Object.freeze({
    event,
    ...(observedAt === undefined ? {} : { observedAt }),
    ...(facts === undefined ? {} : { facts }),
  });
}
function rowSnapshot(input: unknown, limits: ObservationBounds) {
  try {
    return canonicalSnapshot(input, {
      maxBytes: limits.maxRowBytes,
      maxStringBytes: limits.maxRowBytes,
      maxNodes: 64,
      maxFields: 48,
      maxDepth: 8,
    });
  } catch (error) {
    throw new ObservationError(
      error instanceof CanonicalJsonError && ['output-bytes', 'string-bytes'].includes(error.code)
        ? 'byte-limit'
        : 'invalid-data',
    );
  }
}
export function inputPayload(input: unknown, limits: ObservationBounds): ObservationInput {
  const snapshot = rowSnapshot(input, limits);
  return inputOf(fields(snapshot.value, ['event', 'observedAt', 'facts'], ['event']));
}
export function storedRow(
  input: unknown,
  limits: ObservationBounds,
): { sequence: number; payload: ObservationInput; bytes: number } {
  const snapshot = rowSnapshot(input, limits);
  const value = fields(snapshot.value, ['v', 'sequence', 'event', 'observedAt', 'facts'], ['v', 'sequence', 'event']);
  if (value.v !== OBSERVATION_VERSION || !count(value.sequence) || value.sequence < 1) throw refuse();
  return { sequence: value.sequence, payload: inputOf(value), bytes: snapshot.bytes };
}
export function omissionsOf(input: unknown): Readonly<Record<ObservationOmission, number>> {
  const value = fields(input, OBSERVATION_OMISSIONS);
  for (const key of OBSERVATION_OMISSIONS) if (!count(value[key])) throw refuse();
  return Object.freeze(value) as Readonly<Record<ObservationOmission, number>>;
}
