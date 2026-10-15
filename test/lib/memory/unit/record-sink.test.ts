/**
 * The sink port (1.1.0) — `EventLog(base, { sink, address, meta? })` hands each entry to a `RecordSink` as it
 * lands, and `memorySink` keeps them.
 *
 *   unit  the four entries and their order (opened from the constructor, commit after the freeze, note,
 *         closed with the log's length); the address is the log's address, copied and frozen; the sink
 *         keeps its own copy of the base, of `meta` and of a note's `data`; the commit is the log's own
 *         frozen bundle (served); `memorySink` stores `{ kind, ...entry }` (a note's kind as `note`), frozen,
 *         and hands out a new array on each read; the one-argument log calls nothing and keeps its bytes
 */
import { describe, expect, it } from 'vitest';

import type { CommitBundle, LogAddress } from '../../../../src/index.js';
import type { RecordEntry, RecordSink } from '../../../../src/write.js';
import { EventLog, memorySink, RecordFrame, SharedMemory } from '../../../../src/write.js';

const ROOT: LogAddress = { logRunId: 'run-1', drillPath: [] };

function bundle(stage: string, overwrite: Record<string, unknown> = {}): CommitBundle {
  return {
    stage,
    stageId: stage,
    runtimeStageId: `${stage}#0`,
    trace: Object.keys(overwrite).map((path) => ({ path, verb: 'set' as const })),
    redactedPaths: [],
    overwrite,
    updates: {},
  };
}

/** A sink that records every call it receives, by method — what an adapter sees. */
function spySink(): RecordSink & { calls: [string, unknown][] } {
  const calls: [string, unknown][] = [];
  return {
    calls,
    opened: (entry) => void calls.push(['opened', entry]),
    commit: (entry) => void calls.push(['commit', entry]),
    note: (entry) => void calls.push(['note', entry]),
    closed: (entry) => void calls.push(['closed', entry]),
  };
}

describe('EventLog with a sink — the entries, in order', () => {
  it('opened from the constructor, a commit per record, a note, closed with the length', () => {
    const sink = memorySink();
    const log = new EventLog({ count: 0 }, { sink, address: ROOT, meta: { chart: 'pay' } });
    expect(sink.entries.map((e) => e.kind)).toEqual(['opened']);

    log.record(bundle('a', { count: 1 }));
    log.note('attempt', { attempt: 1, outcome: 'failed' });
    log.record(bundle('b', { count: 2 }));
    log.close('ok', { reason: 'done' });

    const entries = sink.entries;
    expect(entries.map((e) => e.kind)).toEqual(['opened', 'commit', 'note', 'commit', 'closed']);
    const [opened, first, note, second, closed] = entries as [
      Extract<RecordEntry, { kind: 'opened' }>,
      Extract<RecordEntry, { kind: 'commit' }>,
      Extract<RecordEntry, { kind: 'note' }>,
      Extract<RecordEntry, { kind: 'commit' }>,
      Extract<RecordEntry, { kind: 'closed' }>,
    ];
    expect(opened.initialState).toEqual({ count: 0 });
    expect(opened.meta).toEqual({ chart: 'pay' });
    expect([first.bundle.idx, second.bundle.idx]).toEqual([0, 1]);
    expect(note).toMatchObject({ note: 'attempt', data: { attempt: 1, outcome: 'failed' } });
    expect(closed).toMatchObject({ outcome: 'ok', commits: 2, meta: { reason: 'done' } });
    for (const entry of entries) {
      expect(entry.address).toEqual(ROOT);
      expect(typeof entry.at).toBe('number');
    }
    expect(log.sinkFailures).toBe(0);
  });

  it('each method gets the entry without its kind; a note keeps its own kind as `kind`', () => {
    const sink = spySink();
    const log = new EventLog({}, { sink, address: ROOT });
    log.note('attempt', { n: 1 });
    log.close('paused');
    expect(sink.calls.map(([method]) => method)).toEqual(['opened', 'note', 'closed']);
    expect(sink.calls[1][1]).toEqual({ address: ROOT, at: expect.any(Number), kind: 'attempt', data: { n: 1 } });
    // An absent `meta` stays absent — no `meta: undefined` key on the entry.
    expect(Object.keys(sink.calls[0][1] as object).sort()).toEqual(['address', 'at', 'initialState']);
    expect(Object.keys(sink.calls[2][1] as object).sort()).toEqual(['address', 'at', 'commits', 'outcome']);
  });

  it('the commit is told AFTER the bundle is frozen and appended — the log never waits on the sink', () => {
    let seen: { frozen: boolean; length: number } | undefined;
    const log: EventLog = new EventLog(
      {},
      {
        address: ROOT,
        sink: {
          ...spySink(),
          commit: ({ bundle: b }) => {
            seen = { frozen: Object.isFrozen(b) && Object.isFrozen(b.overwrite), length: log.length };
          },
        },
      },
    );
    log.record(bundle('a', { x: { y: 1 } }));
    expect(seen).toEqual({ frozen: true, length: 1 });
  });

  it('the address is the log’s own — copied and frozen, so the caller’s array cannot rename it', () => {
    const drillPath = ['mount#1'];
    const sink = memorySink();
    const log = new EventLog({}, { sink, address: { logRunId: 'run-1', drillPath } });
    drillPath.push('forged#9');
    expect(log.address).toEqual({ logRunId: 'run-1', drillPath: ['mount#1'] });
    expect(Object.isFrozen(log.address)).toBe(true);
    expect(Object.isFrozen(log.address!.drillPath)).toBe(true);
    expect(sink.entries[0].address).toBe(log.address);
    // Bound once: the engine's later bind does not rename a log that writes to a sink.
    log.bindAddress('another-leg', []);
    expect(log.address).toEqual({ logRunId: 'run-1', drillPath: ['mount#1'] });
    expect(log.capturePosition('run-1')).toEqual({
      runId: 'run-1',
      logRunId: 'run-1',
      drillPath: ['mount#1'],
      committedThroughIdx: -1,
    });
  });
});

describe('EventLog with a sink — what the sink may keep', () => {
  it('the base is the sink’s own copy: editing it touches neither the log nor a later read', () => {
    const sink = memorySink();
    const log = new EventLog({ list: [1] }, { sink, address: ROOT });
    const opened = sink.entries[0] as Extract<RecordEntry, { kind: 'opened' }>;
    (opened.initialState.list as number[]).push(99);
    expect(log.getInitialState()).toEqual({ list: [1] });
  });

  it('meta and note data are copied when sent: a later edit by the writer does not rewrite the stored entry', () => {
    const sink = memorySink();
    const meta = { tries: [1] };
    const data = { attempt: { outcome: 'failed' } };
    const log = new EventLog({}, { sink, address: ROOT, meta });
    log.note('attempt', data);
    log.close('failed', meta);
    meta.tries.push(2);
    data.attempt.outcome = 'rewritten';
    const [opened, note, closed] = sink.entries as [
      Extract<RecordEntry, { kind: 'opened' }>,
      Extract<RecordEntry, { kind: 'note' }>,
      Extract<RecordEntry, { kind: 'closed' }>,
    ];
    expect(opened.meta).toEqual({ tries: [1] });
    expect(note.data).toEqual({ attempt: { outcome: 'failed' } });
    expect(closed.meta).toEqual({ tries: [1] });
  });

  it('the commit is the log’s own frozen bundle — and a bundle holding a Date is served, so the sink’s copy cannot reach the log', () => {
    const sink = memorySink();
    const log = new EventLog({}, { sink, address: ROOT });
    log.record(bundle('plain', { n: 1 }));
    log.record(bundle('dated', { when: new Date(5) }));
    const [, plain, dated] = sink.entries as Extract<RecordEntry, { kind: 'commit' }>[];
    expect(plain.bundle).toBe(log.recorded()[0]);
    expect(dated.bundle).not.toBe(log.recorded()[1]);
    (dated.bundle.overwrite.when as Date).setTime(99);
    expect((log.list()[1].overwrite.when as Date).getTime()).toBe(5);
  });

  it('memorySink keeps frozen entries and hands out a new array on each read', () => {
    const sink = memorySink();
    new EventLog({}, { sink, address: ROOT }).close('ok');
    const first = sink.entries;
    (first as RecordEntry[]).length = 0;
    expect(sink.entries).toHaveLength(2);
    expect(sink.entries).not.toBe(sink.entries);
    expect(sink.entries.every((e) => Object.isFrozen(e))).toBe(true);
  });

  it('memorySink stores a note’s own kind as `note`, beside the entry’s `kind`', () => {
    const sink = memorySink();
    sink.note({ address: ROOT, at: 7, kind: 'attempt', data: { n: 1 } });
    expect(sink.entries).toEqual([{ kind: 'note', address: ROOT, at: 7, note: 'attempt', data: { n: 1 } }]);
  });

  it('memorySink drains nothing: its flush resolves', async () => {
    await expect(memorySink().flush!()).resolves.toBeUndefined();
  });
});

describe('the one-argument log — unchanged', () => {
  it('has no address, calls no sink, and close / note / sinkFailures are inert', () => {
    const log = new EventLog({ a: 1 });
    log.record(bundle('a', { a: 2 }));
    log.note('attempt', { n: 1 });
    log.close('ok');
    expect(log.address).toBeUndefined();
    expect(log.sinkFailures).toBe(0);
    expect(log.length).toBe(1);
    log.clear();
    expect(log.length).toBe(0);
  });

  it('a stage written through RecordFrame gives the same bundle with and without a sink', () => {
    const write = (log: EventLog, state: SharedMemory) => {
      const frame = new RecordFrame(state, log);
      frame.useEncoding({ commitValues: 'delta', writeProvenance: 'reads-prefix' });
      frame.noteRead([], 'items');
      frame.write(frame.at([], 'items'), [...(frame.read([], 'items') as number[]), 2], 'set');
      frame.write(frame.at([], 'when'), new Date(3), 'set');
      frame.commit(() => ({ stage: 'Grow', stageId: 'grow', runtimeStageId: 'grow#0', tags: ['t'] }));
      frame.release();
      return log.list();
    };
    const plainState = new SharedMemory(undefined, { items: [1] });
    const sinkState = new SharedMemory(undefined, { items: [1] });
    const sink = memorySink();
    const plain = write(new EventLog(plainState.getState()), plainState);
    const withSink = write(new EventLog(sinkState.getState(), { sink, address: ROOT }), sinkState);
    expect(withSink).toEqual(plain);
    expect(JSON.stringify(withSink)).toBe(JSON.stringify(plain));
    expect((sink.entries[1] as Extract<RecordEntry, { kind: 'commit' }>).bundle).toEqual(plain[0]);
  });
});
