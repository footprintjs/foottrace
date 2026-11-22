import { expect, it } from 'vitest';
import { recordRun } from '../../../../test/helpers/recordRun.js';
import { createRecordGraph, type RecordScope } from '../../../cause.js';
import type { RecordSubflowMount } from './types.js';

it('crosses early, middle and late output handoffs in a 200-mount record at the default field limit', async () => {
  const parent = { logRunId: 'run', drillPath: [] as string[] };
  const run = recordRun({}, { commitValues: 'full', writeProvenance: 'reads-prefix' });
  run.step('origin', (scope) => scope.set('input', 1));
  const children: RecordScope[] = [];
  const mounts: RecordSubflowMount[] = [];
  for (let mountIndex = 0; mountIndex < 200; mountIndex++) {
    for (let padding = 0; padding < 4; padding++) {
      run.step('pad', (scope) => scope.set('p', [padding]));
    }
    const key = `out${mountIndex}`;
    const { runtimeStageId, idx } = run.step(`m${mountIndex}`, (scope) => scope.set(key, [scope.read('input')]));
    if (idx === undefined) throw new Error('The recorder did not give the parent commit an index.');
    const child = { logRunId: parent.logRunId, drillPath: [runtimeStageId] };
    const childRun = recordRun();
    childRun.step('work', (scope) => scope.set('answer', [mountIndex]));
    children.push({
      ...childRun.snapshot(),
      address: child,
      complete: true,
      subflows: { version: 1, status: 'partial', mounts: [], collections: [] },
    });
    mounts.push({
      runtimeStageId,
      child,
      outputHandoff: {
        version: 1,
        attribution: 'observed-read-prefix',
        status: 'captured',
        limitations: [],
        parent: { address: parent, runtimeStageId, commitIdx: idx },
        child: { address: child, beforeCommitIdx: 1 },
        writes: [{ path: key, reads: ['answer'] }],
      },
    });
  }
  const snapshot = run.snapshot();
  expect(snapshot.commitLog).toHaveLength(1001);
  const parentScope: RecordScope = {
    ...snapshot,
    address: parent,
    complete: true,
    subflows: { version: 1, status: 'captured', mounts, collections: [] },
  };
  const graph = createRecordGraph([parentScope, ...children], { maxCommits: 1024, maxScopes: 256 });
  const context = { signal: new AbortController().signal };
  const expectedCrossings = [];
  for (const index of [0, 100, 199]) {
    const { child, runtimeStageId, outputHandoff } = mounts[index];
    const target = graph.nodeId(parent, {
      runtimeStageId,
      commitIdx: outputHandoff!.parent.commitIdx,
      key: `out${index}`,
    });
    const source = graph.nodeId(child, { runtimeStageId: 'work#0', commitIdx: 0, key: 'answer' });
    const result = await graph.parents(target, context);
    const gaps = await graph.gaps(target, context);
    expectedCrossings.push({
      crossed: result.edges.some((edge) => edge.nodeId === source),
      exhausted: gaps.some((gap) => gap.code === 'node-limit'),
    });
  }
  expect(expectedCrossings).toEqual(Array.from({ length: 3 }, () => ({ crossed: true, exhausted: false })));
});
