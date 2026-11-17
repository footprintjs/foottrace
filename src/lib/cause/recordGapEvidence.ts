import { ATTENTION_LIMITS } from '../evidence/marks.js';
import type { Gap } from './types.js';
import { CALLER_GAP_LIMIT } from './validation.js';

type ReferenceGap = Omit<Gap, 'evidence'> & { evidence: string[] };

/** Internal admitted references only; an edge cannot split, so its caller must report truncation. */
export function recordReferences(evidence: readonly string[]): { evidence: string[]; truncated: boolean } {
  const retained: string[] = [];
  for (const reference of evidence) {
    if (retained.includes(reference)) continue;
    if (retained.length === ATTENTION_LIMITS.refs) return { evidence: retained, truncated: true };
    retained.push(reference);
  }
  return { evidence: retained, truncated: false };
}

/** Native gaps share the public row/reference ceilings; no foreign-value admission happens here. */
export function recordGapEvidence(): { gaps: Gap[]; addGap: (gap: Gap) => void } {
  const gaps: ReferenceGap[] = [];
  let overflowed = false;
  const overflow = (): void => {
    overflowed = true;
    if (gaps.some((gap) => gap.code === 'truncated' && gap.nodeId === undefined && gap.evidence.length === 0)) return;
    // Only actual overflow displaces the final row to retain an explicit bounded limitation.
    gaps.length = CALLER_GAP_LIMIT - 1;
    gaps.push({ code: 'truncated', evidence: [] });
  };
  const addGap = (gap: Gap): void => {
    if (overflowed) return;
    const same = (row: Gap): boolean => row.code === gap.code && row.nodeId === gap.nodeId;
    const append = (): ReferenceGap | undefined => {
      if (gaps.length === CALLER_GAP_LIMIT) {
        overflow();
        return undefined;
      }
      const row: ReferenceGap = {
        code: gap.code,
        ...(gap.nodeId === undefined ? {} : { nodeId: gap.nodeId }),
        evidence: [],
      };
      gaps.push(row);
      return row;
    };
    let chunk: ReferenceGap | undefined;
    for (const row of gaps) if (same(row)) chunk = row;
    chunk ??= append();
    if (!chunk) return;
    for (const reference of gap.evidence) {
      if (gaps.some((row) => same(row) && row.evidence.includes(reference))) continue;
      if (chunk.evidence.length === ATTENTION_LIMITS.refs) {
        chunk = append();
        if (!chunk) return;
      }
      chunk.evidence.push(reference);
    }
  };
  return { gaps, addGap };
}
