/**
 * `readRunEvidence`: every channel says `collected`, `partial` or `not-collected`.
 *
 *   old file       a 1.11.1 file reads not-collected, never "nothing happened"
 *   whole file     collected, and an empty channel means none happened
 *   broken file    a hole, a lost tail, a kill, a dropped field: partial, and empty means none seen
 */
import { describe, expect, it } from 'vitest';

import { engineScenario, evidenceStore, realOldFile, writeScenario } from '../../../test/helpers/evidenceFixture';
import { readStoredRecord, type StoredRecord } from '../time-travel/storedRecord';
import type { RecordEntry } from '../memory/sink';
import { readRunEvidence, type RunEvidence } from './read';

const ROOT = ['r'];
const evidenceOf = (entries: readonly unknown[], legs: string | readonly string[] = 'r'): RunEvidence =>
  readRunEvidence(readStoredRecord(entries), legs);

/** An entry with these fields gone: what an older adapter stores. */
function without(entries: RecordEntry[], ...fields: string[]): unknown[] {
  return entries.map((entry) => {
    const copy: Record<string, unknown> = { ...entry };
    for (const field of fields) delete copy[field];
    return copy;
  });
}

const CHANNELS = ['decisions', 'stops', 'reads', 'attention', 'stages', 'running'] as const;

function wholeRun() {
  const s = evidenceStore();
  s.commit(ROOT, 'seed#0', {});
  s.commit(ROOT, 'd#1', { parent: 'seed#0', reads: ['k'] });
  s.note(ROOT, 'run.decision', { id: 'd#1', by: 'plain', chosen: 'b' });
  s.commit(ROOT, 'b#2', { parent: 'd#1', description: 'The branch' });
  s.note(ROOT, 'run.stop', { id: 'b#2', by: 'break', reason: 'enough' });
  s.close(ROOT);
  return s;
}

describe('a file with no evidence reads not-collected', () => {
  it('a 1.11.1 file: every channel, and every control answer, with the reason', () => {
    const entries = without(wholeRun().entries(), 'collects', 'about', 'runNotes').filter(
      (entry) => (entry as RecordEntry).kind !== 'note',
    );
    const evidence = evidenceOf(entries);
    for (const name of CHANNELS) {
      expect(evidence[name]).toEqual({ status: 'not-collected', rows: [], why: 'no-collects' });
    }
    expect(evidence.control('b#2')).toEqual({ status: 'not-collected', gaps: [], why: 'no-collects' });
    expect(evidence.unread).toEqual([]);
  });

  it('a file the real footprintjs 11.0.0 and foottrace 1.11.1 wrote: not-collected, and the stored reader still reads it', () => {
    const entries = realOldFile();
    const stored = readStoredRecord(entries);
    const leg = (entries[0] as RecordEntry).address.logRunId;
    expect(stored.unread).toEqual([]);
    expect(stored.root(leg)!.complete).toBe(true);
    expect(stored.root(leg)!.outcome).toBe('failed');
    const evidence = readRunEvidence(stored, leg);
    for (const name of CHANNELS) {
      expect(evidence[name]).toEqual({ status: 'not-collected', rows: [], why: 'no-collects' });
    }
    expect(evidence.control('sub/in-two#3')).toEqual({ status: 'not-collected', gaps: [], why: 'no-collects' });
  });

  it('a stale evidence field on a log with no collects is not read at all', () => {
    const evidence = evidenceOf(without(wholeRun().entries(), 'collects'));
    expect(evidence.decisions.status).toBe('not-collected');
    expect(evidence.decisions.rows).toEqual([]);
  });

  it('a log from a newer writer: not-collected (newer-writer), its rows unread', () => {
    const entries = wholeRun()
      .entries()
      .map((entry) => (entry.kind === 'opened' ? { ...entry, collects: { v: 2, reads: 'keys' } } : entry));
    const evidence = evidenceOf(entries);
    expect(evidence.decisions).toEqual({ status: 'not-collected', rows: [], why: 'newer-writer' });
    expect(evidence.control('b#2').why).toBe('newer-writer');
  });

  it('a leg nobody stored: not-collected (no-log)', () => {
    expect(evidenceOf(wholeRun().entries(), 'other').decisions).toEqual({
      status: 'not-collected',
      rows: [],
      why: 'no-log',
    });
  });

  it('`reads: off` says the reads channel holds nothing, and only that channel', () => {
    const entries = wholeRun()
      .entries()
      .map((entry) => (entry.kind === 'opened' ? { ...entry, collects: { v: 1, reads: 'off' } } : entry));
    const evidence = evidenceOf(entries);
    expect(evidence.reads).toEqual({ status: 'not-collected', rows: [], why: 'reads-off' });
    expect(evidence.decisions.status).toBe('collected');
  });

  it('mixed logs: what was collected is there, and the channel is partial', () => {
    const s = evidenceStore();
    s.commit(ROOT, 'seed#0', {});
    s.close(ROOT);
    const old = without(
      (() => {
        const t = evidenceStore();
        t.commit(['r', 'm#1'], 'm/in#2', {});
        t.close(['r', 'm#1']);
        return t.entries();
      })(),
      'collects',
      'about',
      'runNotes',
    );
    const evidence = evidenceOf([...s.entries(), ...old]);
    expect(evidence.stages.status).toBe('partial');
    expect(evidence.stages.rows.map((row) => row.id)).toEqual(['seed#0']);
    expect((evidence.stages as { gaps: readonly string[] }).gaps).toEqual(['not-collected']);
  });
});

describe('a whole file reads collected', () => {
  it('holds each fact, with its log’s address', () => {
    const evidence = evidenceOf(wholeRun().entries());
    expect(evidence.decisions).toEqual({
      status: 'collected',
      rows: [{ seq: 0, id: 'd#1', by: 'plain', chosen: 'b', address: { logRunId: 'r', drillPath: [] } }],
    });
    expect(evidence.stops).toEqual({
      status: 'collected',
      rows: [{ seq: 1, id: 'b#2', by: 'break', reason: 'enough', address: { logRunId: 'r', drillPath: [] } }],
    });
    expect(evidence.reads.rows.map((row) => [row.id, row.keys])).toEqual([
      ['seed#0', []],
      ['d#1', ['k']],
      ['b#2', []],
    ]);
    expect(evidence.stages.rows.find((row) => row.id === 'b#2')).toMatchObject({
      parent: 'd#1',
      description: 'The branch',
      committed: true,
    });
    expect(evidence.unread).toEqual([]);
  });

  it('empty means none happened: no decision, no stop, no mark, nothing running', () => {
    const s = evidenceStore();
    s.commit(ROOT, 'seed#0', {});
    s.close(ROOT);
    const evidence = evidenceOf(s.entries());
    for (const name of ['decisions', 'stops', 'attention', 'running'] as const) {
      expect(evidence[name]).toEqual({ status: 'collected', rows: [] });
    }
  });

  it('a real run, end to end: every channel collected, and reads partial only for what its stages read untracked', () => {
    const scenario = engineScenario('agent');
    const evidence = evidenceOf(writeScenario(scenario), scenario.legs);
    for (const name of CHANNELS) {
      if (name !== 'reads') expect([name, evidence[name].status]).toEqual([name, 'collected']);
    }
    expect(evidence.reads).toMatchObject({ status: 'partial', gaps: ['untracked-input'] });
    expect(evidence.decisions.rows).toHaveLength(9);
    expect(evidence.stages.rows.length).toBeGreaterThanOrEqual(69);
    expect(evidence.unread).toEqual([]);
  });

  it('every row and list it hands out is frozen', () => {
    const evidence = evidenceOf(wholeRun().entries());
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.decisions)).toBe(true);
    expect(Object.isFrozen(evidence.decisions.rows)).toBe(true);
    expect(Object.isFrozen(evidence.decisions.rows[0])).toBe(true);
    expect(Object.isFrozen(evidence.reads.rows[1].keys)).toBe(true);
    expect(Object.isFrozen(evidence.control('b#2'))).toBe(true);
  });
});

describe('a broken file reads partial, and empty means none seen', () => {
  const gapsOf = (channel: { status: string }) => (channel as { gaps?: readonly string[] }).gaps;

  it('a run that never closed: partial, not-collected, and it keeps what landed', () => {
    const s = evidenceStore();
    s.commit(ROOT, 'seed#0', {});
    s.note(ROOT, 'run.stop', { id: 'seed#0', by: 'break' });
    const evidence = evidenceOf(s.entries());
    expect(evidence.stops.status).toBe('partial');
    expect(gapsOf(evidence.stops)).toEqual(['not-collected']);
    expect(evidence.stops.rows).toHaveLength(1);
    expect(evidence.decisions).toEqual({ status: 'partial', rows: [], gaps: ['not-collected'] });
  });

  it('a seq hole: partial', () => {
    const s = wholeRun();
    const entries = s.entries().filter((entry) => !(entry.kind === 'note' && entry.data.seq === 0));
    const evidence = evidenceOf(entries);
    expect(evidence.decisions).toEqual({ status: 'partial', rows: [], gaps: ['not-collected'] });
    expect(evidence.stops.status).toBe('partial');
  });

  it('a lost tail, shown only by closed.runNotes: partial', () => {
    const s = wholeRun();
    const entries = s.entries().filter((entry) => !(entry.kind === 'note' && entry.data.seq === 1));
    const evidence = evidenceOf(entries);
    expect(evidence.stops).toEqual({ status: 'partial', rows: [], gaps: ['not-collected'] });
  });

  it('a closed entry with no runNotes under collects: a tail nobody can vouch for', () => {
    const entries = wholeRun()
      .entries()
      .map((entry) => {
        if (entry.kind !== 'closed') return entry;
        const { runNotes: _dropped, ...rest } = entry;
        return rest;
      });
    expect(evidenceOf(entries).stops.status).toBe('partial');
  });

  it('a lost commit: partial', () => {
    const entries = wholeRun()
      .entries()
      .filter((entry) => !(entry.kind === 'commit' && entry.bundle.runtimeStageId === 'seed#0'));
    const evidence = evidenceOf(entries);
    expect(evidence.stages.status).toBe('partial');
    expect(evidence.decisions.status).toBe('partial');
  });

  it('an entry the store could not read: partial', () => {
    const evidence = evidenceOf([...wholeRun().entries(), { kind: 'torn' }]);
    expect(evidence.stages.status).toBe('partial');
    expect(gapsOf(evidence.stages)).toEqual(['not-collected']);
  });

  it('a stage whose about an adapter dropped: partial for the stage channels, per stage', () => {
    const entries = wholeRun()
      .entries()
      .map((entry) => {
        if (entry.kind !== 'commit' || entry.bundle.runtimeStageId !== 'd#1') return entry;
        const { about: _dropped, ...rest } = entry;
        return rest;
      });
    const evidence = evidenceOf(entries);
    expect(evidence.reads.status).toBe('partial');
    expect(evidence.attention.status).toBe('partial');
    expect(evidence.stages.status).toBe('partial');
    expect(evidence.reads.rows.map((row) => row.id)).toEqual(['seed#0', 'b#2']);
    expect(evidence.control('d#1').status).toBe('not-collected');
  });
});

describe('reads', () => {
  it('join bundle.untrackedSources, and that reads partial: the stage also read what no name shows', () => {
    const s = evidenceStore();
    s.commit(ROOT, 'seed#0', { reads: ['a'] }, { untrackedSources: ['args', 'env'] });
    s.close(ROOT);
    const { reads } = evidenceOf(s.entries());
    expect(reads.status).toBe('partial');
    expect((reads as { gaps: readonly string[] }).gaps).toEqual(['untracked-input']);
    expect(reads.rows[0]).toMatchObject({ id: 'seed#0', keys: ['a'], untracked: ['args', 'env'] });
  });

  it('untracked sources on a later bundle of the same execution join too', () => {
    const s = evidenceStore();
    s.commit(ROOT, 'seed#0', {});
    s.commit(ROOT, 'seed#0', undefined, { phase: 'repeat', untrackedSources: ['silent'] });
    s.close(ROOT);
    expect(evidenceOf(s.entries()).reads.rows[0]).toMatchObject({ untracked: ['silent'] });
  });

  it('readsOmitted reads partial (truncated)', () => {
    const s = evidenceStore();
    s.commit(ROOT, 'seed#0', { reads: ['a'], readsOmitted: 3 });
    s.close(ROOT);
    const { reads } = evidenceOf(s.entries());
    expect(reads.rows[0]).toMatchObject({ keys: ['a'], omitted: 3 });
    expect((reads as { gaps: readonly string[] }).gaps).toEqual(['truncated']);
  });

  it('reads are names, in first-read order, and a key name is never hidden', () => {
    const s = evidenceStore();
    s.commit(ROOT, 'seed#0', { reads: ['b', 'a', 'path\u001fnested'] });
    s.close(ROOT);
    expect(evidenceOf(s.entries()).reads.rows[0].keys).toEqual(['b', 'a', 'path\u001fnested']);
  });
});

describe('attention', () => {
  it('holds the marks a stage carried, per stage, and only those', () => {
    const marks = [{ kind: 'retried', reason: 'RETRY_RECORDED', evidence: ['attempt:s#1@1'] }] as const;
    const s = evidenceStore();
    s.commit(ROOT, 'seed#0', {});
    s.commit(ROOT, 's#1', { parent: 'seed#0', attention: marks });
    s.close(ROOT);
    const { attention } = evidenceOf(s.entries());
    expect(attention.status).toBe('collected');
    expect(attention.rows.map((row) => [row.id, row.marks])).toEqual([['s#1', marks]]);
  });
});

describe('what was running when a run ended', () => {
  const run = () => engineScenario('resume-fresh');
  const cutBefore = (match: (row: ReturnType<typeof run>['rows'][number]) => boolean) => {
    const scenario = run();
    return writeScenario(scenario, scenario.rows.findIndex(match));
  };

  it('a kill inside two subflows names the innermost; the leaf stage stays unknown', () => {
    const entries = cutBefore((row) => row.kind === 'note' && row.note === 'run.stop');
    const evidence = evidenceOf(entries, 'run-1');
    expect(evidence.running.status).toBe('partial');
    expect(evidence.running.rows.map((row) => row.id)).toEqual(['go/deep#4']);
    expect(evidence.running.rows[0].address).toEqual({ logRunId: 'run-1', drillPath: ['go#2', 'go/deep#4'] });
    // The inner chain resolves through the mounts' run.stage notes, with none of their bundles landed.
    expect(evidence.control('go/deep/ask#5')).toMatchObject({ decider: 'gate#1', status: 'partial' });
    expect(evidence.stages.rows.find((row) => row.id === 'go#2')).toMatchObject({ committed: false });
  });

  it('two parallel mounts open at the same depth are both named', () => {
    const s = evidenceStore();
    s.commit(ROOT, 'seed#0', {});
    s.note(ROOT, 'run.stage', { id: 'a#1', parent: 'seed#0' });
    s.note(ROOT, 'run.stage', { id: 'b#2', parent: 'seed#0' });
    s.commit(['r', 'a#1'], 'a/x#3', { parent: 'a#1' });
    s.commit(['r', 'b#2'], 'b/y#4', { parent: 'b#2' });
    expect(
      evidenceOf(s.entries())
        .running.rows.map((row) => row.id)
        .sort(),
    ).toEqual(['a#1', 'b#2']);
  });

  it('a kill at the root: nothing named, partial, so empty never reads as nothing running', () => {
    const s = evidenceStore();
    s.commit(ROOT, 'seed#0', {});
    expect(evidenceOf(s.entries()).running).toEqual({ status: 'partial', rows: [], gaps: ['not-collected'] });
  });

  it('a paused run closed its logs: nothing running, and the stop says what it asked', () => {
    const scenario = run();
    const cut = scenario.rows.findIndex((row) => row.kind === 'opened' && row.log[0] === 'run-2');
    const evidence = evidenceOf(writeScenario(scenario, cut), 'run-1');
    expect(evidence.running).toEqual({ status: 'collected', rows: [] });
    expect(evidence.stops.rows[0]).toMatchObject({
      id: 'go/deep/ask#5',
      by: 'pause',
      payload: { question: 'approve?' },
    });
  });

  it('a same-executor resume: seq continues, the second close carries the larger count, nothing is a hole', () => {
    const scenario = engineScenario('resume-same');
    const entries = writeScenario(scenario);
    const closed = entries.filter((e) => e.kind === 'closed' && e.address.drillPath.length === 0);
    expect(closed.map((e) => (e as { runNotes?: number }).runNotes)).toEqual([2, 3]);
    const evidence = evidenceOf(entries, scenario.legs);
    expect(evidence.stops.status).toBe('collected');
    expect(evidence.decisions.status).toBe('collected');
  });
});

describe('legs', () => {
  it('a list of legs reads both; a lone string reads one', () => {
    const scenario = engineScenario('resume-fresh');
    const stored: StoredRecord = readStoredRecord(writeScenario(scenario));
    expect(readRunEvidence(stored, ['run-1', 'run-2']).stages.rows.map((row) => row.id)).toContain('go#6');
    expect(readRunEvidence(stored, 'run-2').stages.rows.map((row) => row.id)).not.toContain('gate#1');
  });

  it.each([[7], [[7]], [undefined], [Array(65).fill('leg')]])('refuses %j: a caller’s mistake', (legs) => {
    expect(() => readRunEvidence(readStoredRecord([]), legs as never)).toThrow(TypeError);
  });

  it('refuses a limit that is not a count', () => {
    expect(() => readRunEvidence(readStoredRecord([]), 'r', { rules: -1 })).toThrow(RangeError);
  });
});
