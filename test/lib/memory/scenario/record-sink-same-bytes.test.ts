/**
 * Scenario: a sink moves no byte (1.1.0) — the hcifootprint 2.6.1 sessions (test/fixtures/hcifootprint/), replayed
 * through `foottrace/write` with a `memorySink` attached and notes written between the steps, give the PINNED
 * bytes: the log's, and the stored record's read back through `readStoredRecord` from the sink's own entries.
 * (Not through JSON: these sessions hold Date / Map / Set values, which JSON does not keep — a JSON round trip
 * of stored entries is covered by the stored-record tests over JSON-safe runs.)
 *
 * The pinned file itself is untouched; its own test (hcifootprint-2.6.1.test.ts) still replays the one-argument
 * log. Both encodings, a redacted write, Date / Map / Set and a commit out of mint order are in the sessions.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readStoredRecord, serveRecord, stateAt } from '../../../../src/index.js';
import type { RecordEntry, RecordEncoding, WriteScrub } from '../../../../src/write.js';
import { EventLog, memorySink, RecordFrame, SharedMemory } from '../../../../src/write.js';
import { pinnedText, revive } from '../../../fixtures/bytes.js';

interface Session {
  name: string;
  open: { initialState: unknown; commitValues: 'full' | 'delta'; writeProvenance: 'off' | 'reads-prefix' };
  transitions: {
    stage: string;
    stageId: string;
    runtimeStageId: string;
    reads: string[];
    writes: [string, unknown, boolean][];
  }[];
  recorded: { commitLog: unknown; initialState: unknown };
}

const FILE = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/hcifootprint/transitions-2.6.1.json');
const { sessions } = JSON.parse(readFileSync(FILE, 'utf8')) as { sessions: Session[] };
const REDACT_WHOLE: WriteScrub = Object.freeze({ whole: true });

/** The fixture's replay (hcifootprint-2.6.1.test.ts), with a sink on the log and a note after every step. */
function replayWithSink({ name, open, transitions }: Session) {
  const sink = memorySink();
  const address = { logRunId: name, drillPath: [] };
  const state = new SharedMemory(undefined, revive(open.initialState));
  const log = new EventLog(state.getState(), { sink, address, meta: { session: name } });
  const encoding: RecordEncoding = { commitValues: open.commitValues, writeProvenance: open.writeProvenance };
  for (const t of transitions) {
    const frame = new RecordFrame(state, log);
    frame.useEncoding(encoding);
    for (const key of t.reads) frame.noteRead([], key);
    for (const [key, value, redact] of t.writes) {
      frame.write(frame.at([], key), revive(value), 'set', redact ? REDACT_WHOLE : undefined);
    }
    frame.commit(() => ({ stage: t.stage, stageId: t.stageId, runtimeStageId: t.runtimeStageId }));
    log.note('step', { runtimeStageId: t.runtimeStageId });
  }
  log.close('ok');
  return { log, entries: sink.entries, address };
}

describe('a sink moves no byte — the hcifootprint 2.6.1 sessions', () => {
  it.each(sessions.map((s) => [s.name, s] as const))('%s', (_name, session) => {
    const { log, entries, address } = replayWithSink(session);
    expect(log.sinkFailures).toBe(0);
    // The log the sink rode along with: the pinned bytes.
    expect(pinnedText({ commitLog: log.list(), initialState: log.getInitialState() })).toBe(
      pinnedText({ commitLog: session.recorded.commitLog, initialState: session.recorded.initialState }),
    );
    // The record read back from the sink: the same bytes, whole and complete.
    const stored = readStoredRecord(entries).log(address)!;
    expect(stored.complete).toBe(true);
    expect(stored.gaps).toEqual([]);
    expect(stored.notes).toHaveLength(session.transitions.length);
    expect(pinnedText({ commitLog: stored.commitLog, initialState: stored.initialState })).toBe(
      pinnedText({ commitLog: session.recorded.commitLog, initialState: session.recorded.initialState }),
    );
    // Folded, the stored record ends where the live log ends.
    const end = log.length - 1;
    expect(stateAt(stored.source(), end).state).toEqual(
      stateAt({ initialState: log.getInitialState(), commitLog: log.list() }, end).state,
    );
  });

  it('the commit entries are the log’s own bundles, in order — the sink holds no second copy of a sealed one', () => {
    let sealed = 0;
    let open = 0;
    for (const session of sessions) {
      const { log, entries } = replayWithSink(session);
      const commits = entries.filter((e): e is Extract<RecordEntry, { kind: 'commit' }> => e.kind === 'commit');
      expect(commits.map((c) => c.bundle.idx)).toEqual(log.recorded().map((b) => b.idx));
      commits.forEach((c, i) => {
        const own = log.recorded()[i];
        if (serveRecord(own) === own) {
          // Sealed whole: the very same frozen object, shared — not a copy.
          sealed++;
          expect(c.bundle).toBe(own);
        } else {
          // Holding a Date, Map or Set: a served copy of its open paths — equal, and not the log's object.
          open++;
          expect(c.bundle).not.toBe(own);
          expect(c.bundle).toEqual(own);
        }
      });
    }
    expect(sealed).toBeGreaterThan(0);
    expect(open).toBeGreaterThan(0);
  });
});
