import { describe, expect, it, vi } from 'vitest';
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
      initialStatePresence: 'unknown',
    });
    const later = { ...commit(1), overwrite: { config: { value: 2 } }, trace: [{ path: key, verb: 'set' as const }] };
    expect(findReadSources([commit(0, ['config']), later, reader], 2, key)).toEqual({
      before: -1,
      during: [],
      absenceReason: 'redacted',
      initialStatePresence: 'unknown',
    });
  });

  it('accounts for a redaction inside a possible read window when no writer is visible', () => {
    const reader = { ...commit(2), beganAt: 1, sawUntil: 2 };
    expect(findReadSources([commit(0), commit(1, ['config']), reader], 2, key)).toEqual({
      before: -1,
      during: [],
      absenceReason: 'redacted',
      initialStatePresence: 'unknown',
    });
  });

  it('preserves the writer fields of an answer with a visible writer', () => {
    const writer = { ...commit(0), overwrite: { x: 1 }, trace: [{ path: 'x', verb: 'set' as const }] };
    expect(findReadSources([writer, commit(1)], 1, 'x')).toEqual({
      before: 0,
      during: [],
      initialStatePresence: 'unknown',
    });
  });
});

describe('windowed read source initial state', () => {
  const log = [commit(0)];
  const absentFromLog = { before: -1, during: [], absenceReason: 'never-written' };

  it('adds unknown without changing any existing result fields or their serialized order', () => {
    const { initialStatePresence, ...legacy } = findReadSources(log, 0, key);
    expect(initialStatePresence).toBe('unknown');
    expect(JSON.stringify(legacy)).toBe(JSON.stringify(absentFromLog));
  });

  it.each([
    ['own value', { value: 0 }, 'value', 'present'],
    ['own undefined', { value: undefined }, 'value', 'present'],
    ['own array value', { value: [] }, 'value', 'present'],
    ['own nested undefined', { config: { value: undefined } }, key, 'present'],
    ['literal dotted name', { 'config.value': 7 }, 'config.value', 'present'],
    ['absent key', {}, 'value', 'absent'],
    ['absent parent', {}, key, 'absent'],
    ['scalar parent', { config: 'value' }, key, 'absent'],
    ['undefined parent', { config: undefined }, key, 'absent'],
    ['array parent', { config: [7] }, 'config\u001f0', 'absent'],
    ['inherited key', {}, 'toString', 'unknown'],
    ['non-object base', 'config', key, 'unknown'],
    ['array base', ['value'], '0', 'unknown'],
    ['null base', null, key, 'unknown'],
  ] as const)('reports %s independently of the log', (_, initialState, path, presence) => {
    expect(findReadSources(log, 0, path, { initialState: initialState as Readonly<Record<string, unknown>> })).toEqual({
      ...absentFromLog,
      initialStatePresence: presence,
    });
  });

  it('leaves accessors and unreadable metadata as unknown without invoking getters', () => {
    const get = vi.fn(() => ({ value: 1 }));
    const parentGetter = Object.defineProperty({}, 'config', { get });
    const finalGetter = { config: Object.defineProperty({}, 'value', { get }) };
    const inheritedGetter = Object.create(Object.defineProperty({}, 'config', { get }));
    for (const initialState of [parentGetter, finalGetter, inheritedGetter]) {
      expect(findReadSources(log, 0, key, { initialState }).initialStatePresence).toBe('unknown');
    }
    const optionGetter = Object.defineProperty({}, 'initialState', { get });
    expect(findReadSources(log, 0, key, optionGetter).initialStatePresence).toBe('unknown');
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(findReadSources(log, 0, key, { initialState: revoked.proxy }).initialStatePresence).toBe('unknown');
    expect(get).not.toHaveBeenCalled();
  });

  it('answers from the supplied base even when a writer or a redaction is visible', () => {
    const writer = { ...commit(0), overwrite: { x: 1 }, trace: [{ path: 'x', verb: 'set' as const }] };
    expect(findReadSources([writer, commit(1)], 1, 'x', { initialState: {} })).toEqual({
      before: 0,
      during: [],
      initialStatePresence: 'absent',
    });
    expect(
      findReadSources([commit(0, ['config']), commit(1)], 1, key, { initialState: { config: { value: undefined } } }),
    ).toEqual({ before: -1, during: [], absenceReason: 'redacted', initialStatePresence: 'present' });
  });
});
