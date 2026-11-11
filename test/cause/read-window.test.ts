/**
 * The cause graph and the read window.
 *
 * The cause door rebuilds every bundle from the fields it admits, and it projected each causal edge
 * onto "the last writer before the step's commit". Both would undo the read window: the stamps were
 * dropped at admission, and a step that read `x` early was handed the sibling that committed first.
 * The door now keeps the stamps (refusing ones that cannot be stamps) and asks the one rule
 * (`memory/readWindow.ts`) which commits an edge points at.
 *
 * Test types: scenario (parents, children and gaps through both adapters), boundary (stamps that
 * cannot be stamps, a log numbered by position), regression (a record without stamps answers as before).
 */
import { describe, expect, it } from 'vitest';

import { createRecordGraph } from '../../src/lib/cause/recordAdapter.js';
import { createStoredRecordGraph } from '../../src/lib/cause/storedRecordAdapter.js';
import type { CommitBundle } from '../../src/lib/memory/types.js';

const address = { logRunId: 'run', drillPath: [] };
const ctx = () => ({ signal: new AbortController().signal });
function commit(id: string, idx: number, writes: Record<string, string[]>, extra: object = {}): CommitBundle {
  return {
    idx,
    stage: id,
    stageId: id,
    runtimeStageId: `${id}#${idx}`,
    trace: Object.entries(writes).map(([path, readKeys]) => ({ path, verb: 'set' as const, readKeys })),
    redactedPaths: [],
    overwrite: Object.fromEntries(Object.keys(writes).map((key) => [key, idx])),
    updates: {},
    ...extra,
  };
}
/**
 * `seed` writes x; `fast` replaces x; `slow`, which began before `fast` committed, reads x and writes
 * `copy`. `stamps` is what `slow`'s bundle says about when it looked at state.
 */
const run = (stamps: object) => [
  commit('seed', 0, { x: [] }),
  commit('fast', 1, { x: [] }),
  commit('slow', 2, { copy: ['x'] }, stamps),
];
const reads = { 'seed#0': [], 'fast#1': [], 'slow#2': ['x'] };
const scope = (commitLog: unknown[]) => ({ address, commitLog, reads, attention: {}, controlDeps: {}, complete: true });
const stored = (commitLog: unknown[]) => ({
  entries: [
    { kind: 'opened', address, at: 0, initialState: {} },
    ...commitLog.map((bundle) => ({ kind: 'commit', address, at: 0, bundle })),
    { kind: 'closed', address, at: 0, outcome: 'ok', commits: commitLog.length },
  ],
  reads,
  attention: {},
  controlDeps: {},
});

const ADAPTERS = {
  'a record in memory': (commitLog: unknown[]) => createRecordGraph([scope(commitLog) as never]),
  'a stored record': (commitLog: unknown[]) => createStoredRecordGraph({ loadLog: async () => stored(commitLog) }),
};

describe.each(Object.entries(ADAPTERS))('the cause graph over %s', (_name, graphOf) => {
  const ask = async (commitLog: unknown[]) => {
    const g = graphOf(commitLog);
    const node = (stage: string, idx: number, key: string) =>
      g.nodeId(address, { runtimeStageId: `${stage}#${idx}`, commitIdx: idx, key });
    const copy = node('slow', 2, 'copy');
    const short = (id: string) => (id === node('seed', 0, 'x') ? 'seed' : id === node('fast', 1, 'x') ? 'fast' : id);
    return {
      parents: (await g.parents(copy, ctx())).edges.map((edge) => short(edge.nodeId)),
      gaps: (await g.gaps(copy, ctx())).map((gap) => gap.code),
      readersOf: async (stage: 'seed' | 'fast') =>
        (await g.children(node(stage, stage === 'seed' ? 0 : 1, 'x'), ctx())).edges.map((edge) =>
          edge.nodeId === copy ? 'slow' : edge.nodeId,
        ),
    };
  };

  it('a step that only read what it saw when it began has the earlier writer as its one parent', async () => {
    const answer = await ask(run({ beganAt: 1 }));
    expect(answer.parents).toEqual(['seed']);
    expect(answer.gaps).toEqual([]);
    expect(await answer.readersOf('seed')).toEqual(['slow']);
    expect(await answer.readersOf('fast')).toEqual([]);
  });

  it('a step that looked again has both writers as parents, and says the set is a superset', async () => {
    const answer = await ask(run({ beganAt: 1, sawUntil: 2 }));
    expect(answer.parents).toEqual(['seed', 'fast']);
    expect(answer.gaps).toEqual(['conservative']);
    expect(await answer.readersOf('seed')).toEqual(['slow']);
    expect(await answer.readersOf('fast')).toEqual(['slow']);
  });

  it('a record without stamps answers as it always did: the last writer before the commit', async () => {
    const answer = await ask(run({}));
    expect(answer.parents).toEqual(['fast']);
    expect(answer.gaps).toEqual([]);
    expect(await answer.readersOf('seed')).toEqual([]);
    expect(await answer.readersOf('fast')).toEqual(['slow']);
  });

  it.each([
    ['beganAt at the step', { beganAt: 2 }],
    ['beganAt after the step', { beganAt: 5 }],
    ['beganAt negative', { beganAt: -1 }],
    ['beganAt a fraction', { beganAt: 0.5 }],
    ['beganAt a string', { beganAt: '1' }],
    ['sawUntil without beganAt', { sawUntil: 2 }],
    ['sawUntil not after beganAt', { beganAt: 1, sawUntil: 1 }],
    ['sawUntil past the step', { beganAt: 1, sawUntil: 3 }],
  ])('%s refuses the record: a stamp is never dropped', async (_name, stamps) => {
    expect((await ask(run(stamps))).gaps).toEqual(['invalid-data']);
  });
});

describe('two writers inside one window', () => {
  it.each(Object.entries(ADAPTERS))("%s: each edge points at its own writer's commit, once", async (_name, graphOf) => {
    // seed, one and two each write x; slow began before one committed and looked again after two did.
    const commitLog = [
      commit('seed', 0, { x: [] }),
      commit('one', 1, { x: [] }),
      commit('two', 2, { x: [] }),
      commit('slow', 3, { copy: ['x'] }, { beganAt: 1, sawUntil: 3 }),
    ];
    const g = graphOf(commitLog);
    const node = (stage: string, idx: number, key: string) =>
      g.nodeId(address, { runtimeStageId: `${stage}#${idx}`, commitIdx: idx, key });
    const parents = (await g.parents(node('slow', 3, 'copy'), ctx())).edges.map((edge) => edge.nodeId);
    expect(parents).toEqual([node('seed', 0, 'x'), node('one', 1, 'x'), node('two', 2, 'x')]);
  });
});

describe('one odd idx on a neighbour cannot put a wrong writer forward as the certain one', () => {
  // Found by the second reader. seed writes x, fast replaces it, slow began before fast committed. The
  // right answer is seed. Each case damages the idx of one bundle; before the doors made the copies'
  // indices rise, every one of them answered "fast", as a certain parent with no gap.
  const withIdx = (bundle: CommitBundle, idx: unknown): CommitBundle => ({ ...bundle, idx: idx as number });
  const ask = async (commitLog: unknown[]) => {
    const g = createRecordGraph([scope(commitLog) as never]);
    const node = (stage: string, at: number, key: string) =>
      g.nodeId(address, { runtimeStageId: `${stage}#${at}`, commitIdx: at, key });
    const copy = node('slow', 2, 'copy');
    return {
      parents: (await g.parents(copy, ctx())).edges.map((edge) =>
        edge.nodeId === node('seed', 0, 'x') ? 'seed' : edge.nodeId,
      ),
      gaps: (await g.gaps(copy, ctx())).map((gap) => gap.code),
    };
  };
  const [seed, fast, slow] = run({ beganAt: 1 });

  it.each([
    ['a neighbour that says an index further on than the step', [seed, withIdx(fast, 7), slow]],
    ["a neighbour that repeats the step's index", [seed, withIdx(fast, 2), slow]],
  ])("%s: the step's stamp counts against nothing, so the record is refused", async (_name, commitLog) => {
    expect((await ask(commitLog)).gaps).toEqual(['invalid-data']);
  });

  const sliced = (middle: unknown) => [withIdx(seed, 10), { ...fast, idx: middle }, { ...slow, idx: 12, beganAt: 11 }];
  it.each([
    [
      'a slice whose middle bundle says no index',
      (() => {
        const { idx: _idx, ...noIdx } = fast;
        return [withIdx(seed, 10), noIdx, { ...slow, idx: 12, beganAt: 11 }];
      })(),
    ],
    ['a slice whose middle bundle says an index that is not a number', sliced('x')],
    ['a neighbour that repeats an earlier index', [seed, withIdx(fast, 0), slow]],
  ])('%s: it keeps its place in the order, and the parent is the real one', async (_name, commitLog) => {
    expect(await ask(commitLog)).toEqual({ parents: ['seed'], gaps: [] });
  });
});

describe('a record in memory handed over as part of a log', () => {
  it('without the continuation bundles that sat in the window, the parent is the same', async () => {
    // seed 0, fast 1, fast (exit) 2, fast (repeat) 3, slow 4 began at 1. Rows 2 and 3 are not handed over.
    const commitLog = [
      commit('seed', 0, { x: [] }),
      commit('fast', 1, { x: [] }),
      { ...commit('slow', 2, { copy: ['x'] }, { beganAt: 1 }), idx: 4 },
    ];
    const g = createRecordGraph([scope(commitLog) as never]);
    const node = (stage: string, idx: number, key: string) =>
      g.nodeId(address, { runtimeStageId: `${stage}#${idx}`, commitIdx: idx, key });
    const parents = (await g.parents(node('slow', 2, 'copy'), ctx())).edges.map((edge) => edge.nodeId);
    expect(parents).toEqual([node('seed', 0, 'x')]);
  });
});

describe('a record in memory whose bundles are numbered by position', () => {
  it('keeps each stamp at its distance from the bundle', async () => {
    // The same three commits, as rows 7 to 9 of a longer log: handed over as a slice, re-numbered 0 to 2.
    const sliced = run({ beganAt: 8 }).map((bundle, at) => ({ ...bundle, idx: 7 + at }));
    const g = createRecordGraph([scope(sliced) as never]);
    const node = (stage: string, idx: number, key: string) =>
      g.nodeId(address, { runtimeStageId: `${stage}#${idx}`, commitIdx: idx, key });
    const parents = (await g.parents(node('slow', 2, 'copy'), ctx())).edges.map((edge) => edge.nodeId);
    expect(parents).toEqual([node('seed', 0, 'x')]);
  });
});
