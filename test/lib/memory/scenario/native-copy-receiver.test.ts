/**
 * Replay must call `structuredClone` the way a browser allows: with no receiver.
 *
 * 2.3.0 stored the global as a default constructor value and called it as
 * `this.copyValue(...)`. Chromium refuses that receiver with
 * `TypeError: Illegal invocation`, for both replay verbs; Node does not check,
 * so every Node suite passed. This stand-in checks the receiver the way a
 * browser does, so the fault shows in Node.
 *
 * The records are written by the writer (`foottrace/write`, through
 * test/helpers/recordRun.ts) while the stand-in is installed, in both
 * `commitValues` encodings, and read back through every replay door:
 * `EventLog.materialise`, `stateAt`, a fold with `applySmartMerge`, and
 * `commitValueAt`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applySmartMerge, commitValueAt, stateAt, type CommitBundle } from '../../../../src/index';
import { recordRun } from '../../../helpers/recordRun';

const realClone = globalThis.structuredClone;

function browserLikeClone(this: unknown, value: unknown, options?: StructuredSerializeOptions): unknown {
  if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
  return realClone(value, options);
}

/** A seed, a merge into a nested record, a growing list, a replaced value and a delete: every verb the writer emits. */
function writeRun(commitValues: 'full' | 'delta') {
  const rec = recordRun({}, { commitValues });
  rec.step('seed', (s) => {
    s.set('profile', { name: 'Ada', tags: ['a'] });
    s.set('history', []);
    s.set('scratch', 1);
  });
  rec.step('merge', (s) => s.merge('profile', { tags: ['b'], city: 'Paris' }));
  rec.step('append', (s) => s.set('history', [...(s.read('history') as unknown[]), { step: 1 }]));
  rec.step('replace', (s) => s.set('profile', { ...(s.read('profile') as object), name: 'Grace' }));
  rec.step('cleanup', (s) => s.delete('scratch'));
  const { commitLog, initialState } = rec.snapshot();
  return { rec, commitLog, initialState, state: realClone(rec.state.getState()) as Record<string, unknown> };
}

function foldAll(initialState: unknown, log: readonly CommitBundle[]): unknown {
  let state = realClone(initialState ?? {});
  for (const b of log) state = applySmartMerge(state, b.updates, b.overwrite, b.trace);
  return state;
}

describe('replay with a browser-like structuredClone', () => {
  beforeEach(() => {
    globalThis.structuredClone = browserLikeClone as typeof structuredClone;
  });
  afterEach(() => {
    globalThis.structuredClone = realClone;
  });

  it('the stand-in refuses a receiver, as a browser does', () => {
    const holder = { copy: globalThis.structuredClone };
    expect(() => holder.copy({ a: 1 })).toThrow('Illegal invocation');
    expect(globalThis.structuredClone({ a: 1 })).toEqual({ a: 1 });
  });

  for (const encoding of ['full', 'delta'] as const) {
    describe(`a writer-made record, commitValues '${encoding}'`, () => {
      // The writer folds each commit into the next generation through the same payload, so on 2.3.0 a browser
      // could not even write the record: every stage's commit threw.
      it('the writer commits every stage, with both replay verbs', () => {
        const { commitLog } = writeRun(encoding);
        const verbs = new Set(commitLog.flatMap((b) => b.trace.map((t) => t.verb)));
        expect(verbs.has('set')).toBe(true);
        expect(verbs.has('merge')).toBe(true);
        // The full encoding records a removal as a `set` of the key's new state; the delta encoding names it.
        if (encoding === 'delta') expect([...verbs].sort()).toEqual(['append', 'delete', 'merge', 'set']);
      });

      it('EventLog.materialise replays every prefix', () => {
        const { rec, state } = writeRun(encoding);
        expect(rec.log.materialise()).toEqual(state);
        expect(rec.log.materialise(2)).toEqual({
          profile: { name: 'Ada', tags: ['a', 'b'], city: 'Paris' },
          history: [],
          scratch: 1,
        });
      });

      it('stateAt folds to the live state at every commit', () => {
        const { rec, commitLog, initialState, state } = writeRun(encoding);
        for (let i = 0; i < commitLog.length; i++) {
          expect(stateAt({ commitLog, initialState }, i).state).toEqual(rec.log.materialise(i + 1));
        }
        expect(stateAt({ commitLog, initialState }, commitLog.length - 1).state).toEqual(state);
      });

      it('applySmartMerge folds the whole record to the live state', () => {
        const { commitLog, initialState, state } = writeRun(encoding);
        expect(foldAll(initialState, commitLog)).toEqual(state);
      });

      it('commitValueAt reads each key through set, merge and append', () => {
        const { commitLog, state } = writeRun(encoding);
        const last = commitLog.length - 1;
        expect(commitValueAt(commitLog, 1, 'profile')).toEqual({ name: 'Ada', tags: ['a', 'b'], city: 'Paris' });
        expect(commitValueAt(commitLog, last, 'profile')).toEqual(state.profile);
        expect(commitValueAt(commitLog, last, 'history')).toEqual([{ step: 1 }]);
      });
    });
  }
});
