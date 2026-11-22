import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import * as cause from '../../../cause.js';
import type { SourceLinkRowLocation } from '../../../cause.js';
import {
  bundle,
  encodings,
  scopeFor,
  servedWrite,
  witness,
  type Encoding,
} from '../../../../test/fixtures/source-links/recordHarness.js';
import * as replay from './replay.js';
import { readerLimits } from '../../evidence/readerLimits.js';

function fixture(encoding: Encoding, total: number, hidden = 'short') {
  const input = { key: 'seed' };
  const row = witness(input, { key: 'answer', checkedIn: 'written' });
  const history = Array.from({ length: total }, () => structuredClone(row));
  const records = history.map((entry, index) =>
    encoding === 'full'
      ? bundle(index + 1, `door-${index}`, { answer: index, evidence: history.slice(0, index + 1), other: hidden })
      : bundle(index + 1, `door-${index}`, { answer: index, evidence: [entry], other: hidden }, [
          { path: 'answer', verb: 'set' },
          { path: 'evidence', verb: 'append' },
          { path: 'other', verb: 'set' },
        ]),
  );
  const scope = scopeFor({ seed: 'seed', evidence: [] }, [servedWrite(0, [{ key: input.key }]), ...records], []);
  const locators: SourceLinkRowLocation[] = records.map(({ runtimeStageId }, index) => ({
    runtimeStageId,
    commitIdx: index + 1,
    key: 'evidence',
    element: index,
  }));
  return { scope, locators };
}

describe.each(encodings)('%s batched source-link binding', (encoding) => {
  it('preserves order and repeats and returns an answer for every locator', () => {
    const { scope, locators } = fixture(encoding, 4);
    const choices = [3, -1, 0, 3, 2];
    const requested = choices.map((choice) => locators[choice] ?? { ...locators[0], element: 100 });
    expect(cause.bindSourceLinkWrites(scope, requested)).toEqual({
      writes: choices.map((choice) =>
        choice < 0 ? undefined : { commitIdx: choice + 1, runtimeStageId: `door-${choice}` },
      ),
      complete: true,
    });
  });

  it('matches individually bound positions across generated records, repeats and misses', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.array(fc.integer({ min: 0, max: 12 }), { maxLength: 25 }),
        (size, choices) => {
          const { scope, locators } = fixture(encoding, size);
          const requested = choices.map((index) => locators[index] ?? { ...locators[0], commitIdx: 999 });
          expect(cause.bindSourceLinkWrites(scope, requested)).toEqual({
            writes: requested.map((locator) => cause.bindSourceLinkWrite(scope, locator)),
            complete: true,
          });
        },
      ),
      { seed: 20261120, numRuns: 128 },
    );
  });

  it('keeps the same answers and completion when hidden text changes', () => {
    const first = fixture(encoding, 8);
    const second = fixture(encoding, 8, 'x'.repeat(100_000));
    expect(cause.bindSourceLinkWrites(second.scope, second.locators)).toEqual(
      cause.bindSourceLinkWrites(first.scope, first.locators),
    );
    expect(cause.bindSourceLinkWrites(first.scope, first.locators).writes.filter(Boolean)).toHaveLength(8);
  });
});

it('admits and indexes the scope once for many locators', () => {
  const { scope, locators } = fixture('delta', 10);
  let reads = 0;
  const measured = new Proxy(scope, {
    getOwnPropertyDescriptor(target, key) {
      if (key === 'commitLog') reads++;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  const index = vi.spyOn(replay, 'sourceLinkReplay');
  try {
    const result = cause.bindSourceLinkWrites(measured, [...locators, ...locators]);
    expect(result.complete).toBe(true);
    expect(result.writes.filter(Boolean)).toHaveLength(20);
    expect(reads).toBe(1);
    expect(index).toHaveBeenCalledTimes(1);
  } finally {
    index.mockRestore();
  }
});

it('reports a scope limit instead of claiming that its rows do not bind', () => {
  const { scope, locators } = fixture('delta', 1);
  const tooManyCommits = [...scope.commitLog, ...Array.from({ length: 4096 }, () => scope.commitLog[0])];
  expect(cause.bindSourceLinkWrites({ ...scope, commitLog: tooManyCommits }, locators)).toEqual({
    writes: [undefined],
    complete: false,
    reason: 'node-limit',
  });
});

it('stops at 256 locators without reading an accessor beyond that cap', () => {
  const { scope, locators } = fixture('delta', 1);
  const getter = vi.fn(() => locators[0]);
  const requested = Array.from({ length: 257 }, () => locators[0]);
  Object.defineProperty(requested, '256', { get: getter });
  const result = cause.bindSourceLinkWrites(scope, requested);
  expect(getter).not.toHaveBeenCalled();
  expect(result.complete).toBe(false);
  expect(result.reason).toBe('node-limit');
  expect(result.writes).toEqual(Array.from({ length: 256 }, () => ({ commitIdx: 1, runtimeStageId: 'door-0' })));
});

it('returns known misses for ambiguous reads, unaccounted base and union positions', () => {
  const compare = (record: ReturnType<typeof fixture>) => {
    const result = cause.bindSourceLinkWrites(record.scope, record.locators);
    expect(result).toEqual({ writes: [undefined], complete: true });
  };
  const { scope, locators } = fixture('delta', 1);
  compare({ scope: { ...scope, initialState: undefined }, locators });

  const base = { seed: 'seed', evidence: [], answer: [] };
  const union = witness({ key: 'seed' }, { key: 'answer', element: 0, checkedIn: 'written' });
  const appendEvidence = { path: 'evidence', verb: 'append' } as const;
  const first = servedWrite(0, [{ key: 'seed' }]);
  const checkUnion = bundle(1, 'door-0', { evidence: [union] }, [appendEvidence, { path: 'answer', verb: 'merge' }], {
    answer: ['value'],
  });
  compare({ scope: scopeFor(base, [first, checkUnion], []), locators });

  const read = witness({ key: 'seed' }, { key: 'answer', checkedIn: 'read' });
  const commit = bundle(1, 'writer', { answer: 'overlap' });
  const checkRead = {
    ...bundle(2, 'door-0', { evidence: [read] }, [appendEvidence]),
    beganAt: 1,
    sawUntil: 2,
  };
  const readScope = { ...scopeFor(base, [first, commit, checkRead], []), reads: { 'door-0': ['answer'] } };
  compare({ scope: readScope, locators: [{ ...locators[0], commitIdx: 2 }] });
});

it('preserves the answered prefix and leaves the rest unknown when replay work runs out', () => {
  const { scope, locators } = fixture('delta', 3);
  const text = 'x'.repeat(1_100_000);
  const initialState = { ...scope.initialState, profile: { chosen: text } };
  const log = scope.commitLog as readonly ReturnType<typeof bundle>[];
  const extreme = witness({ key: 'seed' }, { key: 'profile', pointer: '/chosen', checkedIn: 'written' });
  const second = log[2];
  const commitLog = log.map((entry, index) =>
    index === 2
      ? {
          ...second,
          overwrite: { ...second.overwrite, profile: { chosen: text }, evidence: [extreme] },
          trace: [...second.trace, { path: 'profile', verb: 'set' as const }],
        }
      : entry,
  );
  expect(cause.bindSourceLinkWrites({ ...scope, initialState, commitLog }, locators)).toEqual({
    writes: [{ commitIdx: 1, runtimeStageId: 'door-0' }, undefined, undefined],
    complete: false,
    reason: 'truncated',
  });
});

it('refuses a foreign list or malformed slot without running getters', () => {
  const { scope, locators } = fixture('delta', 1);
  const getter = vi.fn(() => locators[0]);
  const foreignList = Object.defineProperty([locators[0]], '0', { get: getter });
  expect(cause.bindSourceLinkWrites(scope, foreignList)).toEqual({ writes: [], complete: false });

  const getKey = vi.fn(() => 'evidence');
  const foreignRow = Object.defineProperty({ ...locators[0] }, 'key', { get: getKey });
  const inherited = Object.assign(Object.create({ hidden: true }) as SourceLinkRowLocation, locators[0]);
  const known = { commitIdx: 1, runtimeStageId: 'door-0' };
  expect(cause.bindSourceLinkWrites(scope, [foreignRow, inherited, locators[0]])).toEqual({
    writes: [undefined, undefined, known],
    complete: true,
  });
  expect(getter).not.toHaveBeenCalled();
  expect(getKey).not.toHaveBeenCalled();

  const throwing = vi.fn(() => {
    throw new Error('descriptor failure');
  });
  const inaccessible = new Proxy(locators, { getOwnPropertyDescriptor: throwing });
  expect(cause.bindSourceLinkWrites(scope, inaccessible)).toEqual({ writes: [], complete: false });
  expect(throwing).toHaveBeenCalledTimes(1);
});

it('names structural work exhaustion when a record object cannot fit the remaining allowance', () => {
  const { scope, locators } = fixture('delta', 1);
  const initialState = {
    ...scope.initialState,
    tail: Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`entry${index}`, index])),
    pad: Array<number>(499_950).fill(0),
  };
  expect(cause.bindSourceLinkWrites({ ...scope, initialState }, locators)).toEqual({
    writes: [undefined],
    complete: false,
    reason: 'truncated',
  });
});

describe.each(encodings)('%s batch source-link cap', (encoding) => {
  it('keeps a missing last slot at both 256 and 257 requested positions', () => {
    const { scope, locators } = fixture(encoding, 2);
    const missing = { ...locators[1], element: 999 };
    const retained = Array.from({ length: 255 }, (_, index) => locators[index % 2]).concat(missing);
    const writes = retained.map((locator) => cause.bindSourceLinkWrite(scope, locator));

    expect(writes[255]).toBeUndefined();
    expect(cause.bindSourceLinkWrites(scope, retained)).toEqual({ writes, complete: true });
    expect(cause.bindSourceLinkWrites(scope, [...retained, locators[0]])).toEqual({
      writes,
      complete: false,
      reason: 'node-limit',
    });
  });
});

it('bounds replay work for repeated and distinct locators as the batch grows', () => {
  const keys = Array.from({ length: 64 }, (_, index) => `answer-${index}`);
  const evidence = keys.map((key) => witness({ key: 'seed' }, { key, checkedIn: 'written' }));
  const outputs = Object.fromEntries(keys.map((key, index) => [key, index]));
  const scope = scopeFor(
    { seed: 'fixture' },
    [servedWrite(0, [{ key: 'seed' }]), bundle(1, 'door', { ...outputs, evidence })],
    [],
  );
  const distinct = keys.map((_, element) => ({ runtimeStageId: 'door', commitIdx: 1, key: 'evidence', element }));
  const original = replay.sourceLinkReplay;
  let afterIndex = 0;
  const spy = vi.spyOn(replay, 'sourceLinkReplay').mockImplementation((...args) => {
    const indexed = original(...args);
    afterIndex = args[1].left;
    return indexed;
  });
  const workOf = (locators: readonly SourceLinkRowLocation[]) => {
    let visits = 0;
    const observed = new Proxy(locators, {
      getOwnPropertyDescriptor(target, key) {
        if (typeof key === 'string' && /^\d+$/.test(key)) visits++;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const result = cause.bindSourceLinkWrites(scope, observed);
    expect(result.complete).toBe(true);
    expect(result.writes.filter(Boolean)).toHaveLength(locators.length);
    expect(visits).toBe(locators.length);
    return afterIndex - spy.mock.calls.at(-1)![1].left;
  };
  try {
    const sizes = [16, 32, 64];
    const repeated = sizes.map((size) => workOf(Array.from({ length: size }, () => distinct[0])));
    const different = sizes.map((size) => workOf(distinct.slice(0, size)));
    expect(repeated).toEqual(sizes.map(() => repeated[0]));
    expect(different[0]).toBeGreaterThan(0);
    for (let i = 1; i < sizes.length; i++) {
      expect(different[i]).toBeGreaterThan(different[i - 1]);
      expect(different[i] / different[i - 1]).toBeLessThan(2.6);
    }
    expect(spy).toHaveBeenCalledTimes(2 * sizes.length);
    expect(spy.mock.calls.every(([, budget]) => budget.left > 0 && budget.left < readerLimits.binderWork.maximum)).toBe(
      true,
    );
  } finally {
    spy.mockRestore();
  }
});
