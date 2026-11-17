import type { Attention } from '../../cause/types.js';
import { boundedName, ownData } from '../admission.js';
import { ATTENTION_REASONS, type AttentionReason } from '../codes.js';
import { ATTENTION_LIMITS, type MarkAdmission } from './contract.js';
import { ordinaryList } from './ordinary.js';

const REASONS: ReadonlySet<string> = /* @__PURE__ */ new Set<string>(ATTENTION_REASONS);

/** The one per-mark schema; strict and partial query admission copy the same facts in the same order. */
export function readMark(item: unknown, admission: MarkAdmission): Attention {
  const { refuse, descriptors, refs = ATTENTION_LIMITS.refs } = admission;
  if (!item || typeof item !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) {
    throw refuse();
  }
  const kind = ownData(item, 'kind', refuse, descriptors);
  const reason = ownData(item, 'reason', refuse, descriptors);
  if (typeof kind !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(kind)) throw refuse();
  if (typeof reason !== 'string' || !REASONS.has(reason)) throw refuse();
  const evidence = ordinaryList(
    ownData(item, 'evidence', refuse, descriptors),
    refs,
    (ref) => boundedName(ref, ATTENTION_LIMITS.refLength, refuse),
    admission,
  );
  if (kind !== 'not-collected' && evidence.length === 0) throw refuse();
  return Object.freeze({ kind, reason: reason as AttentionReason, evidence });
}
