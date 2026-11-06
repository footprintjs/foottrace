/**
 * The governing-decision fold.
 *
 *   differential  on a real engine's parents and decisions, the fold equals the real `ControlDepRecorder`
 *   resume        walk `resumes`, else `parent`; crossing a resume reads conservative; a leg not given is never entered
 *   honesty       a chain that cannot finish is partial, never "ungoverned"
 */
import { describe, expect, it } from 'vitest';

import { engineScenario, evidenceStore, writeScenario } from '../../../test/helpers/evidenceFixture';
import { readStoredRecord } from '../time-travel/storedRecord';
import { readRunEvidence } from './read';

const read = (name: string, legs?: string[]) => {
  const scenario = engineScenario(name);
  return {
    scenario,
    evidence: readRunEvidence(readStoredRecord(writeScenario(scenario)), legs ?? scenario.legs),
  };
};

describe('the fold equals the live recorder on a real run', () => {
  it.each(['branches', 'agent'])('%s: every execution', (name) => {
    const { scenario, evidence } = read(name);
    const ids = Object.keys(scenario.live);
    expect(ids.length).toBeGreaterThan(20);
    for (const id of ids) {
      const live = scenario.live[id];
      const folded = evidence.control(id);
      expect([id, folded.status, folded.gaps]).toEqual([id, 'collected', []]);
      expect([id, folded.decider, folded.label]).toEqual([id, live?.decider, live?.label]);
    }
  });

  it.each(['resume-same', 'resume-fresh'])('%s: the first leg, before its pause', (name) => {
    const { scenario, evidence } = read(name);
    for (const [id, live] of Object.entries(scenario.live)) {
      if (id !== 'go/deep/ask#5') expect([id, evidence.control(id).decider]).toEqual([id, live?.decider]);
    }
  });

  it.each(['resume-same', 'resume-fresh'])(
    '%s: the paused stage itself, where the fold answers and the recorder cannot: it never saw that stage finish',
    (name) => {
      const { scenario, evidence } = read(name);
      expect(scenario.live['go/deep/ask#5']).toBeNull();
      expect(evidence.control('go/deep/ask#5')).toMatchObject({ status: 'collected', decider: 'gate#1' });
    },
  );
});

describe('a decider’s entry is its first child by execution index, a selector’s its first N', () => {
  it('a decider with its own next governs its branch, not its next', () => {
    const s = evidenceStore();
    const root = ['r'];
    s.commit(root, 'd#1', {});
    s.note(root, 'run.decision', { id: 'd#1', by: 'plain', chosen: 'b' });
    s.commit(root, 'next#3', { parent: 'd#1' });
    s.commit(root, 'b#2', { parent: 'd#1' });
    s.close(root);
    const evidence = readRunEvidence(readStoredRecord(s.entries()), 'r');
    expect(evidence.control('b#2').decider).toBe('d#1');
    expect(evidence.control('next#3').decider).toBeUndefined();
  });

  it('a selector governs N children, then none; a zero-branch selector governs none', () => {
    const s = evidenceStore();
    const root = ['r'];
    s.commit(root, 'sel#1', {});
    s.note(root, 'run.decision', { id: 'sel#1', by: 'plain', chosen: ['a', 'b'] });
    s.commit(root, 'a#2', { parent: 'sel#1' });
    s.commit(root, 'b#3', { parent: 'sel#1' });
    s.commit(root, 'after#4', { parent: 'sel#1' });
    s.commit(root, 'none#5', { parent: 'after#4' });
    s.note(root, 'run.decision', { id: 'none#5', by: 'plain', chosen: [] });
    s.commit(root, 'child#6', { parent: 'none#5' });
    s.close(root);
    const evidence = readRunEvidence(readStoredRecord(s.entries()), 'r');
    expect(evidence.control('a#2').decider).toBe('sel#1');
    expect(evidence.control('b#3').decider).toBe('sel#1');
    expect(evidence.control('after#4').decider).toBeUndefined();
    expect(evidence.control('child#6').decider).toBeUndefined();
  });

  it('the nearest decider wins through a nested chain, across a mount’s logs', () => {
    const s = evidenceStore();
    const root = ['r'];
    const mount = ['r', 'm#2'];
    s.commit(root, 'd#1', {});
    s.note(root, 'run.decision', { id: 'd#1', by: 'plain', chosen: 'm' });
    s.note(root, 'run.stage', { id: 'm#2', parent: 'd#1' });
    s.commit(mount, 'm/in#3', { parent: 'm#2' });
    s.commit(mount, 'm/d#4', { parent: 'm/in#3' });
    s.note(mount, 'run.decision', { id: 'm/d#4', by: 'plain', chosen: 'x' });
    s.commit(mount, 'm/x#5', { parent: 'm/d#4' });
    s.close(mount);
    s.commit(root, 'm#2', { parent: 'd#1' });
    s.close(root);
    const evidence = readRunEvidence(readStoredRecord(s.entries()), 'r');
    expect(evidence.control('m/in#3').decider).toBe('d#1');
    expect(evidence.control('m/x#5').decider).toBe('m/d#4');
  });

  it('the label is the matched rule’s for the chosen branch, a selector has none', () => {
    const s = evidenceStore();
    const root = ['r'];
    const rule = (branch: string, matched: boolean, label: string) =>
      ({ type: 'function', ruleIndex: 0, branch, matched, label, inputs: [] } as const);
    s.commit(root, 'd#0', {});
    s.note(root, 'run.decision', {
      id: 'd#0',
      by: 'decide',
      chosen: 'B',
      evidence: { rules: [rule('a', true, 'first'), rule('b', true, 'chosen')], chosen: 'b', default: 'a' },
    });
    s.commit(root, 'b#1', { parent: 'd#0' });
    s.commit(root, 'sel#2', { parent: 'b#1' });
    s.note(root, 'run.decision', {
      id: 'sel#2',
      by: 'select',
      chosen: ['x'],
      evidence: { rules: [rule('x', true, 'not attributed')], selected: ['x'] },
    });
    s.commit(root, 'x#3', { parent: 'sel#2' });
    s.close(root);
    const evidence = readRunEvidence(readStoredRecord(s.entries()), 'r');
    expect(evidence.control('b#1').label).toBe('chosen');
    expect(evidence.control('x#3')).toMatchObject({ decider: 'sel#2' });
    expect(evidence.control('x#3').label).toBeUndefined();
  });
});

describe('the resume fold', () => {
  const inBranch = ['go/deep/ask#8', 'go/deep/use#9', 'go/mid-end#10', 'go/deep#7', 'go#6'];

  it.each(['resume-same', 'resume-fresh'])(
    '%s, every leg given: the chain walks `resumes` back into the branch and reads conservative',
    (name) => {
      const { evidence } = read(name);
      for (const id of inBranch) {
        expect([id, evidence.control(id)]).toEqual([
          id,
          { status: 'partial', decider: 'gate#1', label: 'Over one', gaps: ['conservative'] },
        ]);
      }
    },
  );

  it.each(['resume-same', 'resume-fresh'])(
    '%s: a stage after the re-entry may be over-attributed, and says so',
    (name) => {
      const { evidence } = read(name);
      expect(evidence.control('after#11')).toEqual({
        status: 'partial',
        decider: 'gate#1',
        label: 'Over one',
        gaps: ['conservative'],
      });
    },
  );

  it('resume-fresh, only the resumed leg given: partial (resumed-leg), never ungoverned, never the other log', () => {
    const { evidence } = read('resume-fresh', ['run-2']);
    for (const id of [...inBranch, 'after#11']) {
      const answer = evidence.control(id);
      expect([id, answer.status, answer.why]).toEqual([id, 'partial', 'resumed-leg']);
      expect(answer.decider).toBeUndefined();
      expect(answer.gaps).toContain('scope-boundary');
    }
    // The paused leg's logs are in the store, and were not read.
    expect(evidence.control('gate#1').status).toBe('not-collected');
  });

  it('resume-same: the paused mount is known by its run.stage, with no commit of its own', () => {
    const { evidence } = read('resume-same');
    const stage = evidence.stages.rows.find((row) => row.id === 'go#2')!;
    expect(stage).toMatchObject({ parent: 'gate#1', committed: false });
    expect(evidence.control('go/deep/ask#5')).toMatchObject({ status: 'collected', decider: 'gate#1' });
  });

  it('a parentless execution that is not the root, with no `resumes` at all, is partial (resumed-leg)', () => {
    const s = evidenceStore();
    const root = ['r'];
    s.commit(root, 'orphan#7', {});
    s.commit(root, 'child#8', { parent: 'orphan#7' });
    s.close(root);
    const evidence = readRunEvidence(readStoredRecord(s.entries()), 'r');
    for (const id of ['orphan#7', 'child#8']) {
      const answer = evidence.control(id);
      expect([id, answer.status, answer.why]).toEqual([id, 'partial', 'resumed-leg']);
      expect(answer.gaps).toEqual(['scope-boundary']);
    }
  });

  it('`resumes` into a log not given, with a parent still here, walks the parent and says what it could not see', () => {
    const s = evidenceStore();
    const root = ['r'];
    s.commit(root, 'seed#0', {});
    s.commit(root, 'back#9', { parent: 'seed#0', resumes: 'gone#5' });
    s.close(root);
    const answer = readRunEvidence(readStoredRecord(s.entries()), 'r').control('back#9');
    expect(answer.status).toBe('partial');
    expect(answer.why).toBe('resumed-leg');
    expect(answer.gaps).toEqual(['scope-boundary']);
  });
});

describe('never ungoverned by accident', () => {
  it('the true root, a whole chain: collected, no decider', () => {
    const s = evidenceStore();
    const root = ['r'];
    s.commit(root, 'seed#0', {});
    s.commit(root, 'next#1', { parent: 'seed#0' });
    s.close(root);
    const evidence = readRunEvidence(readStoredRecord(s.entries()), 'r');
    expect(evidence.control('next#1')).toEqual({ status: 'collected', gaps: [] });
  });

  it('a commit with no about, and its descendants: not-collected, then partial', () => {
    const s = evidenceStore();
    const root = ['r'];
    s.commit(root, 'seed#0', {});
    s.commit(root, 'dropped#1');
    s.commit(root, 'after#2', { parent: 'dropped#1' });
    s.close(root);
    const evidence = readRunEvidence(readStoredRecord(s.entries()), 'r');
    expect(evidence.control('dropped#1')).toEqual({ status: 'not-collected', gaps: [], why: 'no-about' });
    expect(evidence.control('after#2')).toEqual({ status: 'partial', gaps: ['not-collected'], why: 'no-about' });
  });

  it('a parent in a log not given: partial, and the walk stops there', () => {
    const s = evidenceStore();
    const mount = ['r', 'm#2'];
    s.commit(mount, 'm/in#3', { parent: 'm#2' });
    s.close(mount);
    const evidence = readRunEvidence(readStoredRecord(s.entries()), 'r');
    expect(evidence.control('m/in#3')).toEqual({ status: 'partial', gaps: ['scope-boundary'], why: 'log-not-given' });
  });

  it('a mount log’s seed is no commit of the mount’s: its parent log not given stays a boundary', () => {
    const s = evidenceStore();
    const mount = ['r', 'm#2'];
    s.commit(mount, 'm#2');
    s.commit(mount, 'm/in#3', { parent: 'm#2' });
    s.close(mount);
    const evidence = readRunEvidence(readStoredRecord(s.entries()), 'r');
    expect(evidence.control('m/in#3')).toEqual({ status: 'partial', gaps: ['scope-boundary'], why: 'log-not-given' });
    expect(evidence.stages.status).toBe('collected');
  });

  it('a lost decision: every chain in that log reads partial, a hole never reads as no decision', () => {
    const s = evidenceStore();
    const root = ['r'];
    s.commit(root, 'd#0', {});
    s.note(root, 'run.decision', { id: 'd#0', by: 'plain', chosen: 'b', extra: () => 0 } as never);
    s.commit(root, 'b#1', { parent: 'd#0' });
    s.close(root);
    const answer = readRunEvidence(readStoredRecord(s.entries()), 'r').control('b#1');
    expect(answer.decider).toBeUndefined();
    expect(answer.status).toBe('partial');
    expect(answer.gaps).toEqual(['not-collected']);
  });

  it('an execution nobody mentioned: not-collected, and an id that is not a string too', () => {
    const s = evidenceStore();
    s.commit(['r'], 'seed#0', {});
    s.close(['r']);
    const evidence = readRunEvidence(readStoredRecord(s.entries()), 'r');
    expect(evidence.control('never#9')).toEqual({ status: 'not-collected', gaps: [], why: 'unknown-execution' });
    expect(evidence.control(7 as unknown as string).status).toBe('not-collected');
  });
});
