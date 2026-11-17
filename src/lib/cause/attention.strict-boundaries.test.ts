import { describe, expect, it } from 'vitest';
import { createRecordGraph, explain, type ExplainOptions } from '../../cause.js';
import { readRunEvidence, readStoredRecord, type Attention, type CommitBundle } from '../../index.js';
import { exportProv } from '../../prov.js';
import { EventLog, memorySink, type RecordEntry } from '../../write.js';

const address = { logRunId: 'strict-run', drillPath: [] };
const valid: readonly Attention[] = [
  { kind: 'error', reason: 'ERROR_RECORDED', evidence: ['commit:0'] },
  { kind: 'retried', reason: 'RETRY_RECORDED', evidence: ['commit:0'] },
];
const mixed = (): readonly unknown[] => [
  valid[0],
  { kind: 'error', reason: 'PRIVATE_REASON', evidence: ['commit:0'] },
  valid[1],
];
function bundle(): CommitBundle {
  return {
    idx: 0,
    stage: 'write',
    stageId: 'write',
    runtimeStageId: 'write#0',
    trace: [{ path: 'x', verb: 'set', readKeys: [] }],
    redactedPaths: [],
    overwrite: { x: 1 },
    updates: {},
  };
}
function nativeGraph(marks: readonly unknown[]) {
  return createRecordGraph([
    {
      address,
      commitLog: [bundle()],
      reads: { 'write#0': [] },
      attention: { 'write#0': marks as readonly Attention[] },
      controlDeps: {},
      complete: true,
    },
  ]);
}
// This preservation control also compiles against the pre-option baseline.
const retainValid = { includeBackward: true, attentionAdmission: 'retain-valid' } as ExplainOptions;
function write(marks: readonly unknown[]) {
  const sink = memorySink();
  const failures: unknown[] = [];
  const log = new EventLog(
    {},
    {
      sink: {
        ...sink,
        onFailure(failure) {
          failures.push(failure);
        },
      },
      address,
      collects: { reads: 'keys' },
    },
  );
  expect(() => log.record(bundle(), { attention: marks as readonly Attention[] })).not.toThrow();
  const commits = sink.entries.filter(
    (entry): entry is Extract<RecordEntry, { kind: 'commit' }> => entry.kind === 'commit',
  );
  expect(commits).toHaveLength(1);
  return { log, failures, commit: commits[0]! };
}
function storedEvidence(marks: readonly unknown[]) {
  // Raw saved input deliberately bypasses writer omission of malformed about data.
  const entries: readonly unknown[] = [
    { kind: 'opened', address, at: 1, initialState: {}, collects: { v: 1, reads: 'keys' } },
    { kind: 'commit', address, at: 1, bundle: bundle(), about: { attention: marks } },
    { kind: 'closed', address, at: 1, outcome: 'ok', commits: 1, runNotes: 0 },
  ];
  return readRunEvidence(readStoredRecord(entries), address.logRunId);
}

describe('query attention policy does not weaken strict public boundaries', () => {
  it('keeps PROV canonical attention atomic while retaining the admitted execution', async () => {
    const result = await exportProv(
      { commitLog: [bundle()], attention: { 'write#0': mixed() } },
      { base: 'urn:test:strict-marks/' },
    );
    expect(result.document['@graph'].filter((node) => node['@type'] === 'ft:Attention')).toEqual([]);
    expect(result.document['@graph'].filter((node) => node['@type'] === 'prov:Activity')).toHaveLength(1);
    expect(result.document['@graph'].filter((node) => node['@type'] === 'ft:Commit')).toHaveLength(1);
    expect(result.gaps.some((gap) => gap.code === 'invalid-data')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_REASON');
  });

  it('retains both valid marks through the public PROV exporter', async () => {
    const result = await exportProv(
      { commitLog: [bundle()], attention: { 'write#0': valid } },
      { base: 'urn:test:strict-marks/' },
    );
    const marks = result.document['@graph'].filter((node) => node['@type'] === 'ft:Attention');
    expect(marks.map((node) => [node['ft:kind'], node['ft:reason']])).toEqual(
      valid.map((mark) => [mark.kind, mark.reason]),
    );
    expect(result.gaps.some((gap) => gap.code === 'invalid-data')).toBe(false);
  });

  it('does not recover invalid native-container neighbors through generic query opt-in', async () => {
    const graph = nativeGraph(mixed());
    const id = graph.nodeId(address, { runtimeStageId: 'write#0', commitIdx: 0, key: 'x' });
    const result = await explain(graph, id, retainValid);
    expect(result.attention).toEqual([]);
    expect(result.rootCause).toBeUndefined();
    expect(result.backward?.confidence).toBe('incomplete');
    expect(result.confidence).toBe('incomplete');
    expect(result.gaps.some((gap) => gap.code === 'invalid-data')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_REASON');
  });

  it('retains both valid native marks and their complete supported root', async () => {
    const graph = nativeGraph(valid);
    const id = graph.nodeId(address, { runtimeStageId: 'write#0', commitIdx: 0, key: 'x' });
    const result = await explain(graph, id, retainValid);
    expect(result.attention).toEqual(valid);
    expect(result.rootCause).toBe(id);
    expect(result.path).toEqual([id]);
    expect(result.gaps).toEqual([]);
    expect(result.confidence).toBe('complete');
  });

  it('serves the writer commit without any about and reports one malformed-batch failure', () => {
    const { log, failures, commit } = write(mixed());
    expect(commit.bundle.runtimeStageId).toBe('write#0');
    expect(commit).not.toHaveProperty('about');
    expect(log.sinkFailures).toBe(1);
    expect(failures).toHaveLength(1);
  });

  it('serves both valid writer marks without a sink failure', () => {
    const { log, failures, commit } = write(valid);
    expect(commit.about?.attention).toEqual(valid);
    expect(log.sinkFailures).toBe(0);
    expect(failures).toEqual([]);
  });

  it('rejects the entire raw stored attention batch instead of salvaging its valid neighbors', () => {
    const result = storedEvidence(mixed());
    expect(result.attention).toEqual({ status: 'partial', rows: [], gaps: ['invalid-data'] });
    expect(result.unread).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_REASON');
  });

  it('reads both valid saved marks as one collected execution row', () => {
    const result = storedEvidence(valid);
    expect(result.attention.status).toBe('collected');
    expect(result.attention.rows.map((row) => [row.id, row.marks])).toEqual([['write#0', valid]]);
    expect(result.unread).toEqual([]);
  });
});
