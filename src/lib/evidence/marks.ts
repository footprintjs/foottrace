/**
 * marks.ts — the one admission of attention marks: a fixed reason, a named kind, evidence references only. The cause graph
 * and the run-evidence reader read marks through this rule, and the writer's `about` stores them through it, each with its
 * own refusal: what a writer stores, its reader admits.
 */
import type { Attention } from '../cause/types.js';
import { boundedList, boundedName, type RefuseEvidence, ownData } from './admission.js';
import { ATTENTION_REASONS, type AttentionReason, type GapCode } from './codes.js';

/** How much one stage may carry: the writer is bound by these too. */
export const ATTENTION_LIMITS = /* @__PURE__ */ Object.freeze({ marks: 32, refs: 16, refLength: 512 });

const REASONS: ReadonlySet<string> = /* @__PURE__ */ new Set<string>(ATTENTION_REASONS);

/** What one caller brings to the rule: its refusal, its treatment of proxy traps, and its caps where it has its own. */
export interface MarkAdmission {
  readonly refuse: RefuseEvidence;
  readonly descriptors: Parameters<typeof ownData>[3];
  /** Marks in a list; {@link ATTENTION_LIMITS} unless said. */
  readonly marks?: number;
  /** Evidence refs on one mark; {@link ATTENTION_LIMITS} unless said. */
  readonly refs?: number;
  /** What a list past its cap is refused as; `invalid-data` unless said. */
  readonly overflow?: GapCode;
}

/** Read a list of marks as data, frozen: ordinary arrays only, within this caller's caps. */
export function admitMarks(value: unknown, admission: MarkAdmission): readonly Attention[] {
  const { refuse, descriptors, overflow = 'invalid-data' } = admission;
  const { marks = ATTENTION_LIMITS.marks, refs = ATTENTION_LIMITS.refs } = admission;
  const options = { refuse, overflow, freeze: true, descriptors } as const;
  const ordinaryList = <T>(list: unknown, maximum: number, read: (item: unknown) => T): readonly T[] => {
    if (!Array.isArray(list) || Object.getPrototypeOf(list) !== Array.prototype) throw refuse();
    return boundedList(list, maximum, read, options);
  };
  return ordinaryList(value, marks, (item) => {
    if (!item || typeof item !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      throw refuse();
    }
    const kind = ownData(item, 'kind', refuse, descriptors);
    const reason = ownData(item, 'reason', refuse, descriptors);
    if (typeof kind !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(kind)) throw refuse();
    if (typeof reason !== 'string' || !REASONS.has(reason)) throw refuse();
    const evidence = ordinaryList(ownData(item, 'evidence', refuse, descriptors), refs, (ref) =>
      boundedName(ref, ATTENTION_LIMITS.refLength, refuse),
    );
    if (kind !== 'not-collected' && evidence.length === 0) throw refuse();
    return Object.freeze({ kind, reason: reason as AttentionReason, evidence });
  });
}
