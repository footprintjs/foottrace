/**
 * Boundary: a failing sink never reaches the writer (1.1.0, ruling Q3) — a sink that throws, rejects, is
 * missing a method, or whose failure report fails; an entry the log refuses to send; a malformed address;
 * `clear()` on a log that writes to a sink.
 *
 * The law: the log's own record is complete whatever the sink does (the bundle is appended before the sink
 * is told), every entry the sink did not take is counted (`sinkFailures`) and reported to `onFailure` with
 * the entry and the error, and no call the writer makes — `new EventLog`, `record`, `note`, `close` — throws
 * because of the sink.
 */
import { describe, expect, it } from 'vitest';

import type { CommitBundle, LogAddress } from '../../../../src/index.js';
import { readStoredRecord, stateAt } from '../../../../src/index.js';
import type { RecordEntry, RecordSink } from '../../../../src/write.js';
import { EventLog, memorySink } from '../../../../src/write.js';

const ROOT: LogAddress = { logRunId: 'run-1', drillPath: [] };

function bundle(stage: string, n: number): CommitBundle {
  return {
    stage,
    stageId: stage,
    runtimeStageId: `${stage}#${n}`,
    trace: [{ path: 'n', verb: 'set' }],
    redactedPaths: [],
    overwrite: { n },
    updates: {},
  };
}

type Method = 'opened' | 'commit' | 'note' | 'closed';

/** A memory sink whose `method` fails as `how` says; every failure it is told of is kept. */
function failingSink(method: Method, how: (entry: unknown) => unknown) {
  const inner = memorySink();
  const failures: { entry: RecordEntry; error: unknown }[] = [];
  const sink: RecordSink & { readonly entries: readonly RecordEntry[] } = {
    get entries() {
      return inner.entries;
    },
    opened: method === 'opened' ? (how as RecordSink['opened']) : inner.opened,
    commit: method === 'commit' ? (how as RecordSink['commit']) : inner.commit,
    note: method === 'note' ? (how as RecordSink['note']) : inner.note,
    closed: method === 'closed' ? (how as RecordSink['closed']) : inner.closed,
    onFailure: (failure) => void failures.push(failure),
  };
  return { sink, failures };
}

/** Drive a log through every call a writer makes; none may throw. */
function drive(log: EventLog): void {
  log.record(bundle('a', 1));
  log.note('attempt', { n: 1 });
  log.record(bundle('b', 2));
  log.close('ok');
}

describe('Boundary: a sink that throws', () => {
  it.each(['opened', 'commit', 'note', 'closed'] as const)(
    'throwing on %s: the writer never sees it; it is counted, reported with its entry, and the log is whole',
    (method) => {
      const error = new Error(`${method} is down`);
      const { sink, failures } = failingSink(method, () => {
        throw error;
      });
      let log!: EventLog;
      expect(() => {
        log = new EventLog({ n: 0 }, { sink, address: ROOT });
        drive(log);
      }).not.toThrow();

      const lost = method === 'commit' ? 2 : 1;
      expect(log.sinkFailures).toBe(lost);
      expect(failures).toHaveLength(lost);
      expect(failures.every((f) => f.error === error && f.entry.kind === method)).toBe(true);
      // The log's own record does not depend on the sink.
      expect(log.length).toBe(2);
      expect(stateAt({ initialState: log.getInitialState(), commitLog: log.list() }, 1).state).toEqual({ n: 2 });
    },
  );

  it('a failure on one entry does not stop the next: the store reads a gap where the lost commit was', () => {
    const inner = memorySink();
    let commits = 0;
    const flaky: RecordSink = {
      opened: (entry) => inner.opened(entry),
      commit: (entry) => {
        if (commits++ === 0) throw new Error('blip');
        inner.commit(entry);
      },
      note: (entry) => inner.note(entry),
      closed: (entry) => inner.closed(entry),
    };
    const log = new EventLog({ n: 0 }, { sink: flaky, address: ROOT });
    drive(log);
    expect(log.sinkFailures).toBe(1);
    expect(inner.entries.map((e) => e.kind)).toEqual(['opened', 'note', 'commit', 'closed']);
    const stored = readStoredRecord(inner.entries).root('run-1')!;
    expect(stored.complete).toBe(true);
    expect(stored.gaps).toEqual([{ index: 0, reason: 'no readable commit entry for this index' }]);
    // The fold says the same about the same index — and still folds what landed after it.
    const folded = stateAt(stored.source(), 1);
    expect(folded.skipped).toEqual(stored.gaps);
    expect(folded.state).toEqual({ n: 2 });
  });

  it('a sink with no method for an entry is a failure, not a crash', () => {
    const partial = { opened: () => undefined } as unknown as RecordSink;
    const log = new EventLog({}, { sink: partial, address: ROOT });
    expect(() => drive(log)).not.toThrow();
    expect(log.sinkFailures).toBe(4);
  });
});

describe('Boundary: a sink that answers with a promise', () => {
  it('a rejection is counted and reported when it settles — never an unhandled rejection', async () => {
    const error = new Error('write failed');
    const { sink, failures } = failingSink('commit', () => Promise.reject(error));
    const log = new EventLog({}, { sink, address: ROOT });
    drive(log);
    expect(log.sinkFailures).toBe(0); // nothing has settled yet
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log.sinkFailures).toBe(2);
    expect(failures.map((f) => [f.entry.kind, f.error])).toEqual([
      ['commit', error],
      ['commit', error],
    ]);
  });

  it('a resolved promise is a delivered entry', async () => {
    const { sink } = failingSink('note', () => Promise.resolve());
    const log = new EventLog({}, { sink, address: ROOT });
    drive(log);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log.sinkFailures).toBe(0);
  });

  it('a thenable whose `then` throws is a failure, counted once', async () => {
    const hostile = {
      then() {
        throw new Error('hostile then');
      },
    };
    const { sink } = failingSink('closed', () => hostile);
    const log = new EventLog({}, { sink, address: ROOT });
    log.close('ok');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log.sinkFailures).toBe(1);
  });
});

describe('Boundary: the failure report itself fails', () => {
  it('an onFailure that throws or rejects changes nothing — the loss is still counted', async () => {
    const throwing: RecordSink = {
      ...memorySink(),
      commit: () => {
        throw new Error('down');
      },
      onFailure: () => {
        throw new Error('the reporter is down too');
      },
    };
    const rejecting: RecordSink = {
      ...memorySink(),
      commit: () => {
        throw new Error('down');
      },
      onFailure: (() => Promise.reject(new Error('async reporter down'))) as unknown as RecordSink['onFailure'],
    };
    for (const sink of [throwing, rejecting]) {
      const log = new EventLog({}, { sink, address: ROOT });
      expect(() => drive(log)).not.toThrow();
      expect(log.sinkFailures).toBe(2);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe('Boundary: an entry the log refuses to send', () => {
  it('note data that is not a plain object, or will not clone, is a lost entry — never a throw', () => {
    const { sink, failures } = failingSink('commit', () => undefined);
    const log = new EventLog({}, { sink, address: ROOT });
    const bad = [null, [1, 2], 'text', 7, { fn: () => 1 }, { sym: Symbol('s') }];
    for (const data of bad) expect(() => log.note('attempt', data as never)).not.toThrow();
    expect(() => log.note(42 as unknown as string, { n: 1 })).not.toThrow();
    expect(log.sinkFailures).toBe(bad.length + 1);
    expect(failures.map((f) => (f.error as Error).name)).toEqual([
      'TypeError',
      'TypeError',
      'TypeError',
      'TypeError',
      'DataCloneError',
      'DataCloneError',
      'TypeError',
    ]);
    expect(sink.entries.map((e) => e.kind)).toEqual(['opened']);
  });

  it('an unknown outcome or a meta that will not clone is a lost close — never a throw', () => {
    const { sink, failures } = failingSink('commit', () => undefined);
    const log = new EventLog({}, { sink, address: ROOT });
    expect(() => log.close('done' as never)).not.toThrow();
    expect(() => log.close('ok', { fn: () => 1 })).not.toThrow();
    expect(log.sinkFailures).toBe(2);
    expect(failures.map((f) => f.entry.kind)).toEqual(['closed', 'closed']);
    expect(sink.entries.map((e) => e.kind)).toEqual(['opened']);
  });

  it('an opened meta that will not clone loses the opened entry, not the log', () => {
    const sink = memorySink();
    const log = new EventLog({ n: 0 }, { sink, address: ROOT, meta: { fn: () => 1 } });
    log.record(bundle('a', 1));
    expect(log.sinkFailures).toBe(1);
    expect(sink.entries.map((e) => e.kind)).toEqual(['commit']);
    // Read back, the log has no base: its fold says so.
    expect(stateAt(readStoredRecord(sink.entries).root('run-1')!.source(), 0).basis).toBe('log-only');
  });
});

describe('Boundary: what the writer gets wrong is refused at the door', () => {
  it('a malformed address or a missing sink throws a TypeError from the constructor', () => {
    const sink = memorySink();
    for (const address of [
      undefined,
      {},
      { logRunId: 1, drillPath: [] },
      { logRunId: 'r', drillPath: 'x' },
      { logRunId: 'r', drillPath: [1] },
    ]) {
      expect(() => new EventLog({}, { sink, address: address as unknown as LogAddress })).toThrow(TypeError);
    }
    expect(() => new EventLog({}, { sink: undefined as unknown as RecordSink, address: ROOT })).toThrow(TypeError);
    expect(sink.entries).toEqual([]);
  });

  it('clear() refuses on a log that writes to a sink — the stored record cannot be wiped', () => {
    const sink = memorySink();
    const log = new EventLog({}, { sink, address: ROOT });
    log.record(bundle('a', 1));
    expect(() => log.clear()).toThrow(/stored record cannot be wiped/);
    expect(log.length).toBe(1);
    expect(log.address).toEqual(ROOT);
  });
});
