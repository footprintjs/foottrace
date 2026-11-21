import { describe, expect, it, vi } from 'vitest';

import { applySmartMerge, stateAt } from '../../../src/index';
import { EventLog } from '../../../src/write';
import { recordRun } from '../../helpers/recordRun';

const fixture = (commitValues: 'full' | 'delta', verb: 'set' | 'merge') => {
  const initialState = { value: { keep: 1 }, history: [1] };
  const patch = { added: 2 };
  const run = recordRun(initialState, { commitValues });
  const bundle = run.step('write', (scope) => {
    scope[verb]('value', patch);
    scope.set('history', [1, 2]);
  });
  const log = new EventLog(initialState);
  log.record(structuredClone(bundle));
  const expected = { value: verb === 'set' ? patch : { keep: 1, ...patch }, history: [1, 2] };
  return { initialState, bundle, log, expected };
};

type ReplayFixture = ReturnType<typeof fixture>;

const readers: Record<string, (input: ReplayFixture) => unknown> = {
  applySmartMerge: ({ initialState, bundle }) =>
    applySmartMerge(initialState, bundle.updates, bundle.overwrite, bundle.trace),
  materialise: ({ log }) => log.materialise(1),
  stateAt: ({ initialState, bundle }) => stateAt({ initialState, commitLog: [bundle] }, 0).state,
};

describe.each(['full', 'delta'] as const)('%s browser replay', (commitValues) => {
  describe.each(['set', 'merge'] as const)('%s', (verb) => {
    it.each(Object.entries(readers))('%s calls structuredClone with a valid receiver', (_, read) => {
      const input = fixture(commitValues, verb);
      expect(input.bundle.trace).toEqual([
        expect.objectContaining({ path: 'value', verb }),
        expect.objectContaining({ path: 'history', verb: commitValues === 'delta' ? 'append' : 'set' }),
      ]);

      const clone = globalThis.structuredClone;
      vi.stubGlobal('structuredClone', function (this: unknown, value: unknown) {
        if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
        return clone(value);
      });
      try {
        expect(read(input)).toEqual(input.expected);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
