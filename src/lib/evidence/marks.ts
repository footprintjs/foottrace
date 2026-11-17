/**
 * marks.ts — the one admission of attention marks: a fixed reason, a named kind, evidence references only. The cause graph
 * and the run-evidence reader read marks through this rule, and the writer's `about` stores them through it, each with its
 * own refusal: what a writer stores, its reader admits.
 */
import type { Attention } from '../cause/types.js';
import { ownData } from './admission.js';
import { ATTENTION_LIMITS, type MarkAdmission } from './marks/contract.js';
import { ordinaryList, ordinarySlots } from './marks/ordinary.js';
import { readMark } from './marks/readMark.js';
export { ATTENTION_LIMITS, type MarkAdmission } from './marks/contract.js';

/** Read a list of marks as data, frozen: ordinary arrays only, within this caller's caps. */
export function admitMarks(value: unknown, admission: MarkAdmission): readonly Attention[] {
  const { marks = ATTENTION_LIMITS.marks } = admission;
  return ordinaryList(value, marks, (item) => readMark(item, admission), admission);
}

/** Internal query facts: both parts must pass the Session's timely acceptance together. */
export interface MarkProjection {
  readonly marks: readonly Attention[];
  readonly rejected: boolean;
}

/** Opt-in generic query policy; the outer shape/cap still refuses atomically. */
export function retainValidMarks(value: unknown, admission: MarkAdmission): MarkProjection {
  const { marks: maximum = ATTENTION_LIMITS.marks } = admission;
  let rejected = false;
  const slots = ordinarySlots(
    value,
    maximum,
    (index) => {
      try {
        return readMark(ownData(value, String(index), admission.refuse, admission.descriptors), admission);
      } catch {
        rejected = true;
        return undefined;
      }
    },
    admission,
  );
  const marks = Object.freeze(slots.filter((item): item is Attention => item !== undefined));
  return Object.freeze({ marks, rejected });
}
