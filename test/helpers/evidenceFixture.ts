/**
 * Writes a run's evidence through the real `foottrace/write` doors and hands back what a file would hold: entries through
 * a JSON round trip. The reader's tests read that, never a hand-built shape, unless a test forges a row on purpose.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { CommitBundle, LogAddress } from '../../src/index';
import type { CommitAbout, RecordEntry, RunNoteData, RunNoteKind } from '../../src/write';
import { EventLog, memorySink } from '../../src/write';

/** One row of a captured scenario (test/fixtures/run-evidence/README.md). */
export type FixtureRow =
  | { kind: 'opened'; log: string[] }
  | { kind: 'commit'; log: string[]; id: string; phase?: 'exit' | 'repeat'; untracked?: string[]; about?: CommitAbout }
  | { kind: 'note'; log: string[]; note: RunNoteKind; data: RunNoteData[RunNoteKind] }
  | { kind: 'closed'; log: string[]; outcome: 'ok' | 'failed' | 'paused' };

export interface FixtureScenario {
  legs: string[];
  rows: FixtureRow[];
  live: Record<string, { decider: string; label?: string } | null>;
  resumed?: string[];
}

export function engineScenario(name: string): FixtureScenario {
  const file = join(resolve(__dirname, '../fixtures/run-evidence'), 'engine-11.0.0.json');
  return JSON.parse(readFileSync(file, 'utf8')).scenarios[name];
}

/** A whole file the real `fileSink` wrote under footprintjs 11.0.0 and foottrace 1.11.1, parsed line by line. */
export function realOldFile(): unknown[] {
  const file = join(resolve(__dirname, '../fixtures/run-evidence'), 'real-1.11.1.jsonl');
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

export function bundleFor(id: string, extra: Partial<CommitBundle> = {}): CommitBundle {
  const stageId = id.includes('#') ? id.slice(0, id.lastIndexOf('#')) : id;
  return {
    stage: stageId,
    stageId,
    runtimeStageId: id,
    trace: [],
    redactedPaths: [],
    overwrite: {},
    updates: {},
    ...extra,
  };
}

const addressOf = (log: readonly string[]): LogAddress => ({ logRunId: log[0], drillPath: log.slice(1) });

/** A store of logs written through the real writer. Rows stay in the order they were written, across logs. */
export function evidenceStore() {
  const sink = memorySink();
  const logs = new Map<string, EventLog>();
  const logAt = (log: readonly string[]): EventLog => {
    const key = JSON.stringify(log);
    let held = logs.get(key);
    if (held === undefined) {
      held = new EventLog({}, { sink, address: addressOf(log), collects: { reads: 'keys' } });
      logs.set(key, held);
    }
    return held;
  };
  return {
    logAt,
    commit(log: readonly string[], id: string, about?: CommitAbout, extra?: Partial<CommitBundle>) {
      logAt(log).record(bundleFor(id, extra), about);
    },
    note<K extends RunNoteKind>(log: readonly string[], kind: K, data: RunNoteData[K]) {
      logAt(log).noteRun(kind, data);
    },
    close(log: readonly string[], outcome: 'ok' | 'failed' | 'paused' = 'ok') {
      logAt(log).close(outcome);
    },
    /** Exactly what a file holds: each entry after JSON. */
    entries(): RecordEntry[] {
      return JSON.parse(JSON.stringify(sink.entries));
    },
  };
}

/** A captured scenario, written through the real writer, up to `until` rows. */
export function writeScenario(scenario: FixtureScenario, until = scenario.rows.length): RecordEntry[] {
  const store = evidenceStore();
  for (const row of scenario.rows.slice(0, until)) {
    if (row.kind === 'opened') store.logAt(row.log);
    else if (row.kind === 'commit') {
      store.commit(row.log, row.id, row.about, {
        ...(row.phase ? { phase: row.phase } : {}),
        ...(row.untracked ? { untrackedSources: row.untracked as CommitBundle['untrackedSources'] } : {}),
      });
    } else if (row.kind === 'note') store.note(row.log, row.note, row.data);
    else store.close(row.log, row.outcome);
  }
  return store.entries();
}
