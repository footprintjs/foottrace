import type { Adjacency, Attention, Gap, GapCode, GraphEdge, NodeId } from './types.js';

export class AdmissionError extends Error {
  constructor(readonly code: GapCode = 'invalid-data') {
    super('Invalid cause evidence');
  }
}
/**
 * Only ordinary native promise wrappers belong to the async host contract.
 * An own constructor could run an accessor/species during intrinsic then().
 * Exotic wrappers remain the trusted host's responsibility, including rejection handling.
 */
export function observePromise(
  raw: unknown,
  accept: (raw: unknown) => void,
  reject: (reason: unknown) => void,
): boolean {
  if (!raw || typeof raw !== 'object' || Object.getPrototypeOf(raw) !== Promise.prototype) return false;
  if (Object.getOwnPropertyDescriptor(raw, 'constructor')) throw new AdmissionError();
  try {
    Promise.prototype.then.call(raw, accept, reject);
  } catch {
    throw new AdmissionError();
  }
  return true;
}
export function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') throw new AdmissionError();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!('value' in descriptor)) throw new AdmissionError();
  return descriptor.value;
}
export function plain(value: unknown): void {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new AdmissionError();
}
export function name(value: unknown, max = 2048): string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f\u007f-\u009f]/.test(value))
    throw new AdmissionError();
  return value;
}
export function list<T>(
  value: unknown,
  max: number,
  read: (item: unknown) => T,
  overflow: GapCode = 'invalid-data',
): readonly T[] {
  if (!Array.isArray(value)) throw new AdmissionError();
  const length = own(value, 'length');
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) throw new AdmissionError();
  if (length > max) throw new AdmissionError(overflow);
  const result: T[] = [];
  for (let i = 0; i < length; i++) result.push(read(own(value, String(i))));
  return Object.freeze(result);
}
const reasons = new Set([
  'ERROR_RECORDED',
  'UNKNOWN_EFFECT_RECORDED',
  'RETRY_STOP_RECORDED',
  'TIMEOUT_RECORDED',
  'RETRY_RECORDED',
  'QUALITY_DROP_RECORDED',
  'EVIDENCE_NOT_COLLECTED',
  'OUTLIER_RECORDED',
  'BUSINESS_RULE_MATCHED',
]);
const codes = new Set([
  'not-collected',
  'untracked-input',
  'redacted',
  'conservative',
  'scope-boundary',
  'invalid-data',
  'unavailable',
  'timeout',
  'cancelled',
  'cycle',
  'node-limit',
  'depth-limit',
  'edge-limit',
  'call-limit',
  'truncated',
  'strategy-failed',
]);
export const refs = (value: unknown): readonly string[] => list(value, 16, (item) => name(item, 512));
export function attention(value: unknown): readonly Attention[] {
  return list(value, 32, (item) => {
    plain(item);
    const kind = own(item, 'kind'),
      reason = own(item, 'reason');
    if (
      typeof kind !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(kind) ||
      typeof reason !== 'string' ||
      !reasons.has(reason)
    )
      throw new AdmissionError();
    const evidence = refs(own(item, 'evidence'));
    if (kind !== 'not-collected' && evidence.length === 0) throw new AdmissionError();
    return Object.freeze({ kind, reason: reason as Attention['reason'], evidence });
  });
}
export function gaps(value: unknown): readonly Gap[] {
  return list(value, 32, (item) => {
    plain(item);
    const code = own(item, 'code'),
      nodeId = own(item, 'nodeId');
    if (typeof code !== 'string' || !codes.has(code)) throw new AdmissionError();
    return Object.freeze({
      code: code as GapCode,
      ...(nodeId === undefined ? {} : { nodeId: name(nodeId) }),
      evidence: refs(own(item, 'evidence')),
    });
  });
}
export function adjacency(value: unknown, maximum: number): Adjacency {
  plain(value);
  const complete = own(value, 'complete');
  if (typeof complete !== 'boolean') throw new AdmissionError();
  const edges = list(
    own(value, 'edges'),
    maximum,
    (item) => {
      plain(item);
      const nodeId = name(own(item, 'nodeId')),
        kind = own(item, 'kind'),
        attribution = own(item, 'attribution');
      if (
        (kind !== 'data' && kind !== 'control') ||
        (attribution !== 'per-write' && attribution !== 'stage' && attribution !== 'recorded-control') ||
        (kind === 'control' && attribution !== 'recorded-control') ||
        (kind === 'data' && attribution === 'recorded-control')
      )
        throw new AdmissionError();
      return Object.freeze({ nodeId, kind, attribution, evidence: refs(own(item, 'evidence')) }) as GraphEdge;
    },
    'edge-limit',
  );
  return Object.freeze({ edges, complete });
}
export const nodeIds = (value: unknown, max: number): readonly NodeId[] =>
  list(value, max, (item) => name(item), 'node-limit');
export const gap = (code: GapCode, nodeId?: NodeId): Gap =>
  Object.freeze({ code, ...(nodeId === undefined ? {} : { nodeId }), evidence: Object.freeze([]) });
export function uniqueGaps(items: readonly Gap[]): readonly Gap[] {
  const seen = new Set<string>();
  return Object.freeze(
    items.filter((item) => {
      const key = JSON.stringify(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
}
