import { describe, expect, it } from 'vitest';
import { queryWork } from '../../memory/keyPaths.js';
import type { CommitBundle } from '../../memory/types.js';
import { nodeIdFor } from '../recordIdentity.js';
import { beginQueryMemo, endQueryMemo } from '../queryMemo.js';
import type { PreparedRecordScope } from '../recordTypes.js';
import { spendSubflowWork, subflowSource } from './sources.js';

const context = () => ({ signal: new AbortController().signal });
function commit(runtimeStageId: string, idx: number, path: string): CommitBundle {
  return {
    runtimeStageId,
    idx,
    stageId: runtimeStageId,
    stage: runtimeStageId,
    trace: [{ path, verb: 'set', readKeys: [] }],
    overwrite: { [path]: 'fixture' },
    updates: {},
    redactedPaths: [],
  };
}
function prepared(log: CommitBundle[]): PreparedRecordScope {
  return {
    address: { logRunId: 'prefix-source', drillPath: [] },
    log,
    complete: true,
    reads: new Map(log.map((bundle) => [bundle.runtimeStageId, []])),
    control: new Map(),
    marks: new Map(),
  };
}

describe('bounded subflow source prefix', () => {
  it('anchors a literal dotted root before a later overwrite without choosing a nested sibling', () => {
    const scope = prepared([
      commit('literal#0', 0, 'a.b'),
      commit('nested#1', 1, 'a\u001fb'),
      commit('later#2', 2, 'a.b'),
    ]);
    const work = { left: 1 };
    const result = subflowSource(scope, 'a.b', 2, context(), work);
    expect(result.adjacency.edges.map((edge) => edge.nodeId)).toEqual([
      nodeIdFor(scope.address, { runtimeStageId: 'literal#0', commitIdx: 0, key: 'a.b' }),
    ]);
    expect(result.adjacency.edges[0].attribution).toBe('stage');
    expect(work.left).toBe(0);
  });

  it('charges invalid cutoffs and no-writer references before refusing the next attempt', () => {
    const scope = prepared([commit('writer#0', 0, 'key')]),
      work = { left: 2 };
    expect(subflowSource(scope, 'key', 2, context(), work).gaps.map((gap) => gap.code)).toEqual(['invalid-data']);
    expect(subflowSource(scope, 'absent', 1, context(), work).gaps.map((gap) => gap.code)).toEqual(['untracked-input']);
    expect(work.left).toBe(0);
    const before = queryWork.units;
    expect(subflowSource(scope, 'key', 1, context(), work).gaps.map((gap) => gap.code)).toEqual(['edge-limit']);
    expect(queryWork.units).toBe(before);
  });

  it('charges a cached reference but avoids repeating its canonical slice within one query', () => {
    const scope = prepared([commit('writer#0', 0, 'key')]),
      query = context(),
      work = { left: 2 };
    beginQueryMemo(query, 8);
    try {
      const first = subflowSource(scope, 'key', 1, query, work);
      const sliced = queryWork.units;
      const second = subflowSource(scope, 'key', 1, query, work);
      expect(second).toEqual(first);
      expect(queryWork.units).toBe(sliced);
      expect(work.left).toBe(0);
    } finally {
      endQueryMemo(query);
    }
  });

  it('does not share same-address answers between distinct admitted source objects', () => {
    const first = prepared([commit('one#0', 0, 'key')]),
      second = prepared([commit('two#0', 0, 'key')]);
    const query = context(),
      work = { left: 2 };
    beginQueryMemo(query, 8);
    try {
      const one = subflowSource(first, 'key', 1, query, work);
      const two = subflowSource(second, 'key', 1, query, work);
      expect(one.adjacency.edges[0].nodeId).not.toBe(two.adjacency.edges[0].nodeId);
      expect(two.adjacency.edges[0].nodeId).toBe(
        nodeIdFor(second.address, { runtimeStageId: 'two#0', commitIdx: 0, key: 'key' }),
      );
    } finally {
      endQueryMemo(query);
    }
  });

  it('keeps loader, incomplete capture and redaction gaps beside an admitted writer', () => {
    const bundle = commit('writer#0', 0, 'key');
    bundle.redactedPaths = ['key'];
    const scope = { ...prepared([bundle]), complete: false };
    const result = subflowSource(scope, 'key', 1, context(), { left: 1 }, ['unavailable']);
    expect(result.adjacency.edges).toHaveLength(1);
    expect(result.gaps.map((gap) => gap.code)).toEqual(
      expect.arrayContaining(['unavailable', 'not-collected', 'redacted']),
    );
    expect(result.adjacency.complete).toBe(false);
  });

  it('preserves the canonical partial-root basis instead of claiming a whole exact source', () => {
    const result = subflowSource(prepared([commit('nested#0', 0, 'box\u001fa')]), 'box', 1, context(), { left: 1 });
    expect(result.adjacency.edges).toHaveLength(1);
    expect(result.gaps.some((gap) => gap.code === 'conservative')).toBe(true);
  });

  it('does not turn initial state or a pre-first-commit cutoff into an empty complete source', () => {
    const scope = prepared([commit('writer#0', 0, 'key')]);
    const result = subflowSource(scope, 'key', 0, context(), { left: 1 });
    expect(result.adjacency.edges).toEqual([]);
    expect(result.adjacency.complete).toBe(false);
    expect(result.gaps.some((gap) => gap.code === 'untracked-input')).toBe(true);
  });

  it('retains cancellation and spends the attempted source without querying its payload', () => {
    const controller = new AbortController(),
      work = { left: 1 };
    controller.abort();
    const before = queryWork.units;
    const result = subflowSource(
      prepared([commit('writer#0', 0, 'key')]),
      'key',
      1,
      { signal: controller.signal },
      work,
    );
    expect(result.gaps.map((gap) => gap.code)).toEqual(['cancelled']);
    expect(work.left).toBe(0);
    expect(queryWork.units).toBe(before);
    expect(spendSubflowWork({ left: Number.NaN })).toBe(false);
    expect(spendSubflowWork({ left: -1 })).toBe(false);
  });
});
