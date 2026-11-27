import { describe, expect, it, vi } from 'vitest';

import { engineScenario, evidenceStore, writeScenario } from '../../../../test/helpers/evidenceFixture';
import { causalChainWithCouldHaveChanged, couldHaveChanged, savedChartDigest } from '../../../cause.js';
import { causalChain } from '../../memory/backtrack.js';
import type { LogAddress } from '../../memory/eventPosition.js';
import { readStoredRecord } from '../../time-travel/storedRecord.js';

const address = { logRunId: 'r', drillPath: [] };

function recording() {
  const store = evidenceStore();
  store.commit(['r'], 'seed#0', {}, { trace: [{ path: 'price', verb: 'set' }], overwrite: { price: 10 } });
  store.commit(['r'], 'choose#1', { parent: 'seed#0' });
  store.note(['r'], 'run.decision', { id: 'choose#1', by: 'plain', chosen: 'Keep' });
  store.commit(['r'], 'keep#2', { parent: 'choose#1' });
  store.close(['r']);
  return readStoredRecord(store.entries());
}

function chart(writes: readonly string[]) {
  return {
    stages: [
      { id: 'choose', stageId: 'choose', role: 'stage', edges: ['keep', 'skip'], writes: [] },
      { id: 'keep', stageId: 'keep', role: 'stage', edges: [], writes: [] },
      { id: 'skip', stageId: 'skip', role: 'stage', edges: [], writes },
    ],
    controls: [
      {
        placementId: 'choose',
        kind: 'decider',
        continuation: null,
        choices: [
          { entry: 'keep', name: 'Keep' },
          { entry: 'skip', name: 'Skip' },
        ],
      },
    ],
  };
}

async function catalog(
  stored: ReturnType<typeof recording>,
  graph: unknown,
  interval: { address: LogAddress; from: number; to: number } = { address, from: 0, to: 3 },
) {
  const capture = { recordingVersion: 'shelf/item/1', runId: interval.address.logRunId, ...interval };
  const binding = { ...capture, version: 'footprint.skipped-chart.v1' as const, digest: await savedChartDigest(graph) };
  return {
    address: interval.address,
    chart: graph,
    authority: {
      lookup: (candidate: typeof stored, scope: LogAddress) =>
        candidate === stored && scope.logRunId === interval.address.logRunId && !scope.drillPath.length
          ? { capture, binding }
          : undefined,
    },
  };
}

describe('saved could-have-changed reader', () => {
  it('reports the skipped writer only on its independently bound recording and chart', async () => {
    const stored = recording();
    const authored = chart(['price']);
    const options = await catalog(stored, authored);
    const result = await couldHaveChanged(stored, 'price', 2, options);
    expect(result).toMatchObject({
      candidates: [
        {
          decision: { id: 'choose#1', chosen: 'Keep' },
          skippedEntry: 'skip',
          writers: [{ stageId: 'skip', basis: 'declared' }],
          binding: 'host-attested',
        },
      ],
      gaps: [],
    });
    expect(await couldHaveChanged(stored, 'price', 2, { ...options, chart: chart([]) })).toEqual({
      candidates: [],
      gaps: ['chart-binding'],
    });
    expect(await couldHaveChanged(recording(), 'price', 2, options)).toEqual({
      candidates: [],
      gaps: ['chart-binding'],
    });
    expect(await couldHaveChanged(stored, 'price', 2)).toEqual({ candidates: [], gaps: ['chart-binding'] });
  });

  it('returns an uncollected gap for a saved interval that begins after a relevant decision', async () => {
    const stored = recording();
    const graph = chart(['price']);
    for (const from of [0, 1]) {
      expect(
        await couldHaveChanged(stored, 'price', 3, await catalog(stored, graph, { address, from, to: 3 })),
      ).toMatchObject({
        candidates: [{ skippedEntry: 'skip', binding: 'host-attested' }],
        gaps: [],
      });
    }
    expect(
      await couldHaveChanged(stored, 'price', 3, await catalog(stored, graph, { address, from: 2, to: 3 })),
    ).toEqual({
      candidates: [],
      gaps: ['not-collected'],
    });
  });

  it('reports the missing first-leg decision when a same-executor resume serves only its second leg', async () => {
    const scenario = engineScenario('resume-same');
    const [runId] = scenario.legs;
    const stored = readStoredRecord(writeScenario(scenario));
    const log = stored.root(runId)!;
    const paused = log.entries.find((entry) => entry.kind === 'closed' && entry.outcome === 'paused');
    if (paused?.kind !== 'closed') throw new Error('Missing pause in the engine fixture');
    const scope = { address: log.address, to: log.commitLog.length };
    const graph = {
      stages: [
        { id: 'gate', stageId: 'gate', role: 'stage', edges: ['go', 'skip'], writes: [] },
        { id: 'go', stageId: 'go', role: 'mount', edges: [] },
        { id: 'skip', stageId: 'skip', role: 'stage', edges: [], writes: ['v'] },
      ],
      controls: [
        {
          placementId: 'gate',
          kind: 'decider',
          continuation: null,
          choices: [
            { entry: 'go', name: 'Sub' },
            { entry: 'skip', name: 'Skip' },
          ],
        },
      ],
    };
    const whole = await couldHaveChanged(stored, 'v', scope.to, await catalog(stored, graph, { ...scope, from: 0 }));
    expect(whole.candidates).toMatchObject([{ decision: { id: 'gate#1' }, skippedEntry: 'skip' }]);
    const resumed = await catalog(stored, graph, { ...scope, from: paused.commits });
    expect(await couldHaveChanged(stored, 'v', scope.to, resumed)).toEqual({
      candidates: [],
      gaps: ['not-collected'],
    });
  });

  it('does not transfer an observed write between distinct placements sharing a static ID', async () => {
    const stored = recording();
    const authored = chart([]);
    const graph = {
      ...authored,
      stages: [
        ...authored.stages.slice(0, 2),
        { id: 'skip', stageId: 'seed', role: 'stage', edges: [] },
        { id: 'earlier', stageId: 'seed', role: 'stage', edges: [] },
      ],
    };
    const result = await couldHaveChanged(stored, 'price', 2, await catalog(stored, graph));
    expect(result.candidates).toEqual([]);
    expect(result.gaps).toContain('writers-unknown');
  });

  it('retains ordinary causes for an admitted scope without a chart binding', async () => {
    const stored = recording();
    const log = stored.log(address);
    if (!log) throw new Error('Missing saved test scope');
    const keys = (id: string) => (id === 'keep#2' ? ['price'] : []);
    const baseline = causalChain([...log.commitLog], 'keep#2', keys);
    expect(baseline).toBeDefined();
    const options = {
      address,
      chart: undefined,
      authority: {
        lookup: (candidate: typeof stored, scope: typeof address) =>
          candidate === stored && scope.logRunId === address.logRunId && !scope.drillPath.length
            ? { capture: { recordingVersion: 'shelf/legacy/1', runId: 'r', address, from: 0, to: 3 } }
            : undefined,
      },
    };

    expect(await causalChainWithCouldHaveChanged(stored, 'keep#2', keys, 'price', options)).toEqual({
      causal: baseline,
      skipped: [],
      gaps: ['chart-binding'],
    });
    expect(await couldHaveChanged(stored, 'price', 2, options)).toEqual({ candidates: [], gaps: ['chart-binding'] });
    const deniedKeys = vi.fn(keys);
    expect(await causalChainWithCouldHaveChanged(recording(), 'keep#2', deniedKeys, 'price', options)).toEqual({
      causal: undefined,
      skipped: [],
      gaps: ['chart-binding'],
    });
    expect(deniedKeys).not.toHaveBeenCalled();
  });

  it('keeps causal edges and weighting calls unchanged when it adds a separate omission edge', async () => {
    const stored = recording();
    const options = await catalog(stored, chart(['price']));
    const log = stored.log(address);
    if (!log) throw new Error('Missing saved test scope');
    const keys = (id: string) => (id === 'keep#2' ? ['price'] : []);
    const before = vi.fn(() => 1);
    const after = vi.fn(() => 1);
    const baseline = causalChain([...log.commitLog], 'keep#2', keys, { weigh: before });
    const result = await causalChainWithCouldHaveChanged(stored, 'keep#2', keys, 'price', options, { weigh: after });
    expect(result.causal).toEqual(baseline);
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(result.skipped).toMatchObject([{ kind: 'could-have-changed', key: 'price', decision: { id: 'choose#1' } }]);
    expect(result.gaps).toEqual([]);
  });
});
