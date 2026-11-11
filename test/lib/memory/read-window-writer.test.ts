/**
 * The writer's half of the read window: `CommitBundle.beganAt` and `CommitBundle.sawUntil`.
 *
 * A frame reads state from the view it pins at its first touch, and from live state for a key that
 * view cannot answer. When other frames commit between the earliest moment one of its reads saw and
 * its own commit, the bundle says how many commits the log held at that moment (`beganAt`): the
 * step's reads are dated there. When a read of its saw a later moment too, the bundle says how many
 * commits the log held at the latest (`sawUntil`): the commits in between are the ones a read may
 * have seen. A run with no such overlap, which is every run whose steps go one after another, keeps
 * its bytes.
 *
 * What counts is a READ. Pinning the view for a write, or for a report that only compares, is not
 * one: a step that read early and wrote late did not read again at its write.
 *
 * Test types: unit (the real `RecordFrame`, `SharedMemory` and `EventLog`), boundary, and one source
 * pin (every read of shared state in the frame notes what it saw).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CommitPhase } from '../../../src';
import { EventLog, RecordFrame, SharedMemory } from '../../../src/write';

function world(seed: Record<string, unknown> = {}) {
  const state = new SharedMemory(undefined, seed);
  const log = new EventLog(seed);
  return { state, log, frame: (address: string[] = []) => new RecordFrame(state, log, address) };
}
function commit(frame: RecordFrame, id: string, phase?: CommitPhase): void {
  frame.commit(() => ({ stage: id, stageId: id, runtimeStageId: `${id}#0`, ...(phase && { phase }) }));
  frame.release();
}
const write = (frame: RecordFrame, key: string, value: unknown) => frame.write(frame.at([], key), value, 'set');
/** One other step writes `key` and commits: the log grows by one. */
function otherCommits(frame: () => RecordFrame, key: string, value: unknown, id = 'other'): void {
  const other = frame();
  write(other, key, value);
  commit(other, id);
}
const KEYS = ['overwrite', 'updates', 'redactedPaths', 'trace', 'stage', 'stageId', 'runtimeStageId'];
const stamps = (bundle: object) => Object.keys(bundle).filter((key) => key === 'beganAt' || key === 'sawUntil');

describe('a commit bundle says when its step began, only when that matters', () => {
  it('a run of steps one after another carries no stamp and keeps its key order', () => {
    const { log, frame } = world();
    const seed = frame();
    write(seed, 'x', 1);
    commit(seed, 'seed');
    const next = frame();
    expect(next.read([], 'x')).toBe(1);
    write(next, 'y', 2);
    commit(next, 'next');
    for (const bundle of log.list()) {
      expect(stamps(bundle)).toEqual([]);
      expect(Object.keys(bundle)).toEqual([...KEYS, 'idx']);
    }
  });

  it('a step that another step committed under says how long the log was at its first look', () => {
    const { log, frame } = world();
    otherCommits(frame, 'x', 'seed', 'seed');

    const slow = frame(['runs', 'slow']);
    expect(slow.read([], 'x')).toBe('seed'); // first look: the log holds 1 commit
    otherCommits(frame, 'x', 'fast', 'fast'); // lands while `slow` runs
    write(slow, 'copy', 'seed');
    commit(slow, 'slow');

    const [, fastBundle, slowBundle] = log.list();
    expect(stamps(fastBundle)).toEqual([]);
    expect(slowBundle.beganAt).toBe(1);
    expect(slowBundle.idx).toBe(2);
    // It read once, before anything else was committed: no later look, so no `sawUntil`.
    expect(Object.keys(slowBundle)).toEqual([...KEYS, 'beganAt', 'idx']);
  });

  it('a step whose first look came after the other commit carries none', () => {
    const { log, frame } = world();
    const slow = frame(['runs', 'slow']); // created early, looks at nothing yet
    otherCommits(frame, 'x', 'fast', 'fast');
    expect(slow.read([], 'x')).toBe('fast');
    write(slow, 'copy', 'fast');
    commit(slow, 'slow');
    expect(log.list().flatMap(stamps)).toEqual([]);
  });

  it('a step that only read still says so: its empty bundle carries beganAt', () => {
    const { log, frame } = world({ x: 0 });
    const reader = frame();
    expect(reader.read([], 'x')).toBe(0);
    otherCommits(frame, 'x', 1);
    commit(reader, 'reader');
    const bundle = log.list()[1];
    expect(bundle.trace).toEqual([]);
    expect(bundle.beganAt).toBe(0);
  });

  it('a read answered from a view that a write pinned is dated where the view was pinned', () => {
    const { log, frame } = world({ x: 0 });
    const writer = frame();
    write(writer, 'y', 1); // the view is pinned: the log holds 0 commits
    otherCommits(frame, 'x', 1);
    expect(writer.read([], 'x')).toBe(0); // answered from that view, however late it is asked
    commit(writer, 'writer');
    expect(log.list()[1]).toMatchObject({ beganAt: 0 });
    expect(stamps(log.list()[1])).toEqual(['beganAt']);
  });

  it('a step that only wrote read nothing: no stamp, whatever was committed while it ran', () => {
    const { log, frame } = world({ x: 0 });
    const writer = frame();
    write(writer, 'y', 1);
    otherCommits(frame, 'x', 1);
    write(writer, 'z', 2);
    commit(writer, 'writer');
    expect(stamps(log.list()[1])).toEqual([]);
    expect(Object.keys(log.list()[1])).toEqual([...KEYS, 'idx']);
  });

  it('a step that read early and wrote late did not read again at its write', () => {
    // A subflow mount: its input mapping reads live state when it starts, and its output mapping
    // writes when the subflow has run. The write pins the view; nothing is read from it.
    const { log, frame } = world({ x: 'old' });
    const mount = frame();
    expect(mount.readGlobal('x')).toBe('old'); // the log holds 0 commits
    otherCommits(frame, 'x', 'new');
    write(mount, 'result', 'from-old');
    commit(mount, 'mount');
    expect(log.list()[1]).toMatchObject({ beganAt: 0 });
    expect(stamps(log.list()[1])).toEqual(['beganAt']);
  });

  it('the reads are not always in the order of what they saw: the earliest and the latest are kept', () => {
    const { log, frame } = world({ x: 0, y: 0 });
    const step = frame();
    write(step, 'z', 1); // pins the view: the log holds 0 commits
    otherCommits(frame, 'x', 1);
    expect(step.readLive('x')).toBe(1); // a live read: the log holds 1
    expect(step.read([], 'y')).toBe(0); // then a read from the view pinned at 0
    commit(step, 'step');
    expect(log.list()[1]).toMatchObject({ beganAt: 0, sawUntil: 1 });
  });

  it('a report that only compares is not a read', () => {
    const { log, frame } = world({ x: 'old' });
    const step = frame();
    expect(step.readGlobal('x')).toBe('old'); // the log holds 0 commits
    otherCommits(frame, 'x', 'new');
    expect(step.peek(['x'])).toBe('new'); // pins the view at 1, as a development-only check does
    expect(step.baseAt(['x'])).toBe('new');
    commit(step, 'step');
    expect(stamps(log.list()[1])).toEqual(['beganAt']);
    expect(log.list()[1].beganAt).toBe(0);
  });

  it('each round of a frame has its own first look: a continuation after a release starts again', () => {
    const { log, frame } = world({ x: 0 });
    const child = frame();
    expect(child.read([], 'x')).toBe(0);
    otherCommits(frame, 'x', 1);
    write(child, 'y', 1);
    commit(child, 'child'); // round one: overlapped
    write(child, 'z', 1);
    commit(child, 'child', 'repeat'); // round two: looked and committed with nothing in between
    const [, first, second] = log.list();
    expect(first.beganAt).toBe(0);
    expect(stamps(second)).toEqual([]);
    expect(second.phase).toBe('repeat');
  });

  it('a discarded attempt takes its looks with it: the next attempt is dated from its own first look', () => {
    const { log, frame } = world({ x: 0 });
    const step = frame(['runs', 'step']);
    expect(step.read([], 'x')).toBe(0); // attempt one looks when the log holds 0 commits
    otherCommits(frame, 'x', 1);
    expect(step.read([], 'x')).toBe(1); // and again, live, when it holds 1
    step.discard();
    expect(step.read([], 'x')).toBe(1); // attempt two: first look, the log holds 1 commit
    write(step, 'y', 1);
    commit(step, 'step');
    expect(stamps(log.list()[1])).toEqual([]);
  });

  it('a frame with no log records nothing and does not fail', () => {
    const state = new SharedMemory(undefined, { x: 0 });
    const a = new RecordFrame(state);
    const b = new RecordFrame(state);
    expect(a.read([], 'x')).toBe(0);
    b.write(b.at([], 'x'), 1, 'set');
    b.commit(() => ({ stage: 'b', stageId: 'b', runtimeStageId: 'b#0' }));
    expect(a.readLive('x')).toBe(1);
    a.write(a.at([], 'y'), 1, 'set');
    expect(() => a.commit(() => ({ stage: 'a', stageId: 'a', runtimeStageId: 'a#0' }))).not.toThrow();
  });
});

describe('a commit bundle says how far its step saw, only when it looked again', () => {
  it('a look at live state after another commit puts sawUntil on the bundle, after beganAt', () => {
    const { log, frame } = world({ x: 'old' });
    const reader = frame(['runs', 'slow']);
    expect(reader.read([], 'x')).toBe('old'); // the log holds 0 commits
    otherCommits(frame, 'x', 'new');
    expect(reader.read([], 'x')).toBe('new'); // live: the log holds 1 commit
    otherCommits(frame, 'z', 1, 'later'); // lands after the reader's last look
    write(reader, 'copy', 'new');
    commit(reader, 'reader');

    const bundle = log.list()[2];
    expect(bundle).toMatchObject({ beganAt: 0, sawUntil: 1, idx: 2 });
    expect(Object.keys(bundle)).toEqual([...KEYS, 'beganAt', 'sawUntil', 'idx']);
  });

  it('sawUntil is the LATEST look, however many there were', () => {
    const { log, frame } = world({ x: 0 });
    const reader = frame(['runs', 'r']);
    reader.read([], 'x');
    otherCommits(frame, 'x', 1);
    reader.read([], 'x'); // the log holds 1
    otherCommits(frame, 'x', 2);
    otherCommits(frame, 'x', 3);
    reader.read([], 'x'); // the log holds 3
    commit(reader, 'reader');
    expect(log.list()[3]).toMatchObject({ beganAt: 0, sawUntil: 3 });
  });

  it('a read answered from the view the step began with is not a later look', () => {
    const { log, frame } = world({ x: 'old' });
    const reader = frame(); // at the root address: `x` is in its first view
    expect(reader.read([], 'x')).toBe('old');
    otherCommits(frame, 'x', 'new');
    expect(reader.read([], 'x')).toBe('old');
    commit(reader, 'reader');
    expect(stamps(log.list()[1])).toEqual(['beganAt']);
  });

  it('a root step reading a key its first view does not hold looks at live state', () => {
    const { log, frame } = world({ x: 'old' });
    const reader = frame();
    expect(reader.read([], 'x')).toBe('old');
    otherCommits(frame, 'late', 'new');
    expect(reader.read([], 'late')).toBe('new');
    commit(reader, 'reader');
    expect(log.list()[1]).toMatchObject({ beganAt: 0, sawUntil: 1 });
  });

  it('a live look while nothing was committed since the first look says nothing more', () => {
    const { log, frame } = world({ x: 0 });
    const reader = frame(['runs', 'r']);
    reader.read([], 'x');
    reader.read([], 'x'); // live again, the log still holds 0 commits
    otherCommits(frame, 'x', 1);
    commit(reader, 'reader');
    expect(stamps(log.list()[1])).toEqual(['beganAt']);
  });

  for (const door of ['readLive', 'readGlobal'] as const) {
    it(`${door} is a look: after another commit it sets sawUntil`, () => {
      const { log, frame } = world({ x: 'old' });
      const reader = frame();
      expect(reader.read([], 'x')).toBe('old');
      otherCommits(frame, 'x', 'new');
      expect(reader[door]('x')).toBe('new');
      commit(reader, 'reader');
      expect(log.list()[1]).toMatchObject({ beganAt: 0, sawUntil: 1 });
    });

    it(`${door} as a step's FIRST act dates the step there, before its view is pinned`, () => {
      const { log, frame } = world({ x: 'old' });
      const reader = frame();
      expect(reader[door]('x')).toBe('old'); // the log holds 0 commits; no view pinned yet
      otherCommits(frame, 'x', 'new');
      expect(reader.read([], 'x')).toBe('new'); // the view is pinned now, when the log holds 1
      commit(reader, 'reader');
      // Without the first look counted, the bundle would carry no stamp and both reads would be dated at 1.
      expect(log.list()[1]).toMatchObject({ beganAt: 0, sawUntil: 1 });
    });
  }
});

describe('what a step can read while another commits (the reason a window is needed)', () => {
  it('a step at the root address keeps reading the value from its first look', () => {
    const { frame } = world({ x: 'old' });
    const reader = frame();
    expect(reader.read([], 'x')).toBe('old');
    otherCommits(frame, 'x', 'new');
    expect(reader.read([], 'x')).toBe('old');
  });

  it('a step in its own namespace reads a root key as it is at that moment', () => {
    const { frame } = world({ x: 'old' });
    const reader = frame(['runs', 'slow']);
    expect(reader.read([], 'x')).toBe('old');
    otherCommits(frame, 'x', 'new');
    expect(reader.read([], 'x')).toBe('new');
  });

  it('a root step reads a key that did not exist at its first look as it is at that moment', () => {
    const { frame } = world({ x: 'old' });
    const reader = frame();
    expect(reader.read([], 'x')).toBe('old');
    otherCommits(frame, 'late', 'new');
    expect(reader.read([], 'late')).toBe('new');
  });
});

describe('every read of shared state in the frame notes what it saw', () => {
  // A reader dates a step's reads from the two stamps alone. A read of `this.state` that noted nothing
  // could show the step a commit the record says it never saw: the walk back would then leave out the
  // real writer. So the frame's source is pinned: one place pins the view and notes when, three read live
  // state and note "now", and the one read answered from the view notes when the view was pinned.
  const source = readFileSync(resolve(__dirname, '../../../src/lib/memory/RecordFrame.ts'), 'utf8').split('\n');
  const at = (pattern: RegExp) => source.flatMap((line, index) => (pattern.test(line) ? [index] : []));

  it('there are exactly four reads of state, and none reaches state another way', () => {
    expect(at(/this\.state\.get(State|Value)\(/)).toHaveLength(4);
    const others = source.filter((line) => /this\.state\./.test(line) && !/this\.state\.get(State|Value)\(/.test(line));
    expect(others).toEqual([]);
  });

  it('the one place that pins the view notes when, and that alone is not a read', () => {
    const pins = at(/this\.state\.getState\(\)/);
    expect(pins).toHaveLength(1);
    expect(source[pins[0] + 1]).toMatch(/this\.#pinnedAt = this\.log\?\.length;/);
    expect(source[pins[0] + 1]).not.toMatch(/sawAt/);
  });

  it('each read of live state notes "now" on the line before it', () => {
    const live = at(/this\.state\.getValue\(/);
    expect(live).toHaveLength(3);
    for (const line of live) {
      expect(source[line - 1], `RecordFrame.ts line ${line + 1}`).toMatch(/this\.sawAt\(this\.log\?\.length\);/);
    }
  });

  it('the read answered from the view notes when the view was pinned, once', () => {
    const view = at(/this\.sawAt\(this\.#pinnedAt\);/);
    expect(view).toHaveLength(1);
    expect(source[view[0] + 1]).toMatch(/return fromSnapshot;/);
  });
});
