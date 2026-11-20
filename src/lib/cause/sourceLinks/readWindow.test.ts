import { describe, expect, it } from 'vitest';
import { bundle } from '../../../../test/fixtures/source-links/recordHarness.js';
import { normalisePath } from '../../record-paths/codec.js';
import { sourceLinkReplay } from './replay.js';

describe('recorded write paths in the read window', () => {
  const key = normalisePath(['top', 'part']);
  const paths = [['top', 'part2'], ['top', 'part', 'selected'], ['top.part'], ['top']];
  const log = paths.map((segments, i) =>
    bundle(i, `writer-${i}`, {}, [{ path: normalisePath(segments), verb: 'set' }]),
  );

  it.each([
    { start: 0, end: 1, overlaps: false, visits: 1, reason: 'excludes the end and a common-prefix sibling' },
    { start: 1, end: 2, overlaps: true, visits: 1, reason: 'includes the write at the start' },
    { start: 2, end: 3, overlaps: false, visits: 1, reason: 'keeps a literal dot distinct from a nested path' },
    { start: 3, end: 9, overlaps: true, visits: 1, reason: 'counts an ancestor when the end exceeds the log' },
    { start: 1, end: 1, overlaps: false, visits: 0, reason: 'does no work in an empty window' },
    { start: 4, end: 9, overlaps: false, visits: 0, reason: 'does no work beyond the accounted log' },
    { start: 0, end: 4, overlaps: true, visits: 2, reason: 'stops at the first overlap' },
  ])('$reason', ({ start, end, overlaps, visits }) => {
    const budget = { left: 100 };
    const replay = sourceLinkReplay({ log, base: {} }, budget);
    const before = budget.left;
    expect(replay.hasWindowWrite(key, start, end)).toBe(overlaps);
    // Each visit charges one commit and the single row in that commit.
    expect(before - budget.left).toBe(visits * 2);
  });
});
