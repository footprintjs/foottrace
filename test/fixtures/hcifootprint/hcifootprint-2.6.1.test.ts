/**
 * Captured hcifootprint 2.6.1 transitions, replayed through the record writer
 * used since 2.7.0. The original JSON bytes and capture assertions are unchanged.
 * The retired engine-frame replay stays out of this engine-free package (E3).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { RecordEncoding, WriteScrub } from '../../../src/write.js';
import { EventLog, RecordFrame, SharedMemory } from '../../../src/write.js';
import { pinnedText, revive } from '../bytes.js';

interface Transition {
  stage: string;
  stageId: string;
  runtimeStageId: string;
  reads: string[];
  writes: [key: string, value: unknown, redact: boolean][];
}
interface CapturedSession {
  name: string;
  open: {
    rootName: string;
    rootId: string;
    initialState: unknown;
    commitValues: 'full' | 'delta';
    writeProvenance: 'off' | 'reads-prefix';
  };
  transitions: Transition[];
  recorded: Record<string, unknown>;
}

const FILE = join(dirname(fileURLToPath(import.meta.url)), 'transitions-2.6.1.json');
const doc = JSON.parse(readFileSync(FILE, 'utf8')) as { capturedFrom: string; sessions: CapturedSession[] };
const { sessions } = doc;

/** The whole-value scrub hcifootprint 2.7.0 hands a `redactedKeys` write. */
const REDACT_WHOLE: WriteScrub = Object.freeze({ whole: true });

/** The same session, written the way hcifootprint 2.7.0 writes it: through `foottrace/write`. */
function replayThroughWrite({ open, transitions }: CapturedSession) {
  // constructor
  const state = new SharedMemory(undefined, revive(open.initialState));
  const log = new EventLog(state.getState());
  const encoding: RecordEncoding = Object.freeze({
    commitValues: open.commitValues,
    writeProvenance: open.writeProvenance,
  });
  const readsByStep = new Map<string, string[]>();
  for (const t of transitions) {
    // #commitDelta (2.6.1's redact flag per write is 2.7.0's `#redacted.has(key)`)
    const frame = new RecordFrame(state, log);
    frame.useEncoding(encoding);
    for (const key of t.reads) frame.noteRead([], key);
    const filed = t.reads.filter((key) => key !== '');
    if (filed.length > 0) readsByStep.set(t.runtimeStageId, filed);
    for (const [key, value, redact] of t.writes) {
      const scrub = redact ? REDACT_WHOLE : undefined;
      frame.write(frame.at([], key), revive(value), 'set', scrub);
    }
    frame.commit(() => ({ stage: t.stage, stageId: t.stageId, runtimeStageId: t.runtimeStageId }));
  }
  return {
    commitLog: [...log.list()],
    initialState: log.getInitialState(),
    state: state.getState(),
    reads: [...readsByStep],
  };
}

// Re-pin, for a named law fix only (../README.md): the calls never change; what they record does.
if (process.env.RECORD_BYTES_REPIN === '1') {
  for (const session of sessions) session.recorded = replayThroughWrite(session);
  writeFileSync(FILE, pinnedText(doc));
}

describe('record bytes — hcifootprint 2.6.1 transitions pinned on 9.44.1', () => {
  it('the standalone JSON encoder preserves the complete stored fixture bytes', () => {
    expect(pinnedText(doc)).toBe(readFileSync(FILE, 'utf8'));
  });

  it.each(sessions.map((s) => [s.name, s] as const))('%s — through foottrace/write (2.7.0)', (_name, session) => {
    expect(pinnedText(replayThroughWrite(session))).toBe(pinnedText(session.recorded));
  });

  it('the capture holds both encodings, a redacted write, Date/Map/Set, and a commit out of mint order', () => {
    expect(new Set(sessions.map((s) => s.open.commitValues))).toEqual(new Set(['delta', 'full']));
    expect(sessions.every((s) => s.open.writeProvenance === 'reads-prefix')).toBe(true);
    const writes = sessions.flatMap((s) => s.transitions.flatMap((t) => t.writes));
    expect(writes.some(([, , redact]) => redact)).toBe(true);
    const values = writes.map(([, value]) => revive(value));
    for (const kind of [Date, Map, Set]) expect(values.some((v) => v instanceof kind)).toBe(true);
    const ids = sessions.map((s) => s.transitions.map((t) => t.runtimeStageId).join(' '));
    expect(ids).toContain('stimulus:push#1 login#0');
    // 2.7.0 names a bundle's `stage` and `stageId` both by its stage name, as 2.6.1's `newRoot(name, name)` did.
    expect(sessions.every((s) => s.transitions.every((t) => t.stage === t.stageId))).toBe(true);
  });
});
