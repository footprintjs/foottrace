/**
 * The text and JSON projections must carry what the query result knows.
 *
 * 1. A slice with no writer in range can still hold a note: a redaction hid the write. Both
 *    projections dropped it and said the value "came from initial state", which was the wrong claim.
 * 2. A nested key is stored as its segments joined by U+001F. The text projections printed that
 *    invisible control character; they show the segments the way the notes already do.
 */
import { describe, expect, it } from 'vitest';

import { causalChain, formatCausalChain } from '../../../src/lib/memory/backtrack.js';
import type { CommitBundle, TraceEntry } from '../../../src/lib/memory/types.js';
import {
  formatForwardSlice,
  formatSlice,
  formatTimeline,
  forwardSliceForKey,
  keysReadFromMap,
  keyTimeline,
  sliceForKey,
  sliceToJSON,
} from '../../../src/lib/slice/index.js';

const SEPARATOR = '\u001f';

function commit(
  runtimeStageId: string,
  writes: string[],
  idx: number,
  extra: Partial<CommitBundle> = {},
): CommitBundle {
  const stageId = runtimeStageId.split('#')[0];
  return {
    idx,
    stage: stageId,
    stageId,
    runtimeStageId,
    trace: writes.map((path): TraceEntry => ({ path, verb: 'set' })),
    redactedPaths: [],
    overwrite: Object.fromEntries(writes.map((path) => [path, `val-${path}`])),
    updates: {},
    ...extra,
  };
}

describe('a slice with no writer in range keeps its note', () => {
  // The only write of cfg was redacted, so the log cannot show a write of cfg.a.
  const log = [commit('S#0', ['cfg'], 0, { overwrite: { cfg: 'REDACTED' }, redactedPaths: ['cfg'] })];
  const slice = sliceForKey(log, ['cfg', 'a'], () => []);

  it('is the case under test: never-written, with a redacted note', () => {
    expect(slice.missing).toBe('never-written');
    expect(slice.notes?.map((note) => note.code)).toEqual(['redacted']);
  });

  it('sliceToJSON carries the note', () => {
    expect(sliceToJSON(slice).notes?.map((note) => note.code)).toEqual(['redacted']);
  });

  it('formatSlice prints the note and does not claim the value came from before the run', () => {
    const text = formatSlice(slice);
    expect(text).toContain(`⚠ ${slice.notes![0].detail}`);
    expect(text).not.toContain('came from');
  });

  it('a slice that is never-written with no note keeps its sentence', () => {
    const plain = sliceForKey([commit('S#0', ['other'], 0)], 'absent', () => []);
    expect(plain.notes).toBeUndefined();
    expect(formatSlice(plain)).toContain(
      "no slice: 'absent' was never written in range — the value came from initial state",
    );
    expect(sliceToJSON(plain)).not.toHaveProperty('notes');
  });
});

describe('text projections show a nested key by its segments', () => {
  const nested = `cfg${SEPARATOR}a`;
  const log = [commit('W#0', [nested], 0), commit('R#1', ['out'], 1)];
  const reads = keysReadFromMap({ 'R#1': [nested] });

  it('formatSlice', () => {
    const text = formatSlice(sliceForKey(log, ['cfg', 'a'], reads));
    expect(text).not.toContain(SEPARATOR);
    expect(text).toContain("SLICE for 'cfg › a'");
  });

  it('formatCausalChain: the key an edge names and the keys a stage wrote', () => {
    const text = formatCausalChain(causalChain(log, 'R#1', (id) => (id === 'R#1' ? [nested] : []))!);
    expect(text).not.toContain(SEPARATOR);
    expect(text.split('\n')).toEqual(['R (R#1) [wrote: out]', '  W (W#0) ← via cfg › a [wrote: cfg › a]']);
  });

  it('formatForwardSlice', () => {
    const text = formatForwardSlice(forwardSliceForKey(log, ['cfg', 'a'], reads));
    expect(text).not.toContain(SEPARATOR);
    expect(text).toContain("FORWARD SLICE for 'cfg › a'");
    expect(text).toContain("'cfg › a' set by W (W#0) @0");
  });

  it('formatTimeline', () => {
    const text = formatTimeline(keyTimeline(log, ['cfg', 'a'], reads));
    expect(text).not.toContain(SEPARATOR);
    expect(text).toContain("TIMELINE for 'cfg › a'");
  });

  it('the unknown-key note, for the key asked and for the keys it lists', () => {
    const forward = forwardSliceForKey(log, ['cfg', 'zzz'], reads);
    const note = forward.notes.find((entry) => entry.code === 'unknown-key')!;
    expect(note.detail).not.toContain(SEPARATOR);
    expect(note.detail).toContain("unknown key 'cfg › zzz'");
    expect(note.detail).toContain('cfg › a');
    expect(formatForwardSlice(forward)).not.toContain(SEPARATOR);
    expect(formatTimeline(keyTimeline(log, ['cfg', 'zzz'], reads))).not.toContain(SEPARATOR);
  });

  it('a top-level key prints exactly as before', () => {
    const flat = [commit('W#0', ['k'], 0), commit('R#1', ['out'], 1)];
    const text = formatSlice(sliceForKey(flat, 'out', keysReadFromMap({ 'R#1': ['k'] })));
    expect(text.split('\n')).toEqual([
      "SLICE for 'out' — reads via: map",
      'R (R#1) [wrote: out]',
      '  W (W#0) ← via k [wrote: k]',
    ]);
  });
});
