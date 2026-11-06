/**
 * marks.ts — the one admission of attention marks: a fixed reason, a named kind, evidence references only. Both the cause
 * graph and the run-evidence reader read marks from stored data, each with its own refusal, through this rule.
 */
import type { Attention, AttentionReason } from '../cause/types.js';
import { boundedList, boundedName, type RefuseEvidence, ownData } from './admission.js';

/** How much one stage may carry: the writer is bound by these too. */
export const ATTENTION_LIMITS = /* @__PURE__ */ Object.freeze({ marks: 32, refs: 16, refLength: 512 });

const REASONS: ReadonlySet<string> = /* @__PURE__ */ new Set<AttentionReason>([
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

/** Read a list of marks as data, frozen. Each caller keeps its own refusal and its own treatment of proxy traps. */
export function admitMarks(
  value: unknown,
  refuse: RefuseEvidence,
  descriptors: Parameters<typeof ownData>[3],
): readonly Attention[] {
  const options = { refuse, overflow: 'invalid-data', freeze: true, descriptors } as const;
  return boundedList(
    value,
    ATTENTION_LIMITS.marks,
    (item) => {
      if (!item || typeof item !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) {
        throw refuse();
      }
      const kind = ownData(item, 'kind', refuse, descriptors);
      const reason = ownData(item, 'reason', refuse, descriptors);
      if (typeof kind !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(kind)) throw refuse();
      if (typeof reason !== 'string' || !REASONS.has(reason)) throw refuse();
      const evidence = boundedList(
        ownData(item, 'evidence', refuse, descriptors),
        ATTENTION_LIMITS.refs,
        (ref) => boundedName(ref, ATTENTION_LIMITS.refLength, refuse),
        options,
      );
      if (kind !== 'not-collected' && evidence.length === 0) throw refuse();
      return Object.freeze({ kind, reason: reason as AttentionReason, evidence });
    },
    options,
  );
}
