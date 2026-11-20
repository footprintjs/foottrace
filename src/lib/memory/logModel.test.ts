import { describe, expect, it } from 'vitest';
import { DELIM } from '../record-paths/codec.js';
import { logModel, memoisedModel, withLogValueReader } from './logModel.js';
import type { CommitBundle } from './types.js';

const key = `profile${DELIM}chosen`;
const reader = { copyValue: structuredClone, equal: Object.is };

function commits(): CommitBundle[] {
  return ['first', 'second', 'third'].map((chosen, idx) => {
    const commit: CommitBundle = {
      idx,
      stageId: 'writer',
      stage: 'writer',
      runtimeStageId: `writer#${idx}`,
      trace: [Object.freeze({ path: 'profile', verb: 'set' })],
      overwrite: Object.freeze({ profile: Object.freeze({ chosen }) }),
      updates: Object.freeze({}),
      redactedPaths: [],
    };
    Object.freeze(commit.trace);
    return Object.freeze(commit);
  });
}

describe('scoped record value reader', () => {
  it('answers each exclusive cutoff for the same key inside one read', () => {
    const log = commits();
    withLogValueReader(log, reader, () => {
      const model = logModel(log);
      expect(model.lastWriterBefore(key, 1)).toBe(0);
      expect(model.lastWriterBefore(key, 3)).toBe(2);
      expect(model.lastWriterBefore(key, 2)).toBe(1);
      expect(model.lastWriterBefore(key, 1)).toBe(0);
    });
    expect(memoisedModel(log)).toBeUndefined();
  });

  it.each([false, true])('restores the previous model when a read throws (frozen log %s)', (frozen) => {
    const log = frozen ? Object.freeze(commits()) : commits();
    const prior = memoisedModel(log);
    const failure = new Error('read failed');
    expect(() =>
      withLogValueReader(log, reader, () => {
        const scoped = logModel(log);
        expect(scoped).not.toBe(prior);
        expect(memoisedModel(log)).toBe(scoped);
        throw failure;
      }),
    ).toThrow(failure);
    expect(memoisedModel(log)).toBe(prior);
  });

  it('returns to the outer reader after a nested read, then restores the earlier model', () => {
    const log = Object.freeze(commits());
    const prior = logModel(log);
    withLogValueReader(log, reader, () => {
      const outer = logModel(log);
      expect(outer).not.toBe(prior);
      expect(outer.lastWriterBefore(key, 2)).toBe(1);
      withLogValueReader(log, { ...reader, equal: () => true }, () => {
        const inner = logModel(log);
        expect(inner).not.toBe(outer);
        expect(inner.lastWriterBefore(key, 2)).toBe(-1);
      });
      expect(logModel(log)).toBe(outer);
      expect(outer.lastWriterBefore(key, 2)).toBe(1);
    });
    expect(logModel(log)).toBe(prior);
  });
});
