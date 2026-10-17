import type { Adjacency, Attention, Gap, GapCode, GraphEdge, NodeId } from './types.js';

import { boundedList, boundedName, EvidenceRefusal, ownData } from './admission.js';

/** Graph-port refusals carry their code through Session; loader refusals are handled at the record boundary. */
export class AdmissionError extends EvidenceRefusal {
  constructor(readonly code: GapCode = 'invalid-data') {
    super(code, 'Invalid cause evidence');
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
const refuseGraph = (code?: GapCode): AdmissionError => new AdmissionError(code);
const graphDescriptors = { translateTrapErrors: false, requireOwnValue: false };
export function graphOwn(value: unknown, key: string): unknown {
  return ownData(value, key, refuseGraph, graphDescriptors);
}
export function plain(value: unknown): void {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new AdmissionError();
}
export function graphName(value: unknown, maximum = 2048): string {
  return boundedName(value, maximum, refuseGraph);
}
export function graphList<T>(
  value: unknown,
  maximum: number,
  read: (item: unknown) => T,
  overflow: GapCode = 'invalid-data',
): readonly T[] {
  return boundedList(value, maximum, read, {
    refuse: refuseGraph,
    overflow,
    freeze: true,
    descriptors: graphDescriptors,
  });
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
export const refs = (value: unknown): readonly string[] => graphList(value, 16, (item) => graphName(item, 512));
export function attention(value: unknown): readonly Attention[] {
  return graphList(value, 32, (item) => {
    plain(item);
    const kind = graphOwn(item, 'kind'),
      reason = graphOwn(item, 'reason');
    if (
      typeof kind !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(kind) ||
      typeof reason !== 'string' ||
      !reasons.has(reason)
    )
      throw new AdmissionError();
    const evidence = refs(graphOwn(item, 'evidence'));
    if (kind !== 'not-collected' && evidence.length === 0) throw new AdmissionError();
    return Object.freeze({ kind, reason: reason as Attention['reason'], evidence });
  });
}
export function gaps(value: unknown): readonly Gap[] {
  return graphList(value, 32, (item) => {
    plain(item);
    const code = graphOwn(item, 'code'),
      nodeId = graphOwn(item, 'nodeId');
    if (typeof code !== 'string' || !codes.has(code)) throw new AdmissionError();
    return Object.freeze({
      code: code as GapCode,
      ...(nodeId === undefined ? {} : { nodeId: graphName(nodeId) }),
      evidence: refs(graphOwn(item, 'evidence')),
    });
  });
}
export function adjacency(value: unknown, maximum: number): Adjacency {
  plain(value);
  const complete = graphOwn(value, 'complete');
  if (typeof complete !== 'boolean') throw new AdmissionError();
  const edges = graphList(
    graphOwn(value, 'edges'),
    maximum,
    (item) => {
      plain(item);
      const nodeId = graphName(graphOwn(item, 'nodeId')),
        kind = graphOwn(item, 'kind'),
        attribution = graphOwn(item, 'attribution');
      if (
        (kind !== 'data' && kind !== 'control') ||
        (attribution !== 'per-write' && attribution !== 'stage' && attribution !== 'recorded-control') ||
        (kind === 'control' && attribution !== 'recorded-control') ||
        (kind === 'data' && attribution === 'recorded-control')
      )
        throw new AdmissionError();
      return Object.freeze({ nodeId, kind, attribution, evidence: refs(graphOwn(item, 'evidence')) }) as GraphEdge;
    },
    'edge-limit',
  );
  return Object.freeze({ edges, complete });
}
export const nodeIds = (value: unknown, max: number): readonly NodeId[] =>
  graphList(value, max, (item) => graphName(item), 'node-limit');
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
