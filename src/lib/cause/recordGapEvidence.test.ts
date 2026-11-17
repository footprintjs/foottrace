import { describe, expect, it } from 'vitest';
import { recordGapEvidence, recordReferences } from './recordGapEvidence.js';
import type { Gap } from './types.js';
import { gaps as admitGaps, refs as admitReferences } from './validation.js';

const references = (count: number, start = 0): string[] =>
  Array.from({ length: count }, (_, index) => `proof:${start + index}`);
const gap = (evidence: readonly string[], nodeId?: string): Gap => ({
  code: 'scope-boundary',
  ...(nodeId === undefined ? {} : { nodeId }),
  evidence,
});
const truncation: Gap = { code: 'truncated', evidence: [] };

describe('native record gap evidence', () => {
  it.each([16, 17])('keeps all %i references in generically admissible chunks', (count) => {
    const result = recordGapEvidence();
    result.addGap(gap(references(count), 'selected'));
    expect(result.gaps).toEqual([
      gap(references(16), 'selected'),
      ...(count === 17 ? [gap(['proof:16'], 'selected')] : []),
    ]);
    expect(admitGaps(result.gaps)).toEqual(result.gaps);
  });

  it('deduplicates only within the same code and node identity, preserving encounter order', () => {
    const result = recordGapEvidence();
    result.addGap(gap(['proof:b', 'proof:a', 'proof:b'], 'one'));
    result.addGap(gap(['proof:a'], 'two'));
    result.addGap({ code: 'conservative', nodeId: 'one', evidence: ['proof:a'] });
    result.addGap(gap(['proof:c', 'proof:a'], 'one'));
    result.addGap(gap(['proof:a']));
    expect(result.gaps).toEqual([
      gap(['proof:b', 'proof:a', 'proof:c'], 'one'),
      gap(['proof:a'], 'two'),
      { code: 'conservative', nodeId: 'one', evidence: ['proof:a'] },
      gap(['proof:a']),
    ]);
    expect(admitGaps(result.gaps)).toEqual(result.gaps);
  });

  it('remerges already split rows without overflowing or joining unrelated keys', () => {
    const original = recordGapEvidence();
    original.addGap(gap(references(17), 'one'));
    original.addGap(gap(['proof:separate'], 'two'));
    const combined = recordGapEvidence();
    for (const row of [...original.gaps, ...original.gaps]) combined.addGap(row);
    combined.addGap(gap(['proof:17', 'proof:1'], 'one'));
    expect(combined.gaps).toEqual([
      gap(references(16), 'one'),
      gap(references(2, 16), 'one'),
      gap(['proof:separate'], 'two'),
    ]);
    expect(admitGaps(combined.gaps)).toEqual(combined.gaps);
  });

  it('retains code-only gaps and fills their evidence without duplicate empty rows', () => {
    const result = recordGapEvidence();
    result.addGap(gap([], 'one'));
    result.addGap(gap([], 'one'));
    result.addGap(gap(['proof:one'], 'one'));
    result.addGap(gap([], 'one'));
    result.addGap({ code: 'not-collected', evidence: [] });
    expect(result.gaps).toEqual([gap(['proof:one'], 'one'), { code: 'not-collected', evidence: [] }]);
    expect(admitGaps(result.gaps)).toEqual(result.gaps);
  });

  it('copies retained rows and evidence without mutating or retaining input arrays', () => {
    const input = ['proof:one'];
    const row = gap(input, 'one');
    const result = recordGapEvidence();
    result.addGap(row);
    result.addGap(gap(['proof:two'], 'one'));
    expect(input).toEqual(['proof:one']);
    expect(result.gaps[0]).not.toBe(row);
    expect(result.gaps[0].evidence).not.toBe(input);
    input.push('proof:changed');
    expect(result.gaps).toEqual([gap(['proof:one', 'proof:two'], 'one')]);
  });

  it.each([32, 33])('keeps %i distinct gap identities within the unchanged row ceiling', (count) => {
    const result = recordGapEvidence();
    for (let index = 0; index < count; index++) result.addGap(gap([`proof:${index}`], `node:${index}`));
    const retained = count === 32 ? 32 : 31;
    expect(result.gaps).toEqual([
      ...Array.from({ length: retained }, (_, index) => gap([`proof:${index}`], `node:${index}`)),
      ...(count === 33 ? [truncation] : []),
    ]);
    expect(admitGaps(result.gaps)).toEqual(result.gaps);
  });

  it('keeps exactly 512 unique references and their remerged chunks without a false truncation', () => {
    const result = recordGapEvidence();
    result.addGap(gap(references(512)));
    expect(result.gaps).toHaveLength(32);
    expect(result.gaps.flatMap((row) => row.evidence)).toEqual(references(512));
    const combined = recordGapEvidence();
    for (const row of [...result.gaps, ...result.gaps]) combined.addGap(row);
    expect(combined.gaps).toEqual(result.gaps);
    expect(admitGaps(combined.gaps)).toEqual(combined.gaps);
  });

  it.each([513, 1024])('reports actual %i-reference overflow with an admissible retained prefix', (count) => {
    const result = recordGapEvidence();
    result.addGap(gap(references(count)));
    expect(result.gaps).toHaveLength(32);
    expect(result.gaps.slice(0, -1).flatMap((row) => row.evidence)).toEqual(references(496));
    expect(result.gaps.at(-1)).toEqual(truncation);
    expect(admitGaps(result.gaps)).toEqual(result.gaps);
    const before = JSON.stringify(result.gaps);
    result.addGap(gap(['proof:later'], 'later'));
    result.addGap(gap(['proof:0']));
    expect(JSON.stringify(result.gaps)).toBe(before);
  });

  it('retains an existing reference-free truncation marker without adding a second one', () => {
    const result = recordGapEvidence();
    result.addGap(truncation);
    for (let index = 0; index < 31; index++) result.addGap(gap([], `node:${index}`));
    const before = JSON.stringify(result.gaps);
    result.addGap(gap([], 'overflow'));
    expect(JSON.stringify(result.gaps)).toBe(before);
    expect(result.gaps.filter((row) => row.code === 'truncated')).toEqual([truncation]);
    expect(admitGaps(result.gaps)).toEqual(result.gaps);
  });

  it('does not mistake a node-scoped truncation reason for the global overflow marker', () => {
    const result = recordGapEvidence();
    result.addGap({ ...truncation, nodeId: 'one' });
    for (let index = 0; index < 32; index++) result.addGap(gap([], `node:${index}`));
    expect(result.gaps).toHaveLength(32);
    expect(result.gaps[0]).toEqual({ ...truncation, nodeId: 'one' });
    expect(result.gaps.at(-1)).toEqual(truncation);
    expect(admitGaps(result.gaps)).toEqual(result.gaps);
  });
});

describe('native edge references', () => {
  it.each([0, 16, 17])('retains an admissible prefix and reports %i-reference overflow exactly', (count) => {
    const result = recordReferences(references(count));
    expect(result).toEqual({ evidence: references(Math.min(count, 16)), truncated: count > 16 });
    expect(admitReferences(result.evidence)).toEqual(result.evidence);
  });

  it('deduplicates before charging the reference ceiling and never mutates its input', () => {
    const input = [...references(16), ...references(16)];
    const before = [...input];
    const result = recordReferences(input);
    expect(result).toEqual({ evidence: references(16), truncated: false });
    expect(result.evidence).not.toBe(input);
    expect(input).toEqual(before);
    expect(recordReferences([...input, 'proof:16'])).toEqual({ evidence: references(16), truncated: true });
  });
});
