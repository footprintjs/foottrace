import { expect, it, vi } from 'vitest';
import { createRecordGraph, recordScopesFromSnapshot } from '../../../cause.js';
import { findLastWriterWithBasis, isCommitBundle } from '../../../index.js';

const address = { logRunId: 'run', drillPath: [] };
const query = { signal: new AbortController().signal };
const wider = { maxFields: 250_000 };
const smaller = { maxFields: 100_000 };
const nodeLimit = { scopes: [], gaps: [{ code: 'node-limit' }] };

function recording(samples: number[]) {
  const bundle = {
    stageId: 'compute',
    runtimeStageId: 'compute#1',
    idx: 0,
    trace: [{ path: 'total', verb: 'set' }],
    overwrite: { total: 20, samples },
    updates: {},
    redactedPaths: [],
  };
  return { logAddress: address, executionTree: { runtimeStageId: 'compute#1' }, commitLog: [bundle] };
}

it.each([40_000, 52_000, 64_000])('preserves the entire %i-element operand and its unrelated writer', async (size) => {
  const samples = Array.from({ length: size }, (_, i) => i);
  const snapshot = recording(samples);
  const { scopes, gaps } = recordScopesFromSnapshot(snapshot, wider);
  expect(gaps).toEqual([]);
  const log = scopes[0].commitLog.filter(isCommitBundle);
  expect(log[0].overwrite.samples).toEqual(samples);
  expect(log[0].overwrite.samples).not.toBe(samples);
  expect(findLastWriterWithBasis(log, 'total', log.length)?.writer?.runtimeStageId).toBe('compute#1');
  await expect(createRecordGraph(scopes, wider).openScope(address, query)).resolves.toHaveLength(1);
  const ordinary = recordScopesFromSnapshot(snapshot);
  expect(ordinary.scopes.length).toBe(size === 40_000 ? 1 : 0);
  if (size > 40_000) {
    expect(recordScopesFromSnapshot(snapshot, smaller)).toEqual(nodeLimit);
    await expect(createRecordGraph(scopes, smaller).openScope(address, query)).rejects.toMatchObject({
      code: 'node-limit',
    });
  }
});

it('admits sparse capacity and populated elements independently at each reader', async () => {
  const sparse = new Array<number>(64_000);
  sparse[42] = 9;
  const { scopes } = recordScopesFromSnapshot(recording(sparse), smaller);
  const saved = scopes[0].commitLog.filter(isCommitBundle)[0].overwrite.samples as number[];
  expect(saved.length).toBe(sparse.length);
  expect(Object.keys(saved)).toEqual(['42']);
  await expect(createRecordGraph(scopes, smaller).openScope(address, query)).resolves.toHaveLength(1);
  saved.fill(42);
  await expect(createRecordGraph(scopes, smaller).openScope(address, query)).rejects.toMatchObject({
    code: 'node-limit',
  });
  const standalone = { address, commitLog: recording(saved).commitLog };
  await expect(createRecordGraph([standalone], smaller).openScope(address, query)).rejects.toMatchObject({
    code: 'node-limit',
  });
  expect(recordScopesFromSnapshot(recording(new Array(120_000)), smaller)).toEqual(nodeLimit);
});

it('shares the operand allowance across scopes and keeps other commit data on the discovery budget', () => {
  const root = recording(Array(40_000).fill(1));
  const nested = {
    ...root,
    executionTree: { ...root.executionTree, children: [{ runtimeStageId: 'branch#1', subflowId: 'child' }] },
    subflowResults: {
      'branch#1': {
        treeContext: {
          logAddress: { ...address, drillPath: ['branch#1'] },
          history: recording(Array(40_000).fill(2)).commitLog,
          stageContexts: root.executionTree,
        },
      },
    },
  };
  expect(recordScopesFromSnapshot(nested, wider).scopes).toHaveLength(2);
  expect(recordScopesFromSnapshot(nested, smaller)).toEqual(nodeLimit);
  const oversizedMetadata = { ...root, commitLog: [{ ...root.commitLog[0], metadata: Array(52_000).fill(1) }] };
  expect(recordScopesFromSnapshot(oversizedMetadata, wider)).toEqual(nodeLimit);
});

it('enforces the graph configuration bounds and reads maxFields as data', () => {
  const input = recording([]);
  const getter = vi.fn(() => 250_000);
  for (const options of [
    { maxFields: 0 },
    { maxFields: 1_000_001 },
    { maxFields: 1.5 },
    Object.defineProperty({}, 'maxFields', { get: getter }),
  ]) {
    expect(() => recordScopesFromSnapshot(input, options)).toThrow(TypeError);
    expect(() => createRecordGraph([], options)).toThrow(TypeError);
  }
  expect(getter).not.toHaveBeenCalled();
});
