/**
 * Reading a sink's entries back (1.1.0) — `readStoredRecord` → `StoredRecord` / `StoredLog` / `source()`.
 *
 * Every record here is WRITTEN through `foottrace/write` with a `memorySink` (test/helpers/recordRun.ts) —
 * the entries a real writer leaves — and read back, live and through a JSON round trip.
 *
 *   unit      grouped by address (root, mounts, two run legs, interleaved), each log in arrival order;
 *             `root` / `log` lookups; `complete`, `outcome` and `meta` from the covering close; notes in
 *             arrival order; a log with no `opened` has no base
 *   scenario  a run killed mid-flight reads `complete: false`, still returns its notes, and folds what
 *             landed; a lost commit, a lost LAST commit (seen through `closed.commits`), two stored commits
 *             that disagree and an unreadable bundle are gaps the fold reports with the same reason; a
 *             log closed and then gone on is not complete until it closes again; the cursor marks a stored
 *             mount and `drill` opens its own stored log, two deep; a paused leg and its resumed leg chain
 *             as one axis
 */
import { describe, expect, it } from 'vitest';

import type { LogAddress } from '../../../src/index.js';
import { readStoredRecord, stateAt, timeTravel } from '../../../src/index.js';
import type { RecordEntry } from '../../../src/write.js';
import { EventLog, memorySink } from '../../../src/write.js';
import { recordRun } from '../../helpers/recordRun.js';

const ROOT: LogAddress = { logRunId: 'run-1', drillPath: [] };

/** A JSON round trip — what a file or a table gives back. */
function throughJson(entries: readonly RecordEntry[]): unknown[] {
  return JSON.parse(JSON.stringify(entries)) as unknown[];
}

/** collect → decide → report, written with a sink at `address`; closed with `outcome` unless `crash`. */
function writeRun(address: LogAddress = ROOT, { crash = false } = {}) {
  const sink = memorySink();
  const run = recordRun({ tenant: 'T-1' }, {}, { sink, address, meta: { chart: 'triage' } });
  run.step('collect', (s) => s.set('events', ['collected']));
  run.log.note('attempt', { attempt: 1, outcome: 'timeout' });
  run.log.note('attempt', { attempt: 2, outcome: 'ok' });
  run.step('decide', (s) => s.set('verdict', s.read('tenant') === 'T-1' ? 'allow' : 'review'));
  if (!crash) {
    run.step('report', (s) => s.set('report', `${s.read('verdict')}`));
    run.log.close('ok', { durationMs: 12 });
  }
  return { sink, run };
}

describe('readStoredRecord — the logs, by address', () => {
  it('a finished run reads back whole: base, bundles, notes, complete, outcome and both metas', () => {
    const { sink, run } = writeRun();
    for (const entries of [sink.entries, throughJson(sink.entries)]) {
      const stored = readStoredRecord(entries);
      expect(stored.unread).toEqual([]);
      expect([...stored.logs.keys()]).toEqual(['["run-1"]']);
      const log = stored.root('run-1')!;
      expect(log.address).toEqual(ROOT);
      expect(log.initialState).toEqual({ tenant: 'T-1' });
      expect(log.commitLog).toEqual(run.log.list());
      expect(log.gaps).toEqual([]);
      expect(log.complete).toBe(true);
      expect(log.outcome).toBe('ok');
      expect(log.meta).toEqual({ opened: { chart: 'triage' }, closed: { durationMs: 12 } });
      expect(log.notes.map((n) => [n.kind, n.data])).toEqual([
        ['attempt', { attempt: 1, outcome: 'timeout' }],
        ['attempt', { attempt: 2, outcome: 'ok' }],
      ]);
      expect(log.entries.map((e) => e.kind)).toEqual([
        'opened',
        'commit',
        'note',
        'note',
        'commit',
        'commit',
        'closed',
      ]);
      // The fold over the stored log is the fold over the live one.
      expect(stateAt(log.source(), 2)).toEqual(stateAt(run.snapshot(), 2));
      expect(log.source()).toBe(log.source());
    }
  });

  it('interleaved logs of two legs and a mount are regrouped, each in its own arrival order', () => {
    const sink = memorySink();
    const mount: LogAddress = { logRunId: 'run-1', drillPath: ['sf#1'] };
    const root = recordRun({}, {}, { sink, address: ROOT });
    root.step('seed', (s) => s.set('given', 21));
    const inner = recordRun({}, {}, { sink, address: mount });
    inner.step('sf', (s) => s.set('given', 21), { runtimeStageId: 'sf#1' });
    const other = recordRun({}, {}, { sink, address: { logRunId: 'run-2', drillPath: [] } });
    other.step('solo', (s) => s.set('x', 1));
    inner.step('sf/double', (s) => s.set('doubled', 42), { runtimeStageId: 'sf/double#2' });
    inner.log.close('ok');
    root.step('sf', (s) => s.set('doubled', 42));
    root.log.close('ok');

    const stored = readStoredRecord(sink.entries);
    expect([...stored.logs.keys()]).toEqual(['["run-1"]', '["run-1","sf#1"]', '["run-2"]']);
    expect(stored.log(mount)!.commitLog.map((b) => b.runtimeStageId)).toEqual(['sf#1', 'sf/double#2']);
    expect(stored.root('run-1')!.commitLog.map((b) => b.runtimeStageId)).toEqual(['seed#0', 'sf#1']);
    expect(stored.root('run-2')!.complete).toBe(false);
    expect(stored.root('run-3')).toBeUndefined();
    expect(stored.log({ logRunId: 'run-1', drillPath: ['nope#9'] })).toBeUndefined();
    expect(stored.log({ logRunId: 'run-1' } as unknown as LogAddress)).toBeUndefined();
  });

  it('a log whose opened entry was not stored has no base — its fold says log-only', () => {
    const { sink } = writeRun();
    const withoutOpened = sink.entries.filter((e) => e.kind !== 'opened');
    const log = readStoredRecord(withoutOpened).root('run-1')!;
    expect(log.initialState).toBeUndefined();
    expect(log.meta).toEqual({ closed: { durationMs: 12 } });
    expect(stateAt(log.source(), 2).basis).toBe('log-only');
  });
});

describe('a run that never closed', () => {
  it('reads complete: false, keeps its notes, and folds what landed', () => {
    const { sink, run } = writeRun(ROOT, { crash: true });
    for (const entries of [sink.entries, throughJson(sink.entries)]) {
      const log = readStoredRecord(entries).root('run-1')!;
      expect(log.complete).toBe(false);
      expect(log.outcome).toBeUndefined();
      expect(log.meta).toEqual({ opened: { chart: 'triage' } });
      expect(log.notes.map((n) => n.data)).toEqual([
        { attempt: 1, outcome: 'timeout' },
        { attempt: 2, outcome: 'ok' },
      ]);
      expect(log.notes.every((n) => typeof n.at === 'number')).toBe(true);
      expect(log.gaps).toEqual([]);
      const cursor = timeTravel(log.source());
      expect(cursor.stops.map((s) => s.stageId)).toEqual(['', 'collect', 'decide', '']);
      cursor.last();
      expect(cursor.stateAt().state).toEqual(run.state.getState());
    }
  });

  it('a log closed and then gone on is not complete until it closes again', () => {
    const sink = memorySink();
    const run = recordRun({}, {}, { sink, address: ROOT });
    run.step('ask', (s) => s.set('q', 1));
    run.log.close('paused', { at: 'ask' });
    run.step('answer', (s) => s.set('a', 2));
    const reopened = readStoredRecord(sink.entries).root('run-1')!;
    expect(reopened.complete).toBe(false);
    expect(reopened.outcome).toBeUndefined();
    expect(reopened.meta.closed).toBeUndefined();

    run.log.close('ok');
    const finished = readStoredRecord(sink.entries).root('run-1')!;
    expect([finished.complete, finished.outcome]).toEqual([true, 'ok']);
    expect(finished.entries.filter((e) => e.kind === 'closed')).toHaveLength(2);
  });
});

describe('what the store lost — a gap at its own index, never a shifted log', () => {
  it('a lost commit is a gap; every later commit keeps its index; the fold reports the same reason', () => {
    const { sink } = writeRun();
    const lost = sink.entries.filter((e) => !(e.kind === 'commit' && e.bundle.idx === 1));
    const log = readStoredRecord(lost).root('run-1')!;
    expect(log.complete).toBe(true);
    expect(log.gaps).toEqual([{ index: 1, reason: 'no readable commit entry for this index' }]);
    expect(log.commitLog.map((b) => b.runtimeStageId)).toEqual(['collect#0', '', 'report#2']);
    const folded = stateAt(log.source(), 2);
    expect(folded.skipped).toEqual(log.gaps);
    expect(folded.state.verdict).toBeUndefined();
    expect(folded.state.report).toBe('allow');
  });

  it('a lost LAST commit is seen through closed.commits — a closed log the store did not keep whole', () => {
    const { sink } = writeRun();
    const lost = sink.entries.filter((e) => !(e.kind === 'commit' && e.bundle.idx === 2));
    const log = readStoredRecord(lost).root('run-1')!;
    expect(log.complete).toBe(true);
    expect(log.commitLog).toHaveLength(3);
    expect(log.gaps).toEqual([{ index: 2, reason: 'no readable commit entry for this index' }]);
  });

  it('two stored commits that disagree about one index are a gap; a redelivered copy is not', () => {
    const { sink } = writeRun();
    const [first] = sink.entries.filter((e) => e.kind === 'commit') as Extract<RecordEntry, { kind: 'commit' }>[];
    const redelivered = readStoredRecord([...sink.entries, ...throughJson([first])]).root('run-1')!;
    expect(redelivered.gaps).toEqual([]);
    expect(redelivered.complete).toBe(true);

    const forged = { ...first, bundle: { ...first.bundle, overwrite: { events: ['forged'] } } };
    const disagreeing = readStoredRecord([...sink.entries, forged]).root('run-1')!;
    expect(disagreeing.gaps).toEqual([{ index: 0, reason: 'commit entries for this index disagree' }]);
    expect(stateAt(disagreeing.source(), 2).skipped).toEqual(disagreeing.gaps);
  });

  it('a bundle the reader cannot read keeps its index and its own reason, in the log and in the fold', () => {
    const { sink } = writeRun();
    const entries = throughJson(sink.entries) as { kind: string; bundle?: { idx: number; trace?: unknown } }[];
    delete entries.find((e) => e.kind === 'commit' && e.bundle!.idx === 1)!.bundle!.trace;
    const log = readStoredRecord(entries).root('run-1')!;
    expect(log.gaps).toEqual([{ index: 1, reason: 'trace is missing, not an array' }]);
    expect(stateAt(log.source(), 2).skipped).toEqual(log.gaps);
  });
});

describe('stored mounts — the cursor and drill read the stored structure', () => {
  /** seed → a mount `sf#1` whose log holds a nested mount `sf/in#3`, each its own stored log. */
  function writeNested() {
    const sink = memorySink();
    const outer: LogAddress = { logRunId: 'run-1', drillPath: ['sf#1'] };
    const nested: LogAddress = { logRunId: 'run-1', drillPath: ['sf#1', 'sf/in#3'] };
    const root = recordRun({}, {}, { sink, address: ROOT });
    root.step('seed', (s) => s.set('given', 21));
    const sf = recordRun({}, {}, { sink, address: outer });
    sf.step('sf', (s) => s.set('given', 21), { runtimeStageId: 'sf#1' });
    sf.step('sf/double', (s) => s.set('doubled', 42), { runtimeStageId: 'sf/double#2' });
    const inner = recordRun({}, {}, { sink, address: nested });
    inner.step('sf/in', (s) => s.set('doubled', 42), { runtimeStageId: 'sf/in#3' });
    inner.step('sf/in/check', (s) => s.set('ok', true), { runtimeStageId: 'sf/in/check#4' });
    inner.log.close('ok');
    sf.step('sf/in', (s) => s.set('ok', true), { runtimeStageId: 'sf/in#3' });
    sf.log.close('ok');
    root.step('sf', (s) => s.set('ok', true));
    root.log.close('ok');
    return sink;
  }

  it('marks the stored mount as a mount stop and drills into its own stored log — two deep', () => {
    const sink = writeNested();
    for (const entries of [sink.entries, throughJson(sink.entries)]) {
      const cursor = timeTravel(readStoredRecord(entries).root('run-1')!.source());
      expect(cursor.stops.map((s) => [s.kind, s.runtimeStageId])).toEqual([
        ['start', ''],
        ['commit', 'seed#0'],
        ['mount', 'sf#1'],
        ['end', ''],
      ]);
      const sf = cursor.drill('sf#1')!;
      expect(sf.path).toBe('sf');
      expect(sf.stops.map((s) => [s.kind, s.runtimeStageId])).toEqual([
        ['start', ''],
        ['commit', 'sf/double#2'],
        ['mount', 'sf/in#3'],
        ['end', ''],
      ]);
      const inner = sf.drill('sf/in#3')!;
      inner.last();
      expect(inner.stateAt().state).toEqual({ doubled: 42, ok: true });
      expect(cursor.drill('nope#9')).toBeUndefined();
    }
  });

  it('a log with nothing stored under it carries no subflowResults', () => {
    const { sink } = writeRun();
    expect(Object.keys(readStoredRecord(sink.entries).root('run-1')!.source()).sort()).toEqual([
      'commitLog',
      'initialState',
    ]);
  });
});

describe('two run legs — a pause and its resume, read as one axis', () => {
  it('the paused root log and the resumed root log chain through timeTravel', () => {
    const sink = memorySink();
    const paused = recordRun({ n: 0 }, {}, { sink, address: { logRunId: 'leg-1', drillPath: [] } });
    paused.step('ask', (s) => s.set('n', 1));
    paused.log.close('paused');
    // The resumed leg starts from the state at the pause, and numbers on from the pause's counter.
    const resumed = new EventLog(paused.state.getState(), { sink, address: { logRunId: 'leg-2', drillPath: [] } });
    resumed.record({
      stage: 'answer',
      stageId: 'answer',
      runtimeStageId: 'answer#1',
      trace: [{ path: 'n', verb: 'set' }],
      redactedPaths: [],
      overwrite: { n: 2 },
      updates: {},
    });
    resumed.close('ok');

    const stored = readStoredRecord(sink.entries);
    const legs = [stored.root('leg-1')!, stored.root('leg-2')!];
    expect(legs.map((l) => l.outcome)).toEqual(['paused', 'ok']);
    const chained = timeTravel(legs.map((l) => l.source()));
    expect(chained.stops.map((s) => s.runtimeStageId)).toEqual(['', 'ask#0', 'answer#1', '']);
    chained.last();
    expect(chained.stateAt().state).toEqual({ n: 2 });
  });
});
