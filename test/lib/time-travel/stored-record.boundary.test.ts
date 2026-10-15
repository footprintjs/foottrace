/**
 * Boundary and security: what `readStoredRecord` (1.1.0) does with entries it cannot read — and with
 * entries written to hurt it. Stored entries are untrusted input.
 *
 *   boundary  nothing stored reads as no logs; every entry that cannot be read is listed in `unread` with
 *             its input position and its reason (verbatim — a reader branches on the code, prints the
 *             reason), and the rest of the record still reads; an unread commit leaves a gap in its log;
 *             a bigint, a symbol or a megabyte of string in a field is described, never thrown on
 *   limits    each default is pinned (entries 2^24, missing commits 2^20, drill depth 1,024, address
 *             length 65,536), each is enforced at its edge and refused BY NAME past it — an endless input
 *             stops at `entries`, a corrupted index or close cannot make the reader allocate past the gap
 *             budget (shared by every log of the record), a deep or long address is unread — and a limit
 *             the caller gives that is not a count is refused; a deep chain of nested logs at the depth
 *             limit reads in linear time, and a bundle nested 100,000 deep is never walked
 *             a cut or an early stop never adds or changes a claim (`complete`, `outcome`, `meta.closed`);
 *             the gap budget is spent on the logs that need the fewest first, so a corrupt log cannot starve
 *             the rest; 200,000 unread entries never overflow the stack
 *   security  an address is read by index, never through its own iterator (a lying or endless one); an
 *             entry whose fields throw is unread; a stored drill segment named `__proto__` is a key of the
 *             source's `subflowResults`, never its prototype; the reader never edits, freezes or copies the
 *             entries it is handed, and what it hands out (`commitLog`, `gaps`, `entries`) is frozen
 */
import { describe, expect, it } from 'vitest';

import type { LogAddress } from '../../../src/index.js';
import { HONESTY_CODES, readStoredRecord, timeTravel } from '../../../src/index.js';
import { DEFAULT_LIMITS } from '../../../src/lib/time-travel/storedRecord.js';
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
function clean(address: LogAddress = ROOT): RecordEntry[] {
  const sink = memorySink();
  const log = new EventLog({ n: 0 }, { sink, address });
  log.record(bundle(0));
  log.record(bundle(1));
  log.close('ok');
  return [...sink.entries];
}

/** A stored commit entry at `idx`, as storage gives it back. */
function commitAt(idx: number, address: LogAddress = ROOT) {
  return { kind: 'commit', address, at: 1, bundle: { ...bundle(idx), idx } };
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
    [
      // A hole in a sparse drill path is not a string either.
      { kind: 'opened', address: { logRunId: 'r', drillPath: [, 'b'] }, at, initialState: {} },
      'address.drillPath is not an array of strings',
    ],
    [{ kind: 'opened', address, initialState: {} }, 'at is missing, not a finite number'],
    [{ kind: 'opened', address, at: '2026', initialState: {} }, 'at is "2026", not a finite number'],
    [{ kind: 'opened', address, at }, 'initialState is missing, not a plain object'],
    [{ kind: 'opened', address, at, initialState: {}, meta: [1] }, 'meta is an array, not a plain object'],
    [{ kind: 'commit', address, at }, 'bundle is missing, not an object'],
    [{ kind: 'commit', address, at, bundle: { ...bundle(0) } }, 'bundle.idx is missing, not a commit index'],
    [{ kind: 'commit', address, at, bundle: { ...bundle(0), idx: -1 } }, 'bundle.idx is -1, not a commit index'],
    [{ kind: 'commit', address, at, bundle: { ...bundle(0), idx: 1.5 } }, 'bundle.idx is 1.5, not a commit index'],
    [{ kind: 'note', address, at, data: {} }, 'note is missing, not a string'],
    [{ kind: 'note', address, at, note: 'attempt', data: 'x' }, 'data is "x", not a plain object'],
    [{ kind: 'closed', address, at, commits: 0 }, 'outcome is missing, not ok | failed | paused'],
    [{ kind: 'closed', address, at, outcome: 'done', commits: 0 }, 'outcome is "done", not ok | failed | paused'],
    [{ kind: 'closed', address, at, outcome: 'ok' }, 'commits is missing, not a commit count'],
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
    expect(HONESTY_CODES['unread-entry']).toMatch(/^An entry a sink stored was not read into any log/);
  });

  it('an unread commit leaves a gap at its index in its log — the two signals agree', () => {
    const entries: unknown[] = clean();
    const commit = entries[1] as Extract<RecordEntry, { kind: 'commit' }>;
    entries[1] = { ...commit, at: null };
    const stored = readStoredRecord(entries);
    expect(stored.unread).toEqual([{ index: 1, reason: 'at is null, not a finite number' }]);
    expect(stored.root('run-1')!.gaps).toEqual([{ index: 0, reason: 'no readable commit entry for this index' }]);
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

describe('Limits: the reader’s work on untrusted input is bounded, and what a limit stops is named', () => {
  it('the defaults are pinned', () => {
    expect(DEFAULT_LIMITS).toEqual({
      entries: 2 ** 24,
      missingCommits: 2 ** 20,
      drillDepth: 1024,
      addressLength: 65_536,
    });
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
  });

  it('entries: an endless input stops at the limit, says so by name, and closes the iterator', () => {
    let closed = false;
    function* endless() {
      try {
        for (const entry of clean()) yield entry;
        for (;;) yield { kind: 'note', address: ROOT, at: 1, note: 'tick', data: {} };
      } finally {
        closed = true;
      }
    }
    const stored = readStoredRecord(endless(), { entries: 10 });
    expect(stored.unread).toEqual([
      { index: 10, reason: "entries from here on are past the reader's limit of 10; not read" },
    ]);
    expect(closed).toBe(true);
    expect(stored.root('run-1')!.notes).toHaveLength(6);
    // Exactly at the limit, nothing is past it.
    expect(readStoredRecord(clean(), { entries: 4 }).unread).toEqual([]);
  });

  it('missingCommits: a commit or a close that needs more gaps than the record holds is unread, by name — and the log is not complete', () => {
    const limit = (left: number) =>
      `past the reader's limit of 1048576 missing commits for the record (${left} were left for this log)`;
    // The default, at its edge without allocating: a close for 2^20 + 1 commits over an empty log.
    const overClosed = readStoredRecord([
      { kind: 'closed', address: ROOT, at: 1, outcome: 'ok', commits: 2 ** 20 + 1 },
    ]);
    expect(overClosed.unread).toEqual([{ index: 0, reason: `commits is 1048577, ${limit(1048576)}` }]);
    expect(overClosed.root('run-1')!).toMatchObject({ complete: false, commitLog: [], gaps: [] });
    // One corrupted index: past the gap budget, unread. The rest still reads — and the log is not
    // complete, because the reader did not read it whole.
    const corrupted = readStoredRecord([...clean(), commitAt(Number.MAX_SAFE_INTEGER)]);
    expect(corrupted.unread).toEqual([
      { index: 4, reason: `bundle.idx is ${Number.MAX_SAFE_INTEGER}, ${limit(1048576)}` },
    ]);
    expect(corrupted.root('run-1')!).toMatchObject({ complete: false, gaps: [], meta: {} });
    expect(corrupted.root('run-1')!.outcome).toBeUndefined();
    expect(corrupted.root('run-1')!.commitLog).toHaveLength(2);
  });

  it('a cut never adds or changes a claim: the smallest case, and an earlier close cannot speak for a cut one', () => {
    const closedEmpty = { kind: 'closed', address: ROOT, at: 1, outcome: 'ok', commits: 0 };
    expect(readStoredRecord([closedEmpty, commitAt(1)], { missingCommits: 1 }).root('run-1')!.complete).toBe(false);
    const cut = readStoredRecord([closedEmpty, commitAt(1)], { missingCommits: 0 });
    expect(cut.root('run-1')!).toMatchObject({ complete: false, commitLog: [] });
    expect(cut.unread.map((u) => u.index)).toEqual([1]);
    const paused = { kind: 'closed', address: ROOT, at: 1, outcome: 'paused', commits: 0 };
    const failed = { kind: 'closed', address: ROOT, at: 1, outcome: 'failed', commits: 3 };
    expect(readStoredRecord([paused, failed], { missingCommits: 3 }).root('run-1')).toMatchObject({
      complete: true,
      outcome: 'failed',
    });
    const short = readStoredRecord([paused, failed], { missingCommits: 2 }).root('run-1')!;
    expect(short.complete).toBe(false);
    expect(short.outcome).toBeUndefined();
  });

  it('missingCommits: one budget for the record, spent on the logs that need the fewest gaps first — a corrupt log cannot starve the rest', () => {
    const a: LogAddress = { logRunId: 'run-a', drillPath: [] };
    const b: LogAddress = { logRunId: 'run-b', drillPath: [] };
    // run-a arrives first and asks for 9 gaps (a corrupt index); run-b asks for 2.
    const entries = [commitAt(0, a), commitAt(10, a), commitAt(0, b), commitAt(3, b)];
    const stored = readStoredRecord(entries, { missingCommits: 5 });
    expect(stored.root('run-b')!.gaps.map((g) => g.index)).toEqual([1, 2]);
    // run-a gets the 3 that are left: not enough to reach its index 10, which is named, with what was left.
    expect(stored.root('run-a')!.commitLog).toHaveLength(1);
    expect(stored.unread).toEqual([
      {
        index: 1,
        reason:
          "bundle.idx is 10, past the reader's limit of 5 missing commits for the record (3 were left for this log)",
      },
    ]);
    // At the edge, both fit.
    expect(readStoredRecord(entries, { missingCommits: 11 }).unread).toEqual([]);
    // No gaps allowed: a log reads up to its first missing commit, and names the rest.
    const strict = readStoredRecord([commitAt(0), commitAt(1), commitAt(5)], { missingCommits: 0 });
    expect(strict.root('run-1')!.commitLog).toHaveLength(2);
    expect(strict.unread.map((u) => u.index)).toEqual([2]);
  });

  it('entries: once reading stops, no log reads complete — what was not read could have gone on', () => {
    const stored = readStoredRecord([...clean(), { kind: 'note', address: ROOT, at: 1, note: 'tick', data: {} }], {
      entries: 4,
    });
    expect(stored.unread).toEqual([
      { index: 4, reason: "entries from here on are past the reader's limit of 4; not read" },
    ]);
    expect(stored.root('run-1')!).toMatchObject({ complete: false, meta: {} });
    expect(stored.root('run-1')!.outcome).toBeUndefined();
  });

  it('a large unread list never overflows the stack — 200,000 second commit entries for one log', () => {
    const entries: unknown[] = clean();
    const second = { ...commitAt(0) };
    for (let i = 0; i < 200_000; i++) entries.push({ ...second });
    const stored = readStoredRecord(entries);
    expect(stored.unread).toHaveLength(200_000);
    expect(stored.unread[0]).toEqual({ index: 4, reason: 'a second commit entry for index 0 — the one at 1 stands' });
    expect(stored.root('run-1')!.complete).toBe(true);
  });

  it('drillDepth and addressLength: past the default, an address is unread — at it, it reads', () => {
    const deep = (n: number): LogAddress => ({
      logRunId: 'run-1',
      drillPath: Array.from({ length: n }, (_, i) => `m${i}#${i}`),
    });
    const long = (n: number): LogAddress => ({ logRunId: 'r'.repeat(n), drillPath: [] });
    const stored = readStoredRecord([
      ...clean(deep(1024)),
      ...clean(deep(1025)).slice(0, 1),
      ...clean(long(65_536)).slice(0, 1),
      ...clean(long(65_537)).slice(0, 1),
    ]);
    expect(stored.unread).toEqual([
      { index: 4, reason: "address.drillPath has 1025 segments, past the reader's limit of 1024" },
      { index: 6, reason: "address is longer than the reader's limit of 65536 characters" },
    ]);
    expect(stored.log(deep(1024))!.complete).toBe(true);
    expect(stored.root('r'.repeat(65_536))).toBeDefined();
    expect(stored.log(deep(1025))).toBeUndefined();
  });

  it('a limit that is not a count is refused at the door; Infinity lifts one', () => {
    for (const bad of [-1, 1.5, Number.NaN, '10', null]) {
      expect(() => readStoredRecord([], { entries: bad as number })).toThrow(RangeError);
      expect(() => readStoredRecord([], { drillDepth: bad as number })).toThrow(RangeError);
    }
    expect(readStoredRecord(clean(), { entries: Infinity, missingCommits: Infinity }).unread).toEqual([]);
  });

  it('a chain of 1,024 nested logs at the depth limit reads in linear time; every cursor drills', () => {
    const sink = memorySink();
    const path: string[] = [];
    const logs: EventLog[] = [new EventLog({}, { sink, address: ROOT })];
    for (let depth = 1; depth <= 1024; depth++) {
      path.push(`${'sf/'.repeat(4)}m${depth}#${depth}`);
      logs.push(new EventLog({}, { sink, address: { logRunId: 'run-1', drillPath: [...path] } }));
    }
    logs.forEach((log, i) => log.record(bundle(i)));
    const stored = readStoredRecord(sink.entries);
    expect(stored.logs.size).toBe(1025);
    const sources = [...stored.logs.values()].map((log) => log.source());
    // One flat map per run leg, shared by every cursor of the leg.
    expect(new Set(sources.map((s) => s.subflowResults)).size).toBe(1);
    expect(
      timeTravel(sources[0])
        .drill(path[1023])!
        .stops.map((s) => s.runtimeStageId),
    ).toEqual(['', 's1024#1024', '']);
  });

  it('a bundle nested 100,000 deep is never walked — a second entry for its index is listed, not compared', () => {
    const deepValue = () => {
      let value: Record<string, unknown> = {};
      for (let i = 0; i < 100_000; i++) value = { value };
      return value;
    };
    const deepCommit = () => ({ ...commitAt(0), bundle: { ...bundle(0), idx: 0, overwrite: { n: deepValue() } } });
    const first = deepCommit();
    const stored = readStoredRecord([first, deepCommit()]);
    expect(stored.unread).toEqual([{ index: 1, reason: 'a second commit entry for index 0 — the one at 0 stands' }]);
    expect(stored.root('run-1')!.commitLog[0]).toBe(first.bundle);
  });
});

describe('Security: entries are data — the reader never trusts an entry’s own behaviour', () => {
  it('an address is read by index, never through its own iterator: a lying or endless iterator neither bypasses the limits nor hangs', () => {
    const lying = Object.assign(['m#1'], {
      *[Symbol.iterator]() {
        for (let i = 0; i < 5000; i++) yield `forged#${i}`;
      },
    });
    const endless = Object.assign(['m#2'], {
      *[Symbol.iterator]() {
        for (;;) yield 'forever#0';
      },
    });
    const stored = readStoredRecord([
      { kind: 'note', address: { logRunId: 'run-1', drillPath: lying }, at: 1, note: 'n', data: {} },
      { kind: 'note', address: { logRunId: 'run-1', drillPath: endless }, at: 1, note: 'n', data: {} },
    ]);
    expect(stored.unread).toEqual([]);
    expect([...stored.logs.keys()]).toEqual(['["run-1","m#1"]', '["run-1","m#2"]']);
    expect(stored.log({ logRunId: 'run-1', drillPath: ['m#1'] })!.address.drillPath).toEqual(['m#1']);
  });

  it('an entry whose fields throw when read is unread, by name — the rest of the record still reads', () => {
    const throwing = Object.defineProperty({ address: ROOT, at: 1 }, 'kind', {
      enumerable: true,
      get() {
        throw new Error('hostile getter');
      },
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const stored = readStoredRecord([...clean(), throwing, revoked.proxy]);
    expect(stored.unread).toEqual([
      { index: 4, reason: 'the entry threw when it was read' },
      { index: 5, reason: 'the entry threw when it was read' },
    ]);
    expect(stored.root('run-1')!.complete).toBe(true);
  });

  it('a stored log’s commitLog is frozen, gaps or not — no reader can rewrite what every other reader sees', () => {
    const whole = readStoredRecord(clean()).root('run-1')!;
    const gapped = readStoredRecord(clean().filter((e) => !(e.kind === 'commit' && e.bundle.idx === 0))).root('run-1')!;
    expect(gapped.gaps.map((g) => g.index)).toEqual([0]);
    for (const log of [whole, gapped]) {
      expect(Object.isFrozen(log.commitLog)).toBe(true);
      expect(Object.isFrozen(log.gaps)).toBe(true);
      expect(Object.isFrozen(log.entries)).toBe(true);
    }
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

  it('the reader never edits, freezes or copies the entries it is handed — not the base, not the meta', () => {
    const entries = JSON.parse(JSON.stringify(clean())) as Record<string, unknown>[];
    (entries[0] as { meta?: unknown }).meta = { chart: 'pay' };
    const before = JSON.stringify(entries);
    const log = readStoredRecord(entries).root('run-1')!;
    expect(JSON.stringify(entries)).toBe(before);
    expect(entries.some((e) => Object.isFrozen(e) || Object.isFrozen(e.bundle ?? {}))).toBe(false);
    expect(log.entries[1]).toBe(entries[1]);
    expect(log.commitLog[0]).toBe(entries[1].bundle);
    expect(log.initialState).toBe(entries[0].initialState);
    expect(log.meta.opened).toBe((entries[0] as { meta: unknown }).meta);
  });
});
