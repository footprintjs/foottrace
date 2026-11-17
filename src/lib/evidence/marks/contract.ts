import type { ownData, RefuseEvidence } from '../admission.js';
import type { GapCode } from '../codes.js';

/** How much one stage may carry: the writer is bound by these too. */
export const ATTENTION_LIMITS = /* @__PURE__ */ Object.freeze({ marks: 32, refs: 16, refLength: 512 });

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
