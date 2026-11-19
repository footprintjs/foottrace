import { describe, expect, it } from 'vitest';
import { findReadSources } from '../../index.js';
import type { CommitBundle } from './types.js';

function commit(idx: number, redactedPaths: string[] = []): CommitBundle {
  return {
    idx,
    stage: 'step',
    stageId: 'step',
    runtimeStageId: 'step#' + idx,
    overwrite: {},
    updates: {},
    trace: [],
    redactedPaths,
  };
}

const key = 'config\u001fvalue';

describe('windowed read source absence', () => {
  it('uses only redactions before a pinned read, including a redacted ancestor', () => {
    const reader = { ...commit(2), beganAt: 1 };
    expect(findReadSources([commit(0), commit(1, ['config']), reader], 2, key)).toEqual({
      before: -1,
      during: [],
      absenceReason: 'never-written',
    });
    const later = { ...commit(1), overwrite: { config: { value: 2 } }, trace: [{ path: key, verb: 'set' as const }] };
    expect(findReadSources([commit(0, ['config']), later, reader], 2, key)).toEqual({
      before: -1,
      during: [],
      absenceReason: 'redacted',
    });
  });

  it('accounts for a redaction inside a possible read window when no writer is visible', () => {
    const reader = { ...commit(2), beganAt: 1, sawUntil: 2 };
    expect(findReadSources([commit(0), commit(1, ['config']), reader], 2, key)).toEqual({
      before: -1,
      during: [],
      absenceReason: 'redacted',
    });
  });

  it('preserves the shape of an answer with a visible writer', () => {
    const writer = { ...commit(0), overwrite: { x: 1 }, trace: [{ path: 'x', verb: 'set' as const }] };
    expect(findReadSources([writer, commit(1)], 1, 'x')).toEqual({ before: 0, during: [] });
  });
});
