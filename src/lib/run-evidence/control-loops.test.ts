import { describe, expect, it } from 'vitest';

import { evidenceStore } from '../../../test/helpers/evidenceFixture.js';
import { loopFixtures, loopRecord } from '../../../test/helpers/loopEvidenceFixture.js';
import { readRunEvidence, readStoredRecord } from '../../index.js';

describe('stored control across actual engine loop records', () => {
  const ordinary = loopFixtures.filter(({ resumes }) => Object.keys(resumes).length === 0);
  const paused = loopFixtures.filter(({ resumes }) => Object.keys(resumes).length > 0);

  it.each(ordinary)('$name in $commitValues matches every live lookup', (fixture) => {
    const evidence = readRunEvidence(readStoredRecord(loopRecord(fixture, 2)), fixture.legs);

    expect(evidence.unread).toEqual([]);
    for (const { id, control } of fixture.live) {
      expect([id, evidence.control(id)]).toEqual([
        id,
        {
          status: 'collected',
          gaps: [],
          ...(control !== undefined && { decider: control.deciderId }),
          ...(control?.label !== undefined && { label: control.label }),
        },
      ]);
    }
  });

  it.each(loopFixtures)('$name in $commitValues cannot claim exact control after an omitted hop', (fixture) => {
    const complete = readRunEvidence(readStoredRecord(loopRecord(fixture, 2)), fixture.legs);
    const hops = Object.entries(fixture.loops);
    const missing = (kept: Readonly<Record<string, string>>) =>
      readRunEvidence(readStoredRecord(loopRecord(fixture, 2, kept)), fixture.legs);

    const without = missing({});
    expect(without.unread).toEqual([]);
    for (const { id } of fixture.live) {
      const expected = complete.control(id);
      const saved = without.control(id);
      if (expected.decider !== saved.decider) {
        expect([id, saved.status, saved.gaps]).toEqual([id, 'partial', ['conservative']]);
      }
    }

    for (const [dropped] of hops) {
      const withoutOne = missing(Object.fromEntries(hops.filter(([source]) => source !== dropped)));
      expect(withoutOne.unread).toEqual([]);
      const reentry = fixture.live.find(({ parent }) => parent === dropped);
      expect(reentry, dropped).toBeDefined();
      const result = withoutOne.control(reentry!.id);
      expect([dropped, result.status, result.gaps]).toEqual([dropped, 'partial', ['conservative']]);
    }
  });

  it.each(paused)('$name in $commitValues follows resumes without treating the stand-in as a hop', (fixture) => {
    const evidence = readRunEvidence(readStoredRecord(loopRecord(fixture, 2)), fixture.legs);
    const [standIn, stopped] = Object.entries(fixture.resumes)[0];
    expect(evidence.unread).toEqual([]);
    expect(evidence.control('work#5')).toMatchObject({ status: 'collected', decider: 'more#3' });
    expect(evidence.control(stopped)).toMatchObject({ status: 'collected', decider: 'more#3' });
    expect(evidence.control(standIn)).toMatchObject({ status: 'partial', gaps: ['conservative'] });
    expect(evidence.control('work#10')).toMatchObject({ status: 'collected', decider: 'more#8' });
  });

  const rememberedLoop = loopFixtures.find(
    ({ name, commitValues }) => name === '1 back-edges' && commitValues === 'full',
  )!;
  it('reports possible re-entry conservatively on a v1 log', () => {
    const evidence = readRunEvidence(readStoredRecord(loopRecord(rememberedLoop, 1)), 'r');
    expect(evidence.control('work#1')).toEqual({ status: 'collected', gaps: [] });
    expect(evidence.control('work#4')).toMatchObject({ status: 'partial', gaps: ['conservative'] });
    expect(evidence.control('after#7')).toMatchObject({ status: 'partial', gaps: ['conservative'] });
  });

  it('the writer stamps v2 hops and the fold can reuse the exit across a long continuation', () => {
    const s = evidenceStore();
    const log = ['r'];
    const passes = 1000;
    const tail = 2000;
    let commits = 0;
    let notes = 0;
    let parent: string | undefined;
    const add = (stage: string) => {
      const id = `${stage}#${commits++}`;
      s.commit(log, id, parent === undefined ? {} : { parent });
      parent = id;
      return id;
    };
    add('start');
    for (let pass = 0; pass <= passes; pass++) {
      add('work');
      const gate = add('more');
      const selected = pass < passes ? 'again' : 'leave';
      s.note(log, 'run.decision', { id: gate, by: 'plain', chosen: selected });
      notes++;
      if (selected === 'again') {
        s.note(log, 'run.loop', { id: add('again'), target: 'work' });
        notes++;
      } else {
        add('leave');
        parent = gate;
      }
    }
    for (let i = 0; i < tail; i++) add(`after-${i}`);
    const next = parent!;
    s.close(log);

    const stored = readStoredRecord(s.entries());
    const limit = commits + notes;
    const noWalk = readRunEvidence(stored, 'r', { fields: limit });
    expect(noWalk.unread).toEqual([]);
    expect(noWalk.control(next)).toEqual({ status: 'partial', gaps: ['truncated'] });
    const withWalk = readRunEvidence(stored, 'r', { fields: limit + passes * 4 });
    expect(withWalk.unread).toEqual([]);
    expect(withWalk.control(next)).toEqual({ status: 'collected', gaps: [] });
  });

  it.each<{ name: string; loops: Readonly<Record<string, string>> }>([
    { name: 'wrong target', loops: { 'again#3': 'more' } },
    { name: 'no child', loops: { 'after#7': 'work' } },
    { name: 'matching target without an earlier execution', loops: { 'seed#0': 'work' } },
  ])('refuses a loop note with $name', ({ loops }) => {
    const evidence = readRunEvidence(readStoredRecord(loopRecord(rememberedLoop, 2, loops)), 'r');
    expect(evidence.unread).toEqual([expect.objectContaining({ reason: expect.stringContaining('run.loop') })]);
    expect(evidence.control('after#7')).toMatchObject({ status: 'partial', gaps: ['invalid-data', 'conservative'] });
    expect(evidence.decisions.status).toBe('collected');
  });
});
