import { describe, expect, it } from 'vitest';

import { causalChain, keysReadFromExecutionTree, type CommitBundle } from '../../../src/index.js';

function write(runtimeStageId: string, path: string, value: number): CommitBundle {
  return {
    stage: runtimeStageId,
    stageId: runtimeStageId,
    runtimeStageId,
    trace: [{ path, verb: 'set' }],
    overwrite: { [path]: value },
    updates: {},
    redactedPaths: [],
  };
}

const commitLog = [write('a#0', 'x', 1), write('b#1', 'bridge', 1), write('c#2', 'y', 2)];
const live = [
  { runtimeStageId: 'a#0' },
  {
    runtimeStageId: 'b#1',
    stageReads: { x: 1, y: undefined, never: undefined },
    undefinedReadKeys: ['y', 'never'],
  },
  { runtimeStageId: 'c#2', stageReads: { bridge: 1 } },
];
const saved: unknown = JSON.parse(JSON.stringify(live));

describe('unset reads in live and saved execution trees', () => {
  it.each([
    ['live', live],
    ['saved', saved],
  ] as const)('preserves the engine read names in a %s tree', (_, tree) => {
    const read = keysReadFromExecutionTree(tree);
    expect(read.lookup('b#1')).toEqual(['never', 'x', 'y']);
    expect(read.lookup('c#2')).toEqual(['bridge']);
  });

  it('counts a stage whose only read survived in the sidecar', () => {
    const tree = { runtimeStageId: 'b#1', undefinedReadKeys: ['never'] };
    const read = keysReadFromExecutionTree(tree);
    expect(read.lookup('b#1')).toEqual(['never']);
    expect(read.coverage).toEqual({ steps: 1, stepsWithReads: 1 });
  });

  it('leaves legacy lookup order and recording bytes unchanged', () => {
    const tree = { runtimeStageId: 'b#1', stageReads: { z: 1, a: 2 } };
    const bytes = JSON.stringify(tree);
    expect(keysReadFromExecutionTree(tree).lookup('b#1')).toEqual(['z', 'a']);
    expect(JSON.stringify(tree)).toBe(bytes);
  });

  it.each([[null], ['fake'], [{ 0: 'fake', length: 1 }], [[null, 7, {}, ['fake']]]])(
    'ignores malformed sidecar evidence %j',
    (undefinedReadKeys) => {
      const tree = { runtimeStageId: 'b#1', stageReads: { z: 1, a: 2 }, undefinedReadKeys };
      expect(keysReadFromExecutionTree(tree).lookup('b#1')).toEqual(['z', 'a']);
    },
  );

  it('keeps distinct own string entries and skips holes, inherited entries and accessors', () => {
    const sidecar = ['missing', , , 'missing', 7, 'x'];
    Object.assign(sidecar, { '01': 'named', '4294967295': 'out of bounds' });
    Object.setPrototypeOf(sidecar, Object.assign(Object.create(Array.prototype), { 1: 'inherited' }));
    Object.defineProperty(sidecar, 2, {
      get() {
        throw new Error('read-key accessor');
      },
    });
    const stageReads = {
      x: 1,
      get fabricated() {
        throw new Error('read-value accessor');
      },
    };
    const tree = { runtimeStageId: 'b#1', stageReads, undefinedReadKeys: sidecar };
    expect(keysReadFromExecutionTree(tree).lookup('b#1')).toEqual(['missing', 'x']);
    expect(
      keysReadFromExecutionTree({
        runtimeStageId: 'b#1',
        stageReads: { x: 1 },
        get undefinedReadKeys() {
          throw new Error('sidecar accessor');
        },
      }).lookup('b#1'),
    ).toEqual(['x']);
    const inheritedSidecar = Object.assign(Object.create({ undefinedReadKeys: ['inherited'] }), {
      runtimeStageId: 'b#1',
    });
    expect(keysReadFromExecutionTree(inheritedSidecar).lookup('b#1')).toEqual([]);
  });

  it('keeps the read map when the optional sidecar cannot be inspected', () => {
    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    const throwing = new Proxy(['first', 'second'], {
      getOwnPropertyDescriptor(target, key) {
        if (key === '1') throw new Error('sidecar slot could not be inspected');
        return Object.getOwnPropertyDescriptor(target, key);
      },
    });
    for (const undefinedReadKeys of [revoked.proxy, throwing]) {
      const tree = { runtimeStageId: 'b#1', stageReads: { z: 1, a: 2 }, undefinedReadKeys };
      expect(keysReadFromExecutionTree(tree).lookup('b#1')).toEqual(['z', 'a']);
    }
  });

  it('does not use inherited or accessor fields and slots to traverse the tree', () => {
    const child = { runtimeStageId: 'kept#0', stageReads: { input: 1 } };
    const root = Object.assign(Object.create({ stageReads: { inherited: 1 } }), {
      runtimeStageId: 'root#0',
      get next() {
        return undefined;
      },
    });
    Object.defineProperty(root, 'next', {
      get() {
        throw new Error('next accessor');
      },
    });
    const list = [root, child];
    Object.defineProperty(list, 0, {
      get() {
        throw new Error('tree slot accessor');
      },
    });
    for (const tree of [list, { branches: [list] }, { children: list }]) {
      const read = keysReadFromExecutionTree(tree);
      expect(read.lookup('kept#0')).toEqual(['input']);
      expect(read.coverage).toEqual({ steps: 1, stepsWithReads: 1 });
    }
    expect(keysReadFromExecutionTree(root).lookup('root#0')).toEqual([]);
  });

  it('walks across the same B reads after the recording has been saved', () => {
    const walk = (tree: unknown) => causalChain(commitLog, 'c#2', keysReadFromExecutionTree(tree).lookup);
    const savedWalk = walk(saved);
    expect(savedWalk?.parents[0]).toMatchObject({
      runtimeStageId: 'b#1',
      preRunReads: { code: 'pre-run-origin', keys: ['never', 'y'] },
      parents: [expect.objectContaining({ runtimeStageId: 'a#0' })],
    });
    expect(savedWalk).toEqual(walk(live));
  });
});
