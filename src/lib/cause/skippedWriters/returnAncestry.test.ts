import { expect, it } from 'vitest';

import { evidenceStore } from '../../../../test/helpers/evidenceFixture';
import { couldHaveChanged, savedChartDigest } from '../../../cause.js';
import { readRunEvidence } from '../../run-evidence/read.js';
import { readStoredRecord } from '../../time-travel/storedRecord.js';

const address = { logRunId: 'r', drillPath: [] };
const graph = {
  stages: [
    { id: 'body', stageId: 'body', role: 'stage', edges: ['choose'], writes: ['price'] },
    { id: 'choose', stageId: 'choose', role: 'stage', edges: ['exit', 'again'], writes: [] },
    { id: 'exit', stageId: 'exit', role: 'stage', edges: [], writes: [] },
    { id: 'again', stageId: 'again', role: 'stage', edges: ['return'], writes: ['price'] },
    { id: 'return', stageId: 'return', role: 'loop-reference', edges: [] },
  ],
  controls: [
    {
      placementId: 'choose',
      kind: 'decider',
      continuation: null,
      choices: [
        { entry: 'exit', name: 'Exit' },
        { entry: 'again', name: 'Again', loopBack: { body: 'body', exit: 'exit', owner: 'choose' } },
      ],
    },
  ],
};

it('does not report an executable return branch as skipped when its confirmed hop contradicts the choice', async () => {
  const writer = evidenceStore();
  writer.commit(['r'], 'body#0', {});
  writer.commit(['r'], 'choose#1', { parent: 'body#0' });
  writer.note(['r'], 'run.decision', { id: 'choose#1', by: 'plain', chosen: 'Exit' });
  writer.commit(['r'], 'again#2', { parent: 'choose#1' });
  writer.note(['r'], 'run.loop', { id: 'again#2', target: 'body' });
  writer.commit(['r'], 'body#3', { parent: 'again#2' });
  writer.commit(['r'], 'choose#4', { parent: 'body#3' });
  writer.close(['r']);
  const recording = readStoredRecord(writer.entries());
  expect(readRunEvidence(recording, 'r').control('body#3')).toMatchObject({
    status: 'collected',
    decider: 'choose#1',
  });
  const capture = { recordingVersion: 'test/executable-return', runId: 'r', address, from: 0, to: 5 };
  const binding = { ...capture, version: 'footprint.skipped-chart.v1' as const, digest: await savedChartDigest(graph) };
  const options = { address, chart: graph, authority: { lookup: () => ({ capture, binding }) } };
  const result = await couldHaveChanged(recording, 'price', 4, options);
  expect(result.candidates).toEqual([]);
  expect(result.gaps).toEqual(['loop-evidence']);

  const beforeHop = await couldHaveChanged(recording, 'price', 2, options);
  expect(beforeHop.candidates).toMatchObject([{ decision: { id: 'choose#1' }, skippedEntry: 'again' }]);
  expect(beforeHop.gaps).toEqual([]);

  const beforeTarget = await couldHaveChanged(recording, 'price', 3, options);
  expect(beforeTarget.candidates).toEqual([]);
  expect(beforeTarget.gaps).toEqual(expect.arrayContaining(['conservative', 'loop-evidence']));
});

it('keeps an uncertain return visible through a nested decision', async () => {
  const writer = evidenceStore();
  writer.commit(['r'], 'body#0', {});
  writer.commit(['r'], 'choose#1', { parent: 'body#0' });
  writer.note(['r'], 'run.decision', { id: 'choose#1', by: 'plain', chosen: 'Exit' });
  writer.commit(['r'], 'again#2', { parent: 'choose#1' });
  writer.note(['r'], 'run.decision', { id: 'again#2', by: 'plain', chosen: 'Hop' });
  writer.commit(['r'], 'hop#3', { parent: 'again#2' });
  writer.commit(['r'], 'body#4', { parent: 'hop#3' });
  writer.close(['r']);
  const recording = readStoredRecord(writer.entries());
  expect(readRunEvidence(recording, 'r').control('body#4').status).toBe('partial');

  const nested = {
    stages: [
      ...graph.stages.filter(({ id }) => id !== 'again'),
      { id: 'again', stageId: 'again', role: 'stage', edges: ['hop'], writes: ['price'] },
      { id: 'hop', stageId: 'hop', role: 'stage', edges: ['return'], writes: [] },
    ],
    controls: [
      ...graph.controls,
      { placementId: 'again', kind: 'decider', continuation: null, choices: [{ entry: 'hop', name: 'Hop' }] },
    ],
  };
  const capture = { recordingVersion: 'test/nested-return', runId: 'r', address, from: 0, to: 5 };
  const binding = {
    ...capture,
    version: 'footprint.skipped-chart.v1' as const,
    digest: await savedChartDigest(nested),
  };
  const result = await couldHaveChanged(recording, 'price', 5, {
    address,
    chart: nested,
    authority: { lookup: () => ({ capture, binding }) },
  });
  expect(result.candidates).toEqual([]);
  expect(result.gaps).toEqual(expect.arrayContaining(['conservative', 'loop-evidence']));
});

it.each([
  { boundary: 'a missing parent', parent: 'unrecorded#0' },
  { boundary: 'a parentless non-root source', parent: undefined },
])('withholds the earlier matching loop across $boundary', async ({ parent }) => {
  const writer = evidenceStore();
  writer.commit(['r'], 'body#0', {});
  writer.commit(['r'], 'choose#1', { parent: 'body#0' });
  writer.note(['r'], 'run.decision', { id: 'choose#1', by: 'plain', chosen: 'Exit' });
  writer.commit(['r'], 'again#2', parent === undefined ? {} : { parent });
  writer.note(['r'], 'run.loop', { id: 'again#2', target: 'body' });
  writer.commit(['r'], 'body#3', { parent: 'again#2' });
  writer.commit(['r'], 'choose#4', { parent: 'body#3' });
  writer.note(['r'], 'run.decision', { id: 'choose#4', by: 'plain', chosen: 'Exit' });
  writer.commit(['r'], 'exit#5', { parent: 'choose#4' });
  writer.close(['r']);

  const recording = readStoredRecord(writer.entries());
  expect(readRunEvidence(recording, 'r').control('again#2').status).toBe('partial');
  const capture = { recordingVersion: 'test/missing-ancestry', runId: 'r', address, from: 0, to: 6 };
  const binding = { ...capture, version: 'footprint.skipped-chart.v1' as const, digest: await savedChartDigest(graph) };
  const options = { address, chart: graph, authority: { lookup: () => ({ capture, binding }) } };
  const result = await couldHaveChanged(recording, 'price', 4, options);
  expect(result.candidates).toEqual([]);
  expect(result.gaps).toEqual(expect.arrayContaining(['conservative', 'loop-evidence']));

  const afterExit = await couldHaveChanged(recording, 'price', 6, options);
  expect(afterExit.candidates).toMatchObject([{ decision: { id: 'choose#4' }, skippedEntry: 'again' }]);
});
