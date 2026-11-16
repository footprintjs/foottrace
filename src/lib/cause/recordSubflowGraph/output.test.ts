import { describe, expect, it } from 'vitest';
import { createRecordGraph } from '../../../cause.js';
import type { RecordScope } from '../../../cause.js';
import type { CommitBundle } from '../../memory/types.js';

const parent = { logRunId: 'run-output', drillPath: [] as string[] };
const child = { logRunId: 'run-output', drillPath: ['mount#0'] };
const context = () => ({ signal: new AbortController().signal });
function commit(runtimeStageId: string, idx: number, path: string): CommitBundle {
  return {
    idx,
    runtimeStageId,
    stageId: runtimeStageId,
    stage: runtimeStageId,
    trace: [{ path, verb: 'set', readKeys: [] }],
    overwrite: { [path]: 'fixture' },
    updates: {},
    redactedPaths: [],
  };
}
function scope(address: RecordScope['address'], commitLog: CommitBundle[]): RecordScope {
  return { address, commitLog, complete: true, reads: {}, controlDeps: {}, attention: {} };
}
function recorded(output: boolean = true) {
  const childLog = [commit('mount/work#1', 0, 'a.b'), commit('mount/nested#2', 1, 'a\u001fb')];
  const parentLog = [commit('mount#0', 0, 'final'), commit('later#2', 1, 'final')];
  const outputHandoff = {
    version: 1 as const,
    attribution: 'observed-read-prefix' as const,
    parent: { address: parent, runtimeStageId: 'mount#0', commitIdx: 0 },
    child: { address: child, beforeCommitIdx: childLog.length },
    writes: [{ path: 'final', reads: ['a.b'] }],
    status: 'captured' as const,
    limitations: [],
  };
  const source = Object.assign(scope(parent, parentLog), {
    subflows: {
      version: 1 as const,
      status: 'captured' as const,
      mounts: [{ runtimeStageId: 'mount#0', child, ...(output ? { outputHandoff } : {}) }],
      collections: [],
    },
  });
  const graph = createRecordGraph([
    source,
    { ...scope(child, childLog), subflows: { version: 1, status: 'partial', mounts: [], collections: [] } },
  ]);
  const target = graph.nodeId(parent, { runtimeStageId: 'mount#0', commitIdx: 0, key: 'final' });
  const writer = graph.nodeId(child, { runtimeStageId: 'mount/work#1', commitIdx: 0, key: 'a.b' });
  return { graph, source, target, writer, outputHandoff };
}

describe('declared native output handoff', () => {
  it('connects the actual child writer without splitting a literal dotted root key', async () => {
    const { graph, target, writer } = recorded();
    const parents = await graph.parents(target, context());
    expect(parents.edges.some((edge) => edge.nodeId === writer && edge.attribution === 'stage')).toBe(true);
    expect(parents.complete).toBe(false);
    expect((await graph.gaps(target, context())).some((gap) => gap.code === 'conservative')).toBe(true);
  });

  it('exposes the inverse cross-scope impact edge', async () => {
    const { graph, target, writer } = recorded();
    expect((await graph.children(writer, context())).edges.some((edge) => edge.nodeId === target)).toBe(true);
  });

  it('keeps a known merge-back boundary visible when capture was not supplied', async () => {
    const { graph, target } = recorded(false);
    expect((await graph.gaps(target, context())).some((gap) => gap.code === 'scope-boundary')).toBe(true);
    expect((await graph.parents(target, context())).complete).toBe(false);
  });

  it('does not transfer the mount handoff to a later local overwrite', async () => {
    const { graph, writer } = recorded();
    const later = graph.nodeId(parent, { runtimeStageId: 'later#2', commitIdx: 1, key: 'final' });
    expect((await graph.parents(later, context())).edges.some((edge) => edge.nodeId === writer)).toBe(false);
  });
});
