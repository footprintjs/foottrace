/**
 * Replay must call `structuredClone` the way a browser allows: with no receiver.
 *
 * 2.3.0 stored the global as a default constructor value and called it as
 * `this.copyValue(...)`. Chromium refuses that receiver with
 * `TypeError: Illegal invocation`, for both replay verbs; Node does not check,
 * so every Node suite passed. This stand-in checks the receiver the way a
 * browser does, so the fault shows in Node.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applySmartMerge, commitValueAt, stateAt, type CommitBundle } from '../../../../src/index';
import { DELIM } from '../../../../src/lib/record-paths/codec';

const realClone = globalThis.structuredClone;

function browserLikeClone(this: unknown, value: unknown, options?: StructuredSerializeOptions): unknown {
  if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
  return realClone(value, options);
}

beforeEach(() => {
  globalThis.structuredClone = browserLikeClone as typeof structuredClone;
});
afterEach(() => {
  globalThis.structuredClone = realClone;
});

const bundle = (
  idx: number,
  updates: Record<string, unknown>,
  overwrite: Record<string, unknown>,
  trace: CommitBundle['trace'],
) =>
  ({
    idx,
    stage: `step${idx}`,
    stageId: `step${idx}`,
    runtimeStageId: `step${idx}#${idx}`,
    trace,
    redactedPaths: [],
    overwrite,
    updates,
  } as unknown as CommitBundle);

const setRow = bundle(0, {}, { profile: { name: 'Ada', tags: ['a'] } }, [{ path: 'profile', verb: 'set' }]);
const mergeRow = bundle(1, { profile: { tags: ['b'], city: 'Paris' } }, {}, [{ path: 'profile', verb: 'merge' }]);
const nestedSet = bundle(2, {}, { profile: { name: 'Grace' } }, [{ path: `profile${DELIM}name`, verb: 'set' }]);

describe('replay with a browser-like structuredClone', () => {
  it('the stand-in refuses a receiver, as a browser does', () => {
    const holder = { copy: globalThis.structuredClone };
    expect(() => holder.copy({ a: 1 })).toThrow('Illegal invocation');
    expect(globalThis.structuredClone({ a: 1 })).toEqual({ a: 1 });
  });

  it.each([
    ['set', setRow],
    ['merge', mergeRow],
  ] as const)('applySmartMerge replays a %s row', (_verb, row) => {
    const out = applySmartMerge({ profile: { name: 'Ada', tags: ['a'] } }, row.updates, row.overwrite, row.trace);
    expect(out.profile.name).toBe('Ada');
  });

  it('stateAt folds set, merge and a nested set', () => {
    const { state } = stateAt({ commitLog: [setRow, mergeRow, nestedSet], initialState: {} }, 2);
    expect(state).toEqual({ profile: { name: 'Grace', tags: ['a', 'b'], city: 'Paris' } });
  });

  it('commitValueAt folds one key through set and merge', () => {
    expect(commitValueAt([setRow, mergeRow], 1, 'profile')).toEqual({ name: 'Ada', tags: ['a', 'b'], city: 'Paris' });
  });
});
