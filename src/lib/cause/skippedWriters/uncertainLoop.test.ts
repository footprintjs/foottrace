import { expect, it } from 'vitest';

import { evidenceStore } from '../../../../test/helpers/evidenceFixture';
import { couldHaveChanged, savedChartDigest } from '../../../cause.js';
import { readRunEvidence } from '../../run-evidence/read.js';
import { readStoredRecord } from '../../time-travel/storedRecord.js';

const address = { logRunId: 'r', drillPath: [] };
const graph = {
  stages: [
    { id: 'body', stageId: 'body', role: 'stage', edges: ['choose'], writes: ['price'] },
    { id: 'choose', stageId: 'choose', role: 'stage', edges: ['exit', 'repeat'], writes: [] },
    { id: 'exit', stageId: 'exit', role: 'stage', edges: [], writes: [] },
    { id: 'repeat', stageId: 'repeat', role: 'loop-reference', edges: [] },
  ],
  controls: [
    {
      placementId: 'choose',
      kind: 'decider',
      continuation: null,
      choices: [
        { entry: 'exit', name: 'Exit' },
        { entry: 'repeat', name: 'Repeat', loopBack: { body: 'body', exit: 'exit', owner: 'choose' } },
      ],
    },
  ],
};

async function readLoop(path: 'exit' | 'missing-hop' | 'recorded-hop') {
  const writer = evidenceStore();
  writer.commit(['r'], 'body#0', {});
  writer.commit(['r'], 'choose#1', { parent: 'body#0' });
  writer.note(['r'], 'run.decision', { id: 'choose#1', by: 'plain', chosen: 'Exit' });
  if (path === 'exit') {
    writer.commit(['r'], 'exit#2', { parent: 'choose#1' });
  } else {
    if (path === 'recorded-hop') writer.note(['r'], 'run.loop', { id: 'choose#1', target: 'body' });
    writer.commit(['r'], 'body#2', { parent: 'choose#1' });
    writer.commit(['r'], 'choose#3', { parent: 'body#2' });
  }
  writer.close(['r']);
  const recording = readStoredRecord(writer.entries());
  const capture = { recordingVersion: 'test/loop', runId: 'r', address, from: 0, to: path === 'exit' ? 3 : 4 };
  const binding = { ...capture, version: 'footprint.skipped-chart.v1' as const, digest: await savedChartDigest(graph) };
  const options = {
    address,
    chart: graph,
    authority: { lookup: () => ({ capture, binding }) },
  };
  const control = readRunEvidence(recording, 'r').control('body#2');
  return { control, result: await couldHaveChanged(recording, 'price', 3, options) };
}

it('an unexplained re-entry from the same decision cannot prove that its loop body was skipped', async () => {
  const { control, result } = await readLoop('missing-hop');
  expect(control.status).toBe('partial');
  expect(result.candidates).toEqual([]);
  expect(result.gaps).toContain('loop-evidence');
});

it('can credit the loop body as skipped when the native run exits', async () => {
  const { result } = await readLoop('exit');
  expect(result.candidates).toMatchObject([{ skippedEntry: 'repeat', writers: [{ placementId: 'body' }] }]);
  expect(result.gaps).toEqual([]);
});

it('refuses skipped-loop attribution when the same re-entry carries its native hop note', async () => {
  const { result } = await readLoop('recorded-hop');
  expect(result.candidates).toEqual([]);
  expect(result.gaps).toContain('loop-evidence');
});
