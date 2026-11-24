import { expect, it } from 'vitest';
import { loopFixtures, loopRecord } from '../../../../test/helpers/loopEvidenceFixture.js';
import { couldHaveChanged, savedChartDigest } from '../../../cause.js';
import { readRunEvidence, readStoredRecord } from '../../../index.js';

const graph = {
  stages: [
    { id: 'work', stageId: 'work', role: 'stage', edges: ['more'], writes: ['history'] },
    { id: 'more', stageId: 'more', role: 'stage', edges: ['again', 'leave', 'after'], writes: [] },
    { id: 'again', stageId: 'again', role: 'stage', edges: ['hop'], writes: ['left'] },
    { id: 'hop', stageId: 'hop', role: 'loop-reference', edges: ['work'] },
    { id: 'leave', stageId: 'leave', role: 'stage', edges: ['after'], writes: [] },
    { id: 'after', stageId: 'after', role: 'stage', edges: [], writes: [] },
  ],
  controls: [
    {
      placementId: 'more',
      kind: 'decider',
      continuation: 'after',
      choices: [
        { entry: 'again', name: 'Again', loopBack: { body: 'work', owner: 'more', exit: 'leave' } },
        { entry: 'leave', name: 'Leave' },
      ],
    },
  ],
};

it.each(['full', 'delta'] as const)(
  'signals an unexplained re-entry in the skipped writer window (%s)',
  async (mode) => {
    const fixture = loopFixtures.find(({ name, commitValues }) => name === '1 back-edges' && commitValues === mode)!;
    const digest = await savedChartDigest(graph);
    const address = { logRunId: 'r', drillPath: [] };
    const capture = { recordingVersion: 'fixture/one-back-edge', runId: 'r', address, from: 0, to: 8 };

    async function read(loops: Readonly<Record<string, string>>) {
      const recording = readStoredRecord(loopRecord(fixture, 2, loops));
      const control = readRunEvidence(recording, 'r').control('after#7');
      const skipped = await couldHaveChanged(recording, 'left', 7, {
        address,
        chart: graph,
        authority: {
          lookup: (candidate) =>
            candidate === recording
              ? { capture, binding: { ...capture, version: 'footprint.skipped-chart.v1', digest } }
              : undefined,
        },
      });
      return { control, skipped };
    }
    const intact = await read(fixture.loops);
    const omitted = await read({});
    expect(intact.control.status).toBe('collected');
    expect(intact.skipped.gaps).toEqual([]);
    const laterExit = [
      { decision: { id: 'more#5' }, skippedEntry: 'again', writers: [{ placementId: 'again', basis: 'declared' }] },
    ];
    expect(intact.skipped.candidates).toMatchObject(laterExit);
    expect(omitted.control).toMatchObject({ status: 'partial', gaps: ['conservative'] });
    expect(omitted.skipped.gaps).toContain('conservative');
    expect(omitted.skipped.candidates).toMatchObject(laterExit);
  },
);
