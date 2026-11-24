import { describe, expect, it } from 'vitest';

import { readBoundSavedProjection, savedChartDigest } from './savedBinding.js';

const capture = {
  recordingVersion: 'immutable-recording-1',
  runId: 'leg-1',
  address: { logRunId: 'record-owner', drillPath: [] },
  from: 0,
  to: 6,
};

describe('capture-time binding of saved skipped topology', () => {
  it('admits only the graph captured even when execution IDs and the chosen path match', async () => {
    const unchanged = { links: ['decision', 'taken', 'skipped'], stage: { id: 'skipped', writes: [] } };
    const newWriter = { ...unchanged, stage: { ...unchanged.stage, writes: ['price'] } };
    const binding = {
      ...capture,
      version: 'footprint.skipped-chart.v1' as const,
      digest: await savedChartDigest(newWriter),
    };
    const correct = await readBoundSavedProjection(capture, binding, newWriter);
    expect(correct.status).toBe('host-attested');
    expect(await readBoundSavedProjection(capture, binding, unchanged)).toEqual({ status: 'chart-binding' });
    expect(await readBoundSavedProjection(capture, undefined, newWriter)).toEqual({ status: 'chart-binding' });
    expect(await readBoundSavedProjection(capture, binding, newWriter, { left: 1 })).toEqual({ status: 'truncated' });
  });

  it('distinguishes empty from absent declarations and checks version, leg, scope and interval', async () => {
    const absent = { id: 'skipped' };
    const empty = { ...absent, writes: [] };
    expect(await savedChartDigest(absent)).not.toBe(await savedChartDigest(empty));
    const binding = {
      ...capture,
      version: 'footprint.skipped-chart.v1' as const,
      digest: await savedChartDigest(empty),
    };
    for (const other of [
      { ...capture, recordingVersion: 'other-recording' },
      { ...capture, runId: 'leg-2' },
      { ...capture, address: { ...capture.address, drillPath: ['mount#1'] } },
      { ...capture, from: 1 },
      { ...capture, to: 7 },
    ])
      expect(await readBoundSavedProjection(other, binding, empty)).toEqual({ status: 'chart-binding' });
  });
});
