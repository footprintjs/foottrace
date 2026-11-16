import { describe, expect, it } from 'vitest';
import { createRecordScopeLoader } from '../recordLoading.js';
import { resolveRecordNode, nodeIdFor } from '../recordIdentity.js';
import { recordOptions } from '../recordScope.js';
import type { RecordScope } from '../recordTypes.js';
import type { CommitBundle } from '../../memory/types.js';
import { subflowParents } from './parents.js';

function commit(runtimeStageId: string, idx: number, paths: string[]): CommitBundle {
  return {
    runtimeStageId,
    idx,
    stageId: runtimeStageId,
    stage: runtimeStageId,
    trace: paths.map((path) => ({ path, verb: 'set', readKeys: [] })),
    overwrite: Object.fromEntries(paths.map((path) => [path, 'fixture'])),
    updates: {},
    redactedPaths: [],
  };
}
function scope(address: RecordScope['address'], commitLog: CommitBundle[]): RecordScope {
  return { address, commitLog, complete: true, reads: {}, controlDeps: {}, attention: {} };
}
async function fixture(
  options: {
    reads?: string[];
    omitted?: 'all' | 'selected';
    cutoff?: number;
    missingChild?: boolean;
    sourcePort?: 'absent' | 'refused';
  } = {},
) {
  const parent = { logRunId: 'output-work', drillPath: [] as string[] };
  const child = { logRunId: 'output-work', drillPath: ['mount#0'] };
  const childLog = [commit('child/work#1', 0, ['key'])];
  const writes =
    options.omitted === 'all'
      ? []
      : [
          { path: 'unused', reads: [] },
          ...(options.omitted === 'selected' ? [] : [{ path: 'final', reads: options.reads ?? ['key'] }]),
        ];
  const parentScope = Object.assign(scope(parent, [commit('mount#0', 0, ['unused', 'final'])]), {
    subflows: {
      version: 1 as const,
      status: 'captured' as const,
      collections: [],
      mounts: [
        {
          runtimeStageId: 'mount#0',
          child,
          outputHandoff: {
            version: 1 as const,
            attribution: 'observed-read-prefix' as const,
            parent: { address: parent, runtimeStageId: 'mount#0', commitIdx: 0 },
            child: { address: child, beforeCommitIdx: options.cutoff ?? 1 },
            writes,
            status: 'captured' as const,
            limitations: [],
          },
        },
      ],
    },
  });
  const childLoads: RecordScope['address'][] = [];
  const childScope = scope(child, childLog);
  if (options.sourcePort === 'refused') {
    Object.defineProperty(childScope, 'subflows', { value: { version: 99 } });
  } else if (options.sourcePort !== 'absent') {
    Object.assign(childScope, {
      subflows: { version: 1 as const, status: 'partial' as const, mounts: [], collections: [] },
    });
  }
  const loader = createRecordScopeLoader((address) => {
    if (!address.drillPath.length) return { scope: parentScope };
    childLoads.push(address);
    if (options.missingChild) throw Error('fixture unavailable');
    return { scope: childScope };
  }, recordOptions({}));
  const context = { signal: new AbortController().signal };
  const selected = await resolveRecordNode(
    nodeIdFor(parent, { runtimeStageId: 'mount#0', commitIdx: 0, key: 'final' }),
    context,
    loader,
  );
  if ('failure' in selected) throw Error('fixture target failed: ' + selected.failure);
  return {
    selected,
    context,
    loader,
    childLoads,
    writer: nodeIdFor(child, { runtimeStageId: 'child/work#1', commitIdx: 0, key: 'key' }),
  };
}

describe('subflow boundary source work', () => {
  it.each(['all', 'selected'] as const)(
    'keeps an omitted %s mapper write conservative and unknown',
    async (omitted) => {
      const { selected, context, loader, childLoads } = await fixture({ omitted });
      const result = await subflowParents(selected, context, loader, 1);
      expect(result.adjacency.edges).toEqual([]);
      expect(result.gaps.map((gap) => gap.code)).toEqual(expect.arrayContaining(['conservative', 'scope-boundary']));
      expect(result.adjacency.complete).toBe(false);
      expect(childLoads).toEqual([]);
    },
  );

  it('resolves one admitted reference with a one-token allowance and keeps the actual write ordinal', async () => {
    const { selected, context, loader, writer } = await fixture();
    const work = { left: 1 };
    const result = await subflowParents(selected, context, loader, 1, work);
    expect(result.adjacency.edges).toHaveLength(1);
    expect(result.adjacency.edges[0]).toMatchObject({ nodeId: writer, attribution: 'stage' });
    expect(result.adjacency.edges[0].evidence).toContain('write:1');
    expect(work.left).toBe(0);
  });

  it.each(['absent', 'refused'] as const)(
    'keeps an output source whose subflow port is %s behind a boundary',
    async (sourcePort) => {
      const { selected, context, loader } = await fixture({ sourcePort });
      const work = { left: 1 };
      const result = await subflowParents(selected, context, loader, 1, work);
      expect(result.adjacency.edges).toEqual([]);
      expect(result.gaps.map((gap) => gap.code)).toEqual(expect.arrayContaining(['conservative', 'scope-boundary']));
      if (sourcePort === 'refused') expect(result.gaps.some((gap) => gap.code === 'invalid-data')).toBe(true);
      expect(result.adjacency.complete).toBe(false);
      expect(work.left).toBe(0);
    },
  );

  it('refuses exhausted source work before loading the child payload', async () => {
    const { selected, context, loader, childLoads } = await fixture();
    const result = await subflowParents(selected, context, loader, 1, { left: 0 });
    expect(result.gaps.some((gap) => gap.code === 'edge-limit')).toBe(true);
    expect(childLoads).toEqual([]);
  });

  it('spends a no-writer reference before stopping without trying a later resolvable root', async () => {
    const { selected, context, loader } = await fixture({ reads: ['absent', 'key'] });
    const work = { left: 1 };
    const result = await subflowParents(selected, context, loader, 1, work);
    expect(result.adjacency.edges).toEqual([]);
    expect(result.gaps.map((gap) => gap.code)).toEqual(expect.arrayContaining(['untracked-input', 'edge-limit']));
    expect(work.left).toBe(0);
  });

  it('spends the failed reference while preserving the exact child load failure', async () => {
    const { selected, context, loader, childLoads } = await fixture({ missingChild: true });
    const work = { left: 1 };
    const result = await subflowParents(selected, context, loader, 1, work);
    expect(result.adjacency.edges).toEqual([]);
    expect(result.gaps.map((gap) => gap.code)).toEqual(expect.arrayContaining(['unavailable', 'scope-boundary']));
    expect(childLoads).toEqual([{ logRunId: 'output-work', drillPath: ['mount#0'] }]);
    expect(work.left).toBe(0);
  });

  it('does not treat an arbitrary shorter child extent as the closed output snapshot', async () => {
    const { selected, context, loader } = await fixture({ cutoff: 0 });
    const work = { left: 1 };
    const result = await subflowParents(selected, context, loader, 1, work);
    expect(result.adjacency.edges).toEqual([]);
    expect(result.gaps.map((gap) => gap.code)).toEqual(expect.arrayContaining(['invalid-data', 'scope-boundary']));
    expect(work.left).toBe(0);
  });
});
