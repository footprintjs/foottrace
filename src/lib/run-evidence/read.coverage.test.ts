/** An entered execution without its first about is missing coverage, never proof of empty reads. */
import { describe, expect, it, vi } from 'vitest';

import {
  createReadSourceRecord,
  EventLog,
  memorySink,
  RecordFrame,
  SharedMemory,
  type CommitAbout,
  type CommitStamp,
} from '../../write';
import { readStoredRecord } from '../time-travel/storedRecord';
import { RUN_EVIDENCE_LIMITS } from './kinds';
import { readRunEvidence } from './read';

const ROOT = { logRunId: 'r', drillPath: [] as string[] };

function writer(reads: 'keys' | 'off' | undefined = 'keys', address = ROOT, sink = memorySink()) {
  const state = new SharedMemory();
  const log = new EventLog({}, { sink, address, ...(reads === undefined ? {} : { collects: { reads } }) });
  return { state, log, sink, address };
}

type Writer = ReturnType<typeof writer>;

function commit(w: Writer, id: string, about?: CommitAbout, phase?: CommitStamp['phase']): void {
  new RecordFrame(w.state, w.log).commit(() => ({
    stage: id,
    stageId: id.split('#')[0],
    runtimeStageId: id,
    ...(about === undefined ? {} : { about }),
    ...(phase === undefined ? {} : { phase }),
  }));
}

function evidence(w: Writer, legs: string | readonly string[] = 'r') {
  return readRunEvidence(readStoredRecord(w.sink.entries), legs);
}

/** A native buffer failure before stampOf/about or EventLog.record; neither the sink nor the reader is mocked. */
function failFirstCommit(w: Writer, id: string): void {
  const frame = new RecordFrame(w.state, w.log);
  frame.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix' });
  const reads = Array.from({ length: RUN_EVIDENCE_LIMITS.reads + 1 }, (_, i) => `key${i}`);
  for (const key of reads) {
    frame.read([], key);
    frame.noteRead([], key);
  }
  frame.write(['uncloneable'], () => 1, 'set');
  const stamp = vi.fn(() => ({ stage: id, stageId: id.split('#')[0], runtimeStageId: id, about: { reads } }));
  expect(() => frame.commit(stamp)).toThrow();
  expect(stamp).not.toHaveBeenCalled();
}

function expectMissing(channel: { status: string; gaps?: readonly string[] }): void {
  expect(channel.status).toBe('partial');
  expect(channel.gaps).toContain('not-collected');
}

describe('known entry without a first commit', () => {
  it('the read-source factory and canonical reader use the same failed native log', () => {
    const state = new SharedMemory(undefined, { input: 1 });
    const sink = memorySink();
    const record = createReadSourceRecord(state, ROOT, { sink, collects: { reads: 'keys' } });
    const frame = new RecordFrame(state, record.log);
    record.log.noteRun('run.stage', { id: 'a#0' });
    expect(frame.readWithSource([], 'input', { runtimeStageId: 'a#0' }).value).toBe(1);
    frame.write(['uncloneable'], () => 1, 'set');
    const stamp = vi.fn(() => ({ stage: 'a', stageId: 'a', runtimeStageId: 'a#0', about: { reads: ['input'] } }));
    expect(() => frame.commit(stamp)).toThrow();
    expect(stamp).not.toHaveBeenCalled();
    frame.discard();
    record.log.close('failed');
    const e = readRunEvidence(readStoredRecord(sink.entries), 'r');
    expect(record.log.length).toBe(0);
    expect(record.snapshot().occurrences).toHaveLength(1);
    expect(sink.entries.at(-1)).toMatchObject({ commits: 0, runNotes: 1 });
    expect(e.stages).toMatchObject({ status: 'collected', rows: [{ id: 'a#0', committed: false }] });
    expectMissing(e.reads);
    expectMissing(e.attention);
    expect(e.reads.rows).toEqual([]);
    expect(e.unread).toEqual([]);
    record.retire();
  });

  it('a real first-commit failure preserves the stage and real counts, but cannot certify empty reads or attention', () => {
    const w = writer();
    w.log.noteRun('run.stage', { id: 'a#0' });
    failFirstCommit(w, 'a#0');
    expect(w.log.length).toBe(0);
    w.log.close('failed');

    expect(w.sink.entries.map((row) => row.kind)).toEqual(['opened', 'note', 'closed']);
    expect(w.sink.entries.at(-1)).toMatchObject({ kind: 'closed', commits: 0, runNotes: 1, outcome: 'failed' });
    const stored = readStoredRecord(w.sink.entries);
    expect(stored.root('r')).toMatchObject({ complete: true, outcome: 'failed' });
    const e = readRunEvidence(stored, 'r');
    expect(e.stages).toMatchObject({ status: 'collected', rows: [{ id: 'a#0', committed: false }] });
    expect(e.control('a#0')).toEqual({ status: 'collected', gaps: [] });
    expect(e.unread).toEqual([]);
    expect(e.reads.rows).toEqual([]);
    expect(e.attention.rows).toEqual([]);
    expectMissing(e.reads);
    expectMissing(e.attention);
    expect(e.reads).not.toHaveProperty('omitted');
    expect(e.reads).toHaveProperty('gaps', ['not-collected']);
  });

  it('an earlier successful execution does not hide the later native commit failure', () => {
    const w = writer();
    commit(w, 'seed#0', { reads: ['earlier'] });
    w.log.noteRun('run.stage', { id: 'later#1', parent: 'seed#0' });
    failFirstCommit(w, 'later#1');
    expect(w.log.length).toBe(1);
    w.log.close('failed');
    const e = evidence(w);
    expect(e.reads.rows).toEqual([{ id: 'seed#0', address: ROOT, keys: ['earlier'] }]);
    expect(e.stages.rows).toEqual([
      { id: 'seed#0', address: ROOT, committed: true },
      { id: 'later#1', address: ROOT, parent: 'seed#0', committed: false },
    ]);
    expect(e.stages.status).toBe('collected');
    expect(e.control('later#1')).toEqual({ status: 'collected', gaps: [] });
    expectMissing(e.reads);
    expectMissing(e.attention);
  });

  it.each(['ok', 'failed'] as const)('closing %s cannot supply a missing entered execution annotation', (outcome) => {
    const w = writer();
    w.log.noteRun('run.stage', { id: 'a#0' });
    w.log.close(outcome);
    const e = evidence(w);
    expectMissing(e.reads);
    expectMissing(e.attention);
    expect(e.reads.rows).toEqual([]);
    expect(e.stages.status).toBe('collected');
    expect(e.control('a#0')).toEqual({ status: 'collected', gaps: [] });
  });

  it('reads-off stays explicit while missing attention remains unknown', () => {
    const w = writer('off');
    w.log.noteRun('run.stage', { id: 'a#0' });
    w.log.close('failed');
    const e = evidence(w);
    expect(e.reads).toEqual({ status: 'not-collected', rows: [], why: 'reads-off' });
    expectMissing(e.attention);
    expect(e.stages.status).toBe('collected');
  });

  it.each(['repeat', 'exit'] as const)(
    'a non-seed %s commit alone cannot certify the missing first annotation',
    (phase) => {
      const w = writer();
      commit(w, 'a#0', undefined, phase);
      w.log.close('failed');
      expect(readStoredRecord(w.sink.entries).root('r')?.complete).toBe(true);
      expect(w.log.length).toBe(1);
      const e = evidence(w);
      expect(e.reads.rows).toEqual([]);
      expect(e.attention.rows).toEqual([]);
      expectMissing(e.reads);
      expectMissing(e.attention);
      expect(e.control('a#0')).toEqual({ status: 'not-collected', gaps: [], why: 'no-about' });
    },
  );
});

describe('positive coverage remains positive', () => {
  it.each(['ok', 'failed'] as const)(
    'a closed %s run with no entry and no commits invents no missing execution',
    (outcome) => {
      const w = writer();
      w.log.close(outcome);
      const e = evidence(w);
      expect(e.reads).toEqual({ status: 'collected', rows: [] });
      expect(e.attention).toEqual({ status: 'collected', rows: [] });
      expect(e.stages).toEqual({ status: 'collected', rows: [] });
      expect(w.sink.entries.at(-1)).toMatchObject({ commits: 0, runNotes: 0 });
    },
  );

  it('a genuine committed empty about proves an empty reads row', () => {
    const w = writer();
    commit(w, 'a#0', {});
    w.log.close('ok');
    const e = evidence(w);
    expect(e.reads).toEqual({ status: 'collected', rows: [{ id: 'a#0', address: ROOT, keys: [] }] });
    expect(e.attention).toEqual({ status: 'collected', rows: [] });
    expect(e.stages.rows).toEqual([{ id: 'a#0', address: ROOT, committed: true }]);
  });

  it.each(['stage-first', 'about-first'] as const)('agreement clears provisional missing coverage: %s', (order) => {
    const w = writer();
    if (order === 'stage-first') w.log.noteRun('run.stage', { id: 'a#0' });
    commit(w, 'a#0', { reads: ['kept'] });
    if (order === 'about-first') w.log.noteRun('run.stage', { id: 'a#0' });
    w.log.close('ok');
    const e = evidence(w);
    expect(e.reads).toEqual({ status: 'collected', rows: [{ id: 'a#0', address: ROOT, keys: ['kept'] }] });
    expect(e.attention).toEqual({ status: 'collected', rows: [] });
    expect(e.stages).toEqual({ status: 'collected', rows: [{ id: 'a#0', address: ROOT, committed: true }] });
    expect(e.unread).toEqual([]);
  });

  it('real writer-bounded omitted reads keep their exact count', () => {
    const w = writer();
    const reads = Array.from({ length: RUN_EVIDENCE_LIMITS.reads + 1 }, (_, i) => `key${i}`);
    commit(w, 'a#0', { reads });
    w.log.close('ok');
    const e = evidence(w);
    expect(e.reads).toEqual({
      status: 'partial',
      rows: [{ id: 'a#0', address: ROOT, keys: reads.slice(0, RUN_EVIDENCE_LIMITS.reads), omitted: 1 }],
      gaps: ['truncated'],
    });
    expect(e.attention.status).toBe('collected');
  });

  it('a later continuation with a real first about is still collected', () => {
    const w = writer();
    commit(w, 'a#0', { reads: ['first'] });
    commit(w, 'a#0', undefined, 'repeat');
    commit(w, 'a#0', undefined, 'exit');
    w.log.close('ok');
    expect(evidence(w).reads).toEqual({ status: 'collected', rows: [{ id: 'a#0', address: ROOT, keys: ['first'] }] });
  });

  it('a log without collects is never upgraded to empty collection', () => {
    const sink = memorySink();
    const log = new EventLog({}, { sink, address: ROOT });
    log.noteRun('run.stage', { id: 'a#0' });
    log.close('failed');
    const e = readRunEvidence(readStoredRecord(sink.entries), 'r');
    expect(e.reads).toEqual({ status: 'not-collected', rows: [], why: 'no-collects' });
    expect(e.attention).toEqual({ status: 'not-collected', rows: [], why: 'no-collects' });
    expect(sink.entries.map((row) => row.kind)).toEqual(['opened', 'closed']);
  });
});

describe('coverage belongs to the admitted execution in its own log', () => {
  it("a child seed and child about cannot supply the mount entry's own missing annotation", () => {
    const root = writer();
    root.log.noteRun('run.stage', { id: 'mount#0' });
    const child = writer('keys', { logRunId: 'r', drillPath: ['mount#0'] }, root.sink);
    commit(child, 'mount#0');
    commit(child, 'mount/inside#1', { parent: 'mount#0', reads: ['child'] });
    child.log.close('ok');
    root.log.close('failed');
    const e = evidence(root);
    expect(e.reads.rows).toEqual([{ id: 'mount/inside#1', address: child.address, keys: ['child'] }]);
    expectMissing(e.reads);
    expectMissing(e.attention);
    expect(e.stages.status).toBe('collected');
    expect(e.stages.rows).toEqual([
      { id: 'mount#0', address: ROOT, committed: false },
      { id: 'mount/inside#1', address: child.address, parent: 'mount#0', committed: true },
    ]);
    expect(e.control('mount/inside#1')).toEqual({ status: 'collected', gaps: [] });
    expect(e.unread).toEqual([]);
  });

  it('a child seed without about is not a new missing execution when the parent actually committed', () => {
    const root = writer();
    commit(root, 'mount#0', {});
    const child = writer('keys', { logRunId: 'r', drillPath: ['mount#0'] }, root.sink);
    commit(child, 'mount#0');
    commit(child, 'mount/inside#1', { parent: 'mount#0' });
    child.log.close('ok');
    root.log.close('ok');
    const e = evidence(root);
    expect(e.reads).toEqual({
      status: 'collected',
      rows: [
        { id: 'mount#0', address: ROOT, keys: [] },
        { id: 'mount/inside#1', address: child.address, keys: [] },
      ],
    });
    expect(e.attention.status).toBe('collected');
    expect(e.stages.status).toBe('collected');
    expect(e.unread).toEqual([]);
  });

  it('an unrequested leg with the same execution ID cannot cure the requested leg', () => {
    const root = writer();
    root.log.noteRun('run.stage', { id: 'a#0' });
    root.log.close('failed');
    const other = writer('keys', { logRunId: 'other', drillPath: [] }, root.sink);
    commit(other, 'a#0', { reads: ['other-leg'] });
    other.log.close('ok');
    const e = evidence(root);
    expectMissing(e.reads);
    expect(e.reads.rows).toEqual([]);
    expect(e.stages.rows).toEqual([{ id: 'a#0', address: ROOT, committed: false }]);
    const otherEvidence = evidence(root, 'other');
    expect(otherEvidence.reads.status).toBe('collected');
    expect(otherEvidence.reads.rows[0].keys).toEqual(['other-leg']);
  });

  it('an about rejected for contradicting its entry cannot certify the reads it contains', () => {
    const w = writer();
    commit(w, 'seed#0', {});
    commit(w, 'p#1', { parent: 'seed#0' });
    w.log.noteRun('run.stage', { id: 'a#2', parent: 'seed#0' });
    commit(w, 'a#2', { parent: 'p#1', reads: ['refused'] });
    w.log.close('ok');
    const e = evidence(w);
    expect(e.unread).toHaveLength(1);
    expect(e.reads.rows.map((row) => row.id)).toEqual(['seed#0', 'p#1']);
    expect(e.reads).toMatchObject({ status: 'partial', gaps: ['invalid-data'] });
    expect(e.attention).toEqual({ status: 'partial', rows: [], gaps: ['invalid-data'] });
    expect(e.stages.rows.find((row) => row.id === 'a#2')).toMatchObject({ parent: 'seed#0', committed: true });
  });

  it('a refusal for one execution does not hide another execution whose annotation is absent', () => {
    const w = writer();
    commit(w, 'seed#0', { reads: ['kept'] });
    commit(w, 'p#1', { parent: 'seed#0' });
    w.log.noteRun('run.stage', { id: 'a#2', parent: 'seed#0' });
    commit(w, 'a#2', { parent: 'p#1', reads: ['refused'] });
    w.log.noteRun('run.stage', { id: 'b#3', parent: 'seed#0' });
    w.log.close('failed');
    const e = evidence(w);
    expect(e.reads).toEqual({
      status: 'partial',
      rows: [
        { id: 'seed#0', address: ROOT, keys: ['kept'] },
        { id: 'p#1', address: ROOT, keys: [] },
      ],
      gaps: ['invalid-data', 'not-collected'],
    });
    expect(e.attention).toEqual({ status: 'partial', rows: [], gaps: ['invalid-data', 'not-collected'] });
    expect(e.stages.rows.find((row) => row.id === 'b#3')).toEqual({
      id: 'b#3',
      address: ROOT,
      parent: 'seed#0',
      committed: false,
    });
    expect(e.stages).toHaveProperty('gaps', ['invalid-data']);
    expect(e.unread).toHaveLength(1);
  });

  it.each(['reads', 'marks'] as const)(
    'a valid writer annotation refused by a lowered %s cap stays exactly truncated',
    (cap) => {
      const w = writer();
      const mark = { kind: 'retried', reason: 'RETRY_RECORDED' as const, evidence: ['attempt:a#0@1'] };
      w.log.noteRun('run.stage', { id: 'a#0' });
      commit(w, 'a#0', { reads: ['kept'], attention: [mark] });
      w.log.close('ok');
      const stored = readStoredRecord(w.sink.entries);
      const full = readRunEvidence(stored, 'r');
      expect(full.reads).toEqual({ status: 'collected', rows: [{ id: 'a#0', address: ROOT, keys: ['kept'] }] });
      expect(full.attention).toEqual({ status: 'collected', rows: [{ id: 'a#0', address: ROOT, marks: [mark] }] });
      const limited = readRunEvidence(stored, 'r', { [cap]: 0 });
      expect(limited.reads).toEqual({ status: 'partial', rows: [], gaps: ['truncated'] });
      expect(limited.attention).toEqual({ status: 'partial', rows: [], gaps: ['truncated'] });
      expect(limited.unread).toHaveLength(1);
    },
  );

  it('a same-ID annotation accessor is refused without running its getter or claiming the annotation was absent', () => {
    const w = writer();
    w.log.noteRun('run.stage', { id: 'a#0' });
    commit(w, 'a#0', {});
    w.log.close('ok');
    const getter = vi.fn(() => ({ reads: ['must-not-run'] }));
    const entries = w.sink.entries.map((row) =>
      row.kind === 'commit' ? Object.defineProperty({ ...row }, 'about', { enumerable: true, get: getter }) : row,
    );
    const stored = readStoredRecord(entries);
    expect(stored.unread).toEqual([]);
    expect(stored.root('r')).toMatchObject({ complete: true, outcome: 'ok' });
    const e = readRunEvidence(stored, 'r');
    expect(getter).not.toHaveBeenCalled();
    expect(e.reads).toEqual({ status: 'partial', rows: [], gaps: ['invalid-data'] });
    expect(e.attention).toEqual({ status: 'partial', rows: [], gaps: ['invalid-data'] });
    expect(e.unread).toHaveLength(1);
  });

  it('a duplicate stage remains refused and writer note counts are not repaired', () => {
    const w = writer();
    w.log.noteRun('run.stage', { id: 'a#0' });
    w.log.noteRun('run.stage', { id: 'a#0' });
    w.log.close('failed');
    const e = evidence(w);
    expect(w.sink.entries.at(-1)).toMatchObject({ commits: 0, runNotes: 2 });
    expect(e.unread).toHaveLength(1);
    expect(e.stages.rows).toHaveLength(1);
    expect(e.stages).toHaveProperty('gaps', ['invalid-data']);
    expectMissing(e.reads);
  });
});
