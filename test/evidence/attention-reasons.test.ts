/** Unit law: the attention reason type and the mark rule's runtime set are one list, so neither can miss a reason. */
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { AttentionReason } from '../../src/cause.js';
import { ATTENTION_REASONS } from '../../src/lib/cause/types.js';
import { EvidenceRefusal } from '../../src/lib/evidence/admission.js';
import { admitMarks } from '../../src/lib/evidence/marks.js';

const PUBLIC_MEMBERS = [
  'ERROR_RECORDED',
  'UNKNOWN_EFFECT_RECORDED',
  'RETRY_STOP_RECORDED',
  'TIMEOUT_RECORDED',
  'RETRY_RECORDED',
  'QUALITY_DROP_RECORDED',
  'EVIDENCE_NOT_COLLECTED',
  'OUTLIER_RECORDED',
  'BUSINESS_RULE_MATCHED',
] as const;

const admission = {
  refuse: () => new EvidenceRefusal('invalid-data', 'refused'),
  descriptors: { translateTrapErrors: true, requireOwnValue: true },
};

describe('attention reasons', () => {
  it('the public type keeps its exact members, and they are the list', () => {
    expectTypeOf<AttentionReason>().toEqualTypeOf<(typeof PUBLIC_MEMBERS)[number]>();
    expectTypeOf<(typeof ATTENTION_REASONS)[number]>().toEqualTypeOf<AttentionReason>();
    expect([...ATTENTION_REASONS]).toEqual([...PUBLIC_MEMBERS]);
    expect(Object.isFrozen(ATTENTION_REASONS)).toBe(true);
  });

  it('the mark rule admits every reason on the list, and nothing else', () => {
    const marks = ATTENTION_REASONS.map((reason) => ({ kind: 'error', reason, evidence: ['e'] }));
    expect(admitMarks(marks, admission).map((mark) => mark.reason)).toEqual([...ATTENTION_REASONS]);
    expect(() => admitMarks([{ kind: 'error', reason: 'NOT_A_REASON', evidence: ['e'] }], admission)).toThrow(
      EvidenceRefusal,
    );
  });
});
