/**
 * Boundary and security: what `readStoredRecord` (1.1.0) does with entries it cannot read — and with
 * entries written to hurt it.
 *
 *   boundary  nothing stored reads as no logs; every entry that cannot be read is listed in `unread` with
 *             its input position and its reason (verbatim — a reader branches on the code, prints the
 *             reason), and the rest of the record still reads; an unread commit leaves a gap in its log;
 *             a commit index or a close's `commits` past the reader's budget (2^24) is unread, so one
 *             corrupted number cannot make the reader allocate without bound; a bigint, a symbol or a
 *             megabyte of string in a field is described, never thrown on
 *   security  a stored drill segment named `__proto__` is a key of the source's `subflowResults`, never its
 *             prototype; the reader never edits, freezes or copies the entries it is handed
 */
import { describe, expect, it } from 'vitest';

import type { LogAddress } from '../../../src/index.js';
import { HONESTY_CODES, readStoredRecord, timeTravel } from '../../../src/index.js';
import type { RecordEntry } from '../../../src/write.js';
import { EventLog, memorySink } from '../../../src/write.js';

const ROOT: LogAddress = { logRunId: 'run-1', drillPath: [] };

function bundle(n: number) {
  return {
    stage: `s${n}`,
    stageId: `s${n}`,
    runtimeStageId: `s${n}#${n}`,
    trace: [{ path: 'n', verb: 'set' as const }],
    redactedPaths: [],
    overwrite: { n },
    updates: {},
  };
}

/** A clean record: opened, two commits, closed. */
function clean(): RecordEntry[] {
  const sink = memorySink();
  const log = new EventLog({ n: 0 }, { sink, address: ROOT });
  log.record(bundle(0));
  log.record(bundle(1));
  log.close('ok');
  return [...sink.entries];
}

describe('Boundary: nothing, or nothing readable', () => {
  it('no entries read as no logs and nothing unread', () => {
    const stored = readStoredRecord([]);
    expect(stored.logs.size).toBe(0);
    expect(stored.unread).toEqual([]);
    expect(stored.root('run-1')).toBeUndefined();
  });

  it('reads any iterable — a generator of parsed lines works like an array', () => {
    function* lines() {
      for (const entry of clean()) yield JSON.parse(JSON.stringify(entry));
    }
    expect(readStoredRecord(lines()).root('run-1')!.complete).toBe(true);
  });
});

describe('Boundary: an entry that cannot be read is listed, with its position and reason', () => {
  const at = 1;
  const address = ROOT;
  const cases: [unknown, string][] = [
    [null, 'not an object (null)'],
    [['opened'], 'not an object (array)'],
    ['{"kind":"commit"', 'not an object (string)'],
    [{ address, at }, 'kind is missing, not opened | commit | note | closed'],
    [{ kind: 'opend', address, at }, 'kind is "opend", not opened | commit | note | closed'],
    [{ kind: 'opened', at, initialState: {} }, 'address is missing, not a log address'],
    [{ kind: 'opened', address: { drillPath: [] }, at, initialState: {} }, 'address.logRunId is missing, not a string'],
    [
      { kind: 'opened', address: { logRunId: 'r', drillPath: ['a', 1] }, at, initialState: {} },
      'address.drillPath is not an array of strings',
    ],
    [{ kind: 'opened', address, initialState: {} }, 'at is missing, not a finite number'],
    [{ kind: 'opened', address, at: '2026', initialState: {} }, 'at is "2026", not a finite number'],
    [{ kind: 'opened', address, at }, 'initialState is missing, not a plain object'],
    [{ kind: 'opened', address, at, initialState: {}, meta: [1] }, 'meta is an array, not a plain object'],
    [{ kind: 'commit', address, at }, 'bundle is missing, not an object'],
    [
      { kind: 'commit', address, at, bundle: { ...bundle(0) } },
      'bundle.idx is missing, not a commit index below 16777216',
    ],
    [
      { kind: 'commit', address, at, bundle: { ...bundle(0), idx: -1 } },
      'bundle.idx is -1, not a commit index below 16777216',
    ],
    [
      { kind: 'commit', address, at, bundle: { ...bundle(0), idx: 1.5 } },
      'bundle.idx is 1.5, not a commit index below 16777216',
    ],
    [{ kind: 'note', address, at, data: {} }, 'note is missing, not a string'],
    [{ kind: 'note', address, at, note: 'attempt', data: 'x' }, 'data is "x", not a plain object'],
    [{ kind: 'closed', address, at, commits: 0 }, 'outcome is missing, not ok | failed | paused'],
    [{ kind: 'closed', address, at, outcome: 'done', commits: 0 }, 'outcome is "done", not ok | failed | paused'],
    [{ kind: 'closed', address, at, outcome: 'ok' }, 'commits is missing, not a commit count up to 16777216'],
    [{ kind: 'closed', address, at, outcome: 'ok', commits: 0, meta: 'x' }, 'meta is "x", not a plain object'],
  ];

  it.each(cases)('%j → %s', (row, reason) => {
    const stored = readStoredRecord([...clean(), row]);
    expect(stored.unread).toEqual([{ index: 4, reason }]);
    // The rest of the record still reads.
    expect(stored.root('run-1')!.complete).toBe(true);
    expect(stored.root('run-1')!.commitLog).toHaveLength(2);
  });

  it('the signal is registered: a reader explains `unread` from the one vocabulary', () => {
    expect(HONESTY_CODES['unread-entry']).toMatch(/^An entry a sink stored could not be read/);
  });

  it('an unread commit leaves a gap at its index in its log — the two signals agree', () => {
    const entries: unknown[] = clean();
    const commit = entries[1] as Extract<RecordEntry, { kind: 'commit' }>;
    entries[1] = { ...commit, at: null };
    const stored = readStoredRecord(entries);
    expect(stored.unread).toEqual([{ index: 1, reason: 'at is null, not a finite number' }]);
    expect(stored.root('run-1')!.gaps).toEqual([{ index: 0, reason: 'no readable commit entry for this index' }]);
  });
});

describe('Boundary: the reader’s budget — one corrupted number cannot make it allocate without bound', () => {
  it('a commit index or a close past 2^24 is unread, and the rest of the log still reads', () => {
    const big = { kind: 'commit', address: ROOT, at: 1, bundle: { ...bundle(9), idx: 2 ** 24 } };
    const huge = { kind: 'closed', address: ROOT, at: 1, outcome: 'ok', commits: Number.MAX_SAFE_INTEGER };
    const stored = readStoredRecord([...clean(), big, huge]);
    expect(stored.unread.map((u) => u.index)).toEqual([4, 5]);
    const log = stored.root('run-1')!;
    expect(log.commitLog).toHaveLength(2);
    expect(log.complete).toBe(true);
  });

  it('a value of any type in a field is described, never thrown on — a bigint, a symbol, a long string', () => {
    const long = 'x'.repeat(1_000_000);
    const rows = [
      { kind: 10n, address: ROOT, at: 1 },
      { kind: Symbol('k'), address: ROOT, at: 1 },
      { kind: long, address: ROOT, at: 1 },
      { kind: 'note', address: ROOT, at: 1, note: 'x', data: () => 1 },
    ];
    const stored = readStoredRecord(rows);
    expect(stored.unread.map((u) => u.reason)).toEqual([
      'kind is a bigint, not opened | commit | note | closed',
      'kind is a symbol, not opened | commit | note | closed',
      `kind is ${JSON.stringify(`${'x'.repeat(40)}…`)}, not opened | commit | note | closed`,
      'data is a function, not a plain object',
    ]);
  });
});

describe('Security: stored names are data', () => {
  it('a drill segment named __proto__ is a key of subflowResults, never its prototype', () => {
    const sink = memorySink();
    const root = new EventLog({}, { sink, address: ROOT });
    root.record(bundle(0));
    const hostile = new EventLog({}, { sink, address: { logRunId: 'run-1', drillPath: ['__proto__'] } });
    hostile.record(bundle(1));
    const source = readStoredRecord(sink.entries).root('run-1')!.source();
    const results = source.subflowResults as Record<string, unknown>;
    expect(Object.getPrototypeOf(results)).toBeNull();
    expect(Object.keys(results)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>).treeContext).toBeUndefined();
    expect(
      timeTravel(source)
        .drill('__proto__')!
        .stops.map((s) => s.runtimeStageId),
    ).toEqual(['', 's1#1', '']);
  });

  it('the reader never edits, freezes or copies the entries it is handed', () => {
    const entries = JSON.parse(JSON.stringify(clean())) as Record<string, unknown>[];
    const before = JSON.stringify(entries);
    const log = readStoredRecord(entries).root('run-1')!;
    expect(JSON.stringify(entries)).toBe(before);
    expect(entries.some((e) => Object.isFrozen(e) || Object.isFrozen(e.bundle ?? {}))).toBe(false);
    expect(log.entries[1]).toBe(entries[1]);
    expect(log.commitLog[0]).toBe(entries[1].bundle);
    expect(log.initialState).toBe(entries[0].initialState);
  });
});
