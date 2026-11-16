import { describe, expect, it } from 'vitest';
import { createRecordGraph, explain } from '../../../cause.js';
import type { RecordScope } from '../../../cause.js';
import type { CommitBundle } from '../../memory/types.js';

const parent = { logRunId: 'run-a', drillPath: [] as string[] };
const child = { logRunId: 'run-a', drillPath: ['mount#0'] };
function commit(runtimeStageId: string, idx: number, path: string, readKeys: string[]): CommitBundle {
  return {
    idx,
    runtimeStageId,
    stageId: runtimeStageId,
    stage: runtimeStageId,
    trace: [{ path, verb: 'set', readKeys }],
    overwrite: { [path]: 'fixture' },
    updates: {},
    redactedPaths: [],
  };
}
function scope(address: RecordScope['address'], commitLog: CommitBundle[]): RecordScope {
  return {
    address,
    commitLog,
    complete: true,
    reads: Object.fromEntries(
      commitLog.map((entry) => [entry.runtimeStageId, entry.trace.flatMap((row) => row.readKeys ?? [])]),
    ),
    controlDeps: {},
    attention: {},
  };
}

describe('known native subflow seed provenance', () => {
  it('withholds an upstream root when the recorded child seed has no admitted input handoff', async () => {
    const recorded = scope(child, [commit('mount#0', 0, 'input', []), commit('child/work#1', 1, 'out', ['input'])]);
    const graph = createRecordGraph([
      {
        ...recorded,
        attention: {
          'mount#0': [{ kind: 'error', reason: 'ERROR_RECORDED', evidence: ['proof:seed'] }],
        },
      },
    ]);
    const selected = graph.nodeId(child, { runtimeStageId: 'child/work#1', commitIdx: 1, key: 'out' });
    const seed = graph.nodeId(child, { runtimeStageId: 'mount#0', commitIdx: 0, key: 'input' });
    const result = await explain(graph, selected, { includeBackward: true });
    expect(result.backward?.nodes).toContain(seed);
    expect(result.backward?.gaps.some((gap) => gap.code === 'scope-boundary')).toBe(true);
    expect(result.backward?.confidence).toBe('incomplete');
    expect(result.rootCause).toBeUndefined();
  });

  it('keeps an independent root-log constant complete', async () => {
    const graph = createRecordGraph([scope(parent, [commit('constant#0', 0, 'value', [])])]);
    const id = graph.nodeId(parent, { runtimeStageId: 'constant#0', commitIdx: 0, key: 'value' });
    expect((await explain(graph, id, { includeBackward: true })).backward?.confidence).toBe('complete');
  });

  it('keeps a constant created inside a child independent of its unused seed', async () => {
    const graph = createRecordGraph([
      scope(child, [commit('mount#0', 0, 'input', []), commit('constant#1', 1, 'value', [])]),
    ]);
    const id = graph.nodeId(child, { runtimeStageId: 'constant#1', commitIdx: 1, key: 'value' });
    expect((await explain(graph, id, { includeBackward: true })).backward?.confidence).toBe('complete');
  });
});
