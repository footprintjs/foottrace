/**
 * The run-evidence writer: `opened.collects`, `commit.about`, `closed.runNotes`, `EventLog · noteRun` and
 * `keepsEvidence`.
 *
 *   unit      the three fields and the one note door; `about` is copied and bounded; a `seq` is the log's own
 *   boundary  every refusal is counted and reported, and never reaches the writer; the commit still goes
 *   law       the one-argument log and a log with evidence off keep their own fields and their bytes
 */
import { describe, expect, it } from 'vitest';

import type { Attention, CommitBundle, LogAddress } from '../../../../src/index.js';
import { readStoredRecord } from '../../../../src/index.js';
import type {
  CommitAbout,
  LogCollects,
  RecordEntry,
  RecordSink,
  RunDecisionNote,
  RunNoteKind,
  RunStageNote,
  RunStopNote,
} from '../../../../src/write.js';
import { EventLog, memorySink, RecordFrame, RUN_EVIDENCE_LIMITS, SharedMemory } from '../../../../src/write.js';

const ROOT: LogAddress = { logRunId: 'run-1', drillPath: [] };

function bundle(id: string, overwrite: Record<string, unknown> = {}): CommitBundle {
  const stageId = id.slice(0, id.lastIndexOf('#'));
  return {
    stage: stageId,
    stageId,
    runtimeStageId: id,
    trace: Object.keys(overwrite).map((path) => ({ path, verb: 'set' as const })),
    redactedPaths: [],
    overwrite,
    updates: {},
  };
}

function evidenceLog() {
  const sink = memorySink();
  const log = new EventLog({ n: 0 }, { sink, address: ROOT, collects: { reads: 'keys' } });
  return { sink, log };
}

type Stored<K extends RecordEntry['kind']> = Extract<RecordEntry, { kind: K }>;
const only = <K extends RecordEntry['kind']>(entries: readonly RecordEntry[], kind: K): Stored<K>[] =>
  entries.filter((entry) => entry.kind === kind) as Stored<K>[];

describe('opened.collects', () => {
  it('says what this log collects, with the version the record stamps', () => {
    const { sink, log } = evidenceLog();
    const collects: LogCollects | undefined = only(sink.entries, 'opened')[0].collects;
    expect(collects).toEqual({ v: 1, reads: 'keys' });
    expect(log.keepsEvidence).toBe(true);
  });

  it('carries `reads: off` for a run that tracks no reads', () => {
    const sink = memorySink();
    const log = new EventLog({}, { sink, address: ROOT, collects: { reads: 'off' } });
    expect(only(sink.entries, 'opened')[0].collects).toEqual({ v: 1, reads: 'off' });
    expect(log.keepsEvidence).toBe(true);
  });

  it('refuses a malformed declaration at the door: a writer’s mistake, before anything is stored', () => {
    const sink = memorySink();
    const given = { sink, address: ROOT, collects: { reads: 'everything' } } as unknown as ConstructorParameters<
      typeof EventLog
    >[1];
    expect(() => new EventLog({}, given)).toThrow(TypeError);
    expect(sink.entries).toEqual([]);
  });

  it('sits after meta, so an older entry’s bytes keep their order', () => {
    const sink = memorySink();
    new EventLog({ a: 1 }, { sink, address: ROOT, meta: { chart: 'pay' }, collects: { reads: 'keys' } });
    expect(Object.keys(sink.entries[0])).toEqual(['kind', 'address', 'at', 'initialState', 'meta', 'collects']);
  });
});

describe('commit.about', () => {
  it('lands beside the bundle, never in it', () => {
    const { sink, log } = evidenceLog();
    const about: CommitAbout = { parent: 'seed#0', reads: ['n'], description: 'Bump the count' };
    log.record(bundle('bump#1', { n: 1 }), about);
    const [commit] = only(sink.entries, 'commit');
    expect(commit.about).toEqual(about);
    expect(Object.keys(commit)).toEqual(['kind', 'address', 'at', 'bundle', 'about']);
    expect(commit.bundle).not.toHaveProperty('about');
    expect(log.list()[0]).not.toHaveProperty('about');
  });

  it('is present even when it has nothing to say: `{}` is “collected, nothing”, absence is “not collected”', () => {
    const { sink, log } = evidenceLog();
    log.record(bundle('seed#0'), {});
    log.record(bundle('lost#1'));
    const [first, second] = only(sink.entries, 'commit');
    expect(first.about).toEqual({});
    expect(second).not.toHaveProperty('about');
  });

  it('keeps one key order and only the named fields, whatever the writer handed over', () => {
    const { sink, log } = evidenceLog();
    const marks: Attention[] = [{ kind: 'retried', reason: 'RETRY_RECORDED', evidence: ['attempt:s#1.2'] }];
    const unordered = {
      attention: marks,
      description: 'text',
      readsOmitted: 2,
      reads: ['a'],
      resumes: 'p#3',
      parent: 'q#2',
      forged: 'not a field of about',
    } as CommitAbout;
    log.record(bundle('s#4'), unordered);
    const { about } = only(sink.entries, 'commit')[0];
    expect(Object.keys(about!)).toEqual(['parent', 'resumes', 'reads', 'readsOmitted', 'description', 'attention']);
    expect(about).toEqual({
      parent: 'q#2',
      resumes: 'p#3',
      reads: ['a'],
      readsOmitted: 2,
      description: 'text',
      attention: marks,
    });
  });

  it('is the sink’s own copy: a later edit by the writer reaches nothing', () => {
    const { sink, log } = evidenceLog();
    const reads = ['a'];
    const attention: Attention[] = [{ kind: 'retried', reason: 'RETRY_RECORDED', evidence: ['attempt:s#1.2'] }];
    log.record(bundle('s#1'), { reads, attention });
    reads.push('b');
    (attention[0].evidence as string[]).push('attempt:s#1.3');
    const { about } = only(sink.entries, 'commit')[0];
    expect(about!.reads).toEqual(['a']);
    expect(about!.attention![0].evidence).toEqual(['attempt:s#1.2']);
    expect(Object.isFrozen(about)).toBe(true);
  });

  it('drops an empty attention list: absent when empty', () => {
    const { sink, log } = evidenceLog();
    log.record(bundle('s#1'), { attention: [] });
    expect(only(sink.entries, 'commit')[0].about).toEqual({});
  });

  it('bounds the read names and counts what it left out, in first-read order', () => {
    const { sink, log } = evidenceLog();
    const limit = RUN_EVIDENCE_LIMITS.reads;
    const names = Array.from({ length: limit + 5 }, (_, i) => `k${i}`);
    log.record(bundle('s#1'), { reads: names, readsOmitted: 1 });
    const { about } = only(sink.entries, 'commit')[0];
    expect(about!.reads).toEqual(names.slice(0, limit));
    expect(about!.readsOmitted).toBe(6);
  });

  it('a name past its length is left out and counted, never cut: a cut name would name another key', () => {
    const { sink, log } = evidenceLog();
    const long = 'x'.repeat(RUN_EVIDENCE_LIMITS.readLength + 1);
    log.record(bundle('s#1'), { reads: ['a', long, 'b'] });
    const { about } = only(sink.entries, 'commit')[0];
    expect(about!.reads).toEqual(['a', 'b']);
    expect(about!.readsOmitted).toBe(1);
  });

  it('cuts a description at its bound', () => {
    const { sink, log } = evidenceLog();
    log.record(bundle('s#1'), { description: 'd'.repeat(RUN_EVIDENCE_LIMITS.description + 7) });
    expect(only(sink.entries, 'commit')[0].about!.description).toHaveLength(RUN_EVIDENCE_LIMITS.description);
  });

  it.each([
    ['an about that is not an object', 7],
    ['an array', ['s#0']],
    ['a parent that is not a string', { parent: 7 }],
    ['resumes that is not a string', { resumes: {} }],
    ['reads that is not an array', { reads: 'a' }],
    ['a read name that is not a string', { reads: [1] }],
    ['an omitted count that is not a count', { readsOmitted: -1 }],
    ['a description that is not a string', { description: 1 }],
    ['attention that is not a list', { attention: {} }],
    ['too many marks', { attention: Array.from({ length: 33 }, () => ({ kind: 'k', reason: 'r', evidence: [] })) }],
    ['too many refs on a mark', { attention: [{ kind: 'k', reason: 'r', evidence: Array(17).fill('e') }] }],
    ['marks that will not copy', { attention: [{ kind: 'k', reason: 'r', evidence: [() => 0] }] }],
  ])('%s: lost on its own, counted and reported — the commit still goes', (_name, about) => {
    const failures: unknown[] = [];
    const sink = memorySink();
    const log = new EventLog(
      {},
      {
        sink: { ...sink, onFailure: (failure) => void failures.push(failure) },
        address: ROOT,
        collects: { reads: 'keys' },
      },
    );
    log.record(bundle('s#1'), about as unknown as CommitAbout);
    const [commit] = only(sink.entries, 'commit');
    expect(commit.bundle.runtimeStageId).toBe('s#1');
    expect(commit).not.toHaveProperty('about');
    expect(log.sinkFailures).toBe(1);
    expect(failures).toHaveLength(1);
  });

  it('never reaches the writer when `about` itself cannot be read', () => {
    const { sink, log } = evidenceLog();
    const hostile = Object.defineProperty({}, 'parent', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    }) as CommitAbout;
    expect(() => log.record(bundle('s#1'), hostile)).not.toThrow();
    expect(only(sink.entries, 'commit')[0]).not.toHaveProperty('about');
    expect(log.sinkFailures).toBe(1);
  });
});

describe('EventLog · noteRun', () => {
  const decision: RunDecisionNote = { id: 'route#3', by: 'decide', chosen: 'manual' };
  const stop: RunStopNote = { id: 'route#3', by: 'break', reason: 'done' };
  const stage: RunStageNote = { id: 'mount#4', parent: 'route#3', resumes: 'ask#2' };

  it('stamps `seq`, the twin of `record` stamping `idx`, in the one note shape the store already holds', () => {
    const { sink, log } = evidenceLog();
    log.noteRun('run.stage', stage);
    log.noteRun('run.decision', decision);
    log.noteRun('run.stop', stop);
    const notes = only(sink.entries, 'note');
    expect(notes.map((n) => [n.note, n.data.seq])).toEqual([
      ['run.stage', 0],
      ['run.decision', 1],
      ['run.stop', 2],
    ]);
    expect(notes[1].data).toEqual({ seq: 1, ...decision });
    expect(Object.keys(notes[1].data)[0]).toBe('seq');
    expect(Object.keys(notes[1])).toEqual(['kind', 'address', 'at', 'note', 'data']);
  });

  it('seq is the log’s own: data cannot set it, and an own `__proto__` key stays data', () => {
    const { sink, log } = evidenceLog();
    const hostile = JSON.parse('{"id":"s#1","seq":999,"__proto__":{"polluted":true}}');
    log.noteRun('run.stage', hostile);
    const { data } = only(sink.entries, 'note')[0];
    expect(data.seq).toBe(0);
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
    expect((data as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('refuses a kind outside its closed list: counted, reported, no seq spent', () => {
    const failures: unknown[] = [];
    const sink = memorySink();
    const log = new EventLog(
      {},
      {
        sink: { ...sink, onFailure: (failure) => void failures.push(failure) },
        address: ROOT,
        collects: { reads: 'keys' },
      },
    );
    expect(() => log.noteRun('run.finding' as RunNoteKind, { id: 's#1' } as never)).not.toThrow();
    expect(only(sink.entries, 'note')).toEqual([]);
    expect(log.sinkFailures).toBe(1);
    expect(failures).toHaveLength(1);
    log.noteRun('run.stage', stage);
    expect(only(sink.entries, 'note')[0].data.seq).toBe(0);
  });

  it.each([
    ['data that is not a plain object', 7],
    ['an array', ['s#1']],
    ['data that will not copy', { id: 's#1', payload: () => 0 }],
  ])('%s: the note is lost alone and its seq is a hole the reader sees', (_name, data) => {
    const { sink, log } = evidenceLog();
    expect(() => log.noteRun('run.stop', data as never)).not.toThrow();
    log.noteRun('run.stage', stage);
    expect(only(sink.entries, 'note').map((n) => n.data.seq)).toEqual([1]);
    log.close('ok');
    expect(only(sink.entries, 'closed')[0].runNotes).toBe(2);
    expect(log.sinkFailures).toBe(1);
  });

  it('a getter in the data cannot reach the writer', () => {
    const { sink, log } = evidenceLog();
    const hostile = Object.defineProperty({}, 'id', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(() => log.noteRun('run.stage', hostile as never)).not.toThrow();
    expect(only(sink.entries, 'note')).toEqual([]);
    expect(log.sinkFailures).toBe(1);
  });

  it('a sink that fails loses the note and spends its seq: the store shows a hole', () => {
    const inner = memorySink();
    let failing = true;
    const sink: RecordSink = {
      ...inner,
      note: (entry) => {
        if (failing) throw new Error('disk full');
        inner.note(entry);
      },
    };
    const log = new EventLog({}, { sink, address: ROOT, collects: { reads: 'keys' } });
    log.noteRun('run.stage', stage);
    failing = false;
    log.noteRun('run.stage', stage);
    expect(only(inner.entries, 'note').map((n) => n.data.seq)).toEqual([1]);
    expect(log.sinkFailures).toBe(1);
  });
});

describe('closed.runNotes', () => {
  it('counts every run note this log wrote; zero is said, and it sits after meta', () => {
    const { sink, log } = evidenceLog();
    log.close('ok', { why: 'done' });
    const [closed] = only(sink.entries, 'closed');
    expect(closed.runNotes).toBe(0);
    expect(Object.keys(closed)).toEqual(['kind', 'address', 'at', 'outcome', 'commits', 'meta', 'runNotes']);
  });

  it('a later close carries the larger count (a resume on the same log), and writer notes do not count', () => {
    const { sink, log } = evidenceLog();
    log.noteRun('run.stage', { id: 's#1' });
    log.note('attempt', { n: 1 });
    log.close('paused');
    log.noteRun('run.stage', { id: 's#2' });
    log.close('ok');
    expect(only(sink.entries, 'closed').map((c) => c.runNotes)).toEqual([1, 2]);
  });
});

describe('without evidence, nothing moves', () => {
  it('the one-argument log keeps its fields and JSON, and every evidence door is inert', () => {
    const log = new EventLog({ a: 1 });
    expect(log.keepsEvidence).toBe(false);
    log.record(bundle('s#0', { a: 2 }), { parent: 'p#0' });
    log.noteRun('run.stage', { id: 's#0' });
    log.close('ok');
    expect(Object.keys(log)).toEqual(['base', 'steps', 'sourceAddress', 'sourceAddressRetired']);
    expect(log.list()[0]).not.toHaveProperty('about');
    expect(JSON.stringify(new EventLog({ a: 1 }))).toBe('{"base":{"a":1},"steps":[],"sourceAddressRetired":false}');
  });

  it('a sink without `collects` (evidence off) writes today’s entries and today’s fields', () => {
    const sink = memorySink();
    const log = new EventLog({ a: 1 }, { sink, address: ROOT });
    expect(log.keepsEvidence).toBe(false);
    log.record(bundle('s#0', { a: 2 }), { parent: 'p#0' });
    log.noteRun('run.stage', { id: 's#0' });
    log.close('ok');
    expect(sink.entries.map((e) => e.kind)).toEqual(['opened', 'commit', 'closed']);
    expect(Object.keys(sink.entries[0])).toEqual(['kind', 'address', 'at', 'initialState']);
    expect(Object.keys(sink.entries[1])).toEqual(['kind', 'address', 'at', 'bundle']);
    expect(Object.keys(sink.entries[2])).toEqual(['kind', 'address', 'at', 'outcome', 'commits']);
    expect(Object.keys(log)).toEqual(['base', 'steps', 'sourceAddress', 'sourceAddressRetired', 'sink', 'lostEntries']);
  });

  it('a log with evidence adds its two fields only when asked', () => {
    const { log } = evidenceLog();
    expect(Object.keys(log)).toEqual([
      'base',
      'steps',
      'sourceAddress',
      'sourceAddressRetired',
      'sink',
      'lostEntries',
      'collects',
      'runNotes',
    ]);
  });
});

describe('CommitStamp.about — the frame hands it to the log', () => {
  const stamp = { stage: 'Step', stageId: 'step', runtimeStageId: 'step#1' };

  it('reaches the empty commit and the payload commit alike, and never the bundle’s bytes', () => {
    const state = new SharedMemory(undefined, { n: 0 });
    const sink = memorySink();
    const log = new EventLog(state.getState(), { sink, address: ROOT, collects: { reads: 'keys' } });

    const empty = new RecordFrame(state, log);
    empty.commit(() => ({ ...stamp, about: { parent: 'seed#0' } }));
    empty.release();

    const writes = new RecordFrame(state, log);
    writes.write(writes.at([], 'n'), 1, 'set');
    writes.commit(() => ({ ...stamp, runtimeStageId: 'step#2', about: { parent: 'step#1', reads: ['n'] } }));
    writes.release();

    const commits = only(sink.entries, 'commit');
    expect(commits.map((c) => c.about)).toEqual([{ parent: 'seed#0' }, { parent: 'step#1', reads: ['n'] }]);

    const plainState = new SharedMemory(undefined, { n: 0 });
    const plainLog = new EventLog(plainState.getState());
    const plainEmpty = new RecordFrame(plainState, plainLog);
    plainEmpty.commit(() => stamp);
    plainEmpty.release();
    const plainWrites = new RecordFrame(plainState, plainLog);
    plainWrites.write(plainWrites.at([], 'n'), 1, 'set');
    plainWrites.commit(() => ({ ...stamp, runtimeStageId: 'step#2' }));
    plainWrites.release();
    expect(JSON.stringify(log.list())).toBe(JSON.stringify(plainLog.list()));
  });

  it('is read with the names, before anything moves: a stamp that cannot be read fails the commit whole', () => {
    const state = new SharedMemory(undefined, { n: 0 });
    const log = new EventLog(state.getState());
    const frame = new RecordFrame(state, log);
    frame.write(frame.at([], 'n'), 1, 'set');
    const hostile = Object.defineProperty({ ...stamp }, 'about', {
      get() {
        throw new Error('boom');
      },
    });
    expect(() => frame.commit(() => hostile)).toThrow('boom');
    expect(state.getState()).toEqual({ n: 0 });
    expect(log.length).toBe(0);
  });
});

describe('a named-field adapter', () => {
  /** What an adapter sees, and the entries a named-field copy of them stores. */
  function capture() {
    const calls: Record<string, Record<string, unknown>> = {};
    const sink: RecordSink = {
      opened: (entry) => void (calls.opened = { ...entry }),
      commit: (entry) => void (calls.commit = { ...entry }),
      note: (entry) => void (calls.note = { ...entry }),
      closed: (entry) => void (calls.closed = { ...entry }),
    };
    const log = new EventLog({}, { sink, address: ROOT, meta: { m: 1 }, collects: { reads: 'keys' } });
    log.record(bundle('s#0'), { reads: ['a'] });
    log.noteRun('run.stage', { id: 'm#1' });
    log.close('ok', { m: 2 });
    return calls;
  }

  it('is handed each new field by name, on the method that carries it', () => {
    const calls = capture();
    expect(Object.keys(calls.opened)).toEqual(['address', 'at', 'initialState', 'meta', 'collects']);
    expect(Object.keys(calls.commit)).toEqual(['address', 'at', 'bundle', 'about']);
    expect(Object.keys(calls.note)).toEqual(['address', 'at', 'kind', 'data']);
    expect(Object.keys(calls.closed)).toEqual(['address', 'at', 'outcome', 'commits', 'meta', 'runNotes']);
    expect(calls.opened.collects).toEqual({ v: 1, reads: 'keys' });
    expect(calls.commit.about).toEqual({ reads: ['a'] });
    expect(calls.note).toMatchObject({ kind: 'run.stage', data: { seq: 0, id: 'm#1' } });
    expect(calls.closed.runNotes).toBe(1);
  });

  it('memorySink, the reference adapter, stores all of them', () => {
    const { sink, log } = evidenceLog();
    log.record(bundle('s#0'), { reads: ['a'] });
    log.close('ok');
    const [opened, commit, closed] = sink.entries as [Stored<'opened'>, Stored<'commit'>, Stored<'closed'>];
    expect(opened.collects).toEqual({ v: 1, reads: 'keys' });
    expect(commit.about).toEqual({ reads: ['a'] });
    expect(closed.runNotes).toBe(0);
    expect(Object.isFrozen(opened.collects)).toBe(true);
  });

  it('an adapter written before these fields copies what it knows and stays a good adapter', () => {
    const stored: RecordEntry[] = [];
    const old: RecordSink = {
      opened: ({ address, at, initialState }) => void stored.push({ kind: 'opened', address, at, initialState }),
      commit: ({ address, at, bundle: b }) => void stored.push({ kind: 'commit', address, at, bundle: b }),
      note: ({ address, at, kind, data }) => void stored.push({ kind: 'note', address, at, note: kind, data }),
      closed: ({ address, at, outcome, commits }) =>
        void stored.push({ kind: 'closed', address, at, outcome, commits }),
    };
    const log = new EventLog({}, { sink: old, address: ROOT, collects: { reads: 'keys' } });
    log.record(bundle('s#0'), { parent: 'p#0' });
    log.noteRun('run.stage', { id: 'm#1' });
    log.close('ok');
    expect(log.sinkFailures).toBe(0);
    expect(Object.keys(stored[0])).toEqual(['kind', 'address', 'at', 'initialState']);
    expect(stored[1]).not.toHaveProperty('about');
    const read = readStoredRecord(stored).root('run-1')!;
    expect(read.complete).toBe(true);
    expect(read.gaps).toEqual([]);
    expect(read.notes.map((n) => n.kind)).toEqual(['run.stage']);
  });
});

describe('the stored reader keeps its laws over a new file', () => {
  it('reads every new field as opaque: nothing unread, whole, complete, the fold unchanged', () => {
    const { sink, log } = evidenceLog();
    log.record(bundle('seed#0', { n: 1 }), {});
    log.noteRun('run.stop', { id: 'seed#0', by: 'break' });
    log.record(bundle('next#1', { n: 2 }), { parent: 'seed#0', reads: ['n'] });
    log.close('ok');
    const stored = readStoredRecord(JSON.parse(JSON.stringify(sink.entries)));
    expect(stored.unread).toEqual([]);
    const read = stored.root('run-1')!;
    expect(read.complete).toBe(true);
    expect(read.gaps).toEqual([]);
    expect(read.outcome).toBe('ok');
    expect(read.commitLog.map((b) => b.runtimeStageId)).toEqual(['seed#0', 'next#1']);
    expect(read.notes.map((n) => n.kind)).toEqual(['run.stop']);
    expect(read.commitLog[1]).not.toHaveProperty('about');
  });
});
