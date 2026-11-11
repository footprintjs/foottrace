/**
 * The PROV export and the read window.
 *
 * The export names ONE candidate source for a read: the last write of the key before the reading
 * step. It dated that at the step's own commit, and its bundle admission dropped the stamps that say
 * when the step really looked at state. So a step that read `x` early was handed the sibling that
 * committed first as its candidate. The export now keeps the stamps and asks the one rule
 * (`memory/readWindow.ts`). When the key was written inside the reader's window there is no one
 * candidate, and the export names none and says so (`read-basis`): it never guesses.
 *
 * Test types: scenario (the exported graph), boundary (stamps that cannot be stamps), regression
 * (a record without stamps exports as before).
 */
import { describe, expect, it } from 'vitest';

import { exportProv } from '../../../src/prov.js';

/**
 * `seed` writes x; `fast` replaces x; `slow`, which began before `fast` committed, reads x and writes
 * `copy`. `stamps` is what `slow`'s bundle says about when it looked at state.
 */
const run = (stamps: object) => ({
  commitLog: [
    { runtimeStageId: 'seed#0', trace: [{ path: 'x', verb: 'set' }] },
    { runtimeStageId: 'fast#1', trace: [{ path: 'x', verb: 'set' }] },
    { runtimeStageId: 'slow#2', trace: [{ path: 'copy', verb: 'set', readKeys: ['x'] }], ...stamps },
  ],
});
async function exported(stamps: object) {
  const result = await exportProv(run(stamps), { base: 'urn:test:window/' });
  const nodes = result.document['@graph'];
  const read = nodes.find((node) => node['@type'] === 'ft:Read');
  const candidate = nodes.find((node) => node['@id'] === (read?.['ft:candidateEntity'] as { '@id': string })?.['@id']);
  return { read, candidateCommit: candidate?.['ft:commitIdx'], gaps: result.gaps };
}
const NOT_ONE_BINDING = { code: 'ambiguous', reason: 'read basis is not a single recorded binding', count: 1 };

describe('the candidate source of a read in the PROV export', () => {
  it('a step that only read what it saw when it began: the earlier writer, not the sibling that committed first', async () => {
    const { read, candidateCommit, gaps } = await exported({ beganAt: 1 });
    expect(read?.['ft:basis']).toBe('candidate');
    expect(candidateCommit).toBe(0);
    expect(gaps).not.toContainEqual(NOT_ONE_BINDING);
  });

  it('a step that looked again after the sibling committed: no one candidate, and the export says so', async () => {
    const { read, gaps } = await exported({ beganAt: 1, sawUntil: 2 });
    expect(read?.['ft:basis']).toBe('unknown');
    expect(read).not.toHaveProperty('ft:candidateEntity');
    expect(gaps).toContainEqual(NOT_ONE_BINDING);
  });

  it('a record without stamps exports as before: the last writer before the commit', async () => {
    const { read, candidateCommit, gaps } = await exported({});
    expect(read?.['ft:basis']).toBe('candidate');
    expect(candidateCommit).toBe(1);
    expect(gaps).not.toContainEqual(NOT_ONE_BINDING);
  });

  it.each([
    ['beganAt at the step', { beganAt: 2 }],
    ['beganAt a fraction', { beganAt: 0.5 }],
    ['beganAt a string', { beganAt: '1' }],
    ['sawUntil without beganAt', { sawUntil: 2 }],
    ['sawUntil past the step', { beganAt: 1, sawUntil: 3 }],
    ['an idx that contradicts the stamps', { beganAt: 1, idx: 1 }],
  ])('%s: the bundle is refused as unreadable, never exported with the stamp dropped', async (_name, stamps) => {
    const { read, gaps } = await exported(stamps);
    expect(read).toBeUndefined();
    expect(gaps).toContainEqual({ code: 'invalid-data', commitIdx: 2, reason: 'unreadable commit bundle' });
  });

  it('a bundle that says its own index keeps its stamps at their distance from it', async () => {
    // Row 2 of this export was commit 9 of its log, and its step began when that log held 8 commits.
    const { candidateCommit } = await exported({ idx: 9, beganAt: 8 });
    expect(candidateCommit).toBe(0);
  });
});
