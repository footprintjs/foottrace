import { describe, expect, it } from 'vitest';

import { evidenceStore } from '../../../../test/helpers/evidenceFixture';
import { readStoredRecord } from '../../time-travel/storedRecord.js';
import { analyzeBoundSkippedPaths, type AdmittedSkippedChart } from './analyze.js';
import type { NormalizedSkippedStage } from './types.js';

const address = ['r'];
const stage = (id: string, edges: readonly string[] = [], writes: readonly string[] = []): NormalizedSkippedStage => ({
  id,
  stageId: id,
  role: 'stage',
  edges,
  writes,
});

describe('skipped writers from admitted chart and positioned decisions', () => {
  it('combines native decision evidence with the skipped declaration and separate binding basis', () => {
    const store = evidenceStore();
    store.commit(address, 'choose#0', {});
    store.note(address, 'run.decision', { id: 'choose#0', by: 'plain', chosen: 'Keep' });
    store.commit(address, 'keep#1', { parent: 'choose#0' });
    store.close(address);
    const log = readStoredRecord(store.entries()).root('r');
    if (!log) throw new Error('Missing admitted fixture log');
    const chart: AdmittedSkippedChart = {
      binding: 'host-attested',
      stages: new Map([
        ['choose', stage('choose', ['keep', 'skip'])],
        ['keep', stage('keep')],
        ['skip', stage('skip', ['shared'], ['price'])],
        ['shared', stage('shared', [], ['price'])],
      ]),
      controlsByStage: new Map([
        [
          'choose',
          [
            {
              placementId: 'choose',
              kind: 'decider',
              continuation: 'shared',
              choices: [
                { entry: 'keep', name: 'Keep' },
                { entry: 'skip', name: 'Skip' },
              ],
            },
          ],
        ],
      ]),
    };
    const result = analyzeBoundSkippedPaths(log, chart, 'price', 2, { left: 10000 });
    expect(result.gaps).toEqual([]);
    expect(result.candidates).toMatchObject([
      {
        decision: { id: 'choose#0', chosen: 'Keep' },
        skippedEntry: 'skip',
        writers: [{ stageId: 'skip', basis: 'declared' }],
        binding: 'host-attested',
      },
    ]);
  });
});
