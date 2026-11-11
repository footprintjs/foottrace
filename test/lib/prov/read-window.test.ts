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
  ])('%s: the row is left out and the gap says why, never exported with the stamp dropped', async (_name, stamps) => {
    const { read, gaps } = await exported(stamps);
    expect(read).toBeUndefined();
    expect(gaps).toContainEqual({
      code: 'invalid-data',
      commitIdx: 2,
      reason: 'read stamps do not fit the commit index',
    });
  });

  // Found by the second reader: one odd idx on a neighbour made the sibling the candidate again.
  const candidateOf = async (rows: object[]) => {
    const result = await exportProv({ commitLog: rows }, { base: 'urn:test:window/' });
    const nodes = result.document['@graph'];
    const read = nodes.find((node) => node['@type'] === 'ft:Read');
    const link = read?.['ft:candidateEntity'] as { '@id': string } | undefined;
    return { commit: nodes.find((node) => node['@id'] === link?.['@id'])?.['ft:commitIdx'], read, gaps: result.gaps };
  };
  const [seedRow, fastRow, slowRow] = run({ beganAt: 1 }).commitLog;

  it.each([
    [
      'a neighbour that says an index further on than the step',
      [seedRow, { ...fastRow, idx: 7 }, { ...slowRow, idx: 2 }],
    ],
    ["a neighbour that repeats the step's index", [seedRow, { ...fastRow, idx: 2 }, { ...slowRow, idx: 2 }]],
  ])('%s: the stamped row is left out, and the gap says why', async (_name, rows) => {
    const { read, gaps } = await candidateOf(rows);
    expect(read).toBeUndefined();
    expect(gaps).toContainEqual({
      code: 'invalid-data',
      commitIdx: 2,
      reason: 'read stamps do not fit the commit index',
    });
  });

  it('one row that says an index far too large makes the stamped rows after it unplaceable: refused, not guessed', async () => {
    // The door cannot tell which row is the damaged one. It keeps the first and refuses the stamped row
    // that does not rise past it; the gap names the stamps, so a person can look at the indices around it.
    const { read, gaps } = await candidateOf([
      { ...seedRow, idx: 1e9 },
      { ...fastRow, idx: 1 },
      { ...slowRow, idx: 2 },
    ]);
    expect(read).toBeUndefined();
    expect(gaps).toContainEqual({
      code: 'invalid-data',
      commitIdx: 2,
      reason: 'read stamps do not fit the commit index',
    });
  });

  it.each([
    [
      'a slice whose middle row says no index',
      [{ ...seedRow, idx: 10 }, fastRow, { ...slowRow, idx: 12, beganAt: 11 }],
    ],
    [
      'a slice whose middle row says an index that is not a number',
      [
        { ...seedRow, idx: 10 },
        { ...fastRow, idx: 'x' },
        { ...slowRow, idx: 12, beganAt: 11 },
      ],
    ],
    [
      'a neighbour that repeats an earlier index',
      [
        { ...seedRow, idx: 0 },
        { ...fastRow, idx: 0 },
        { ...slowRow, idx: 2 },
      ],
    ],
    [
      'a row that could not be read at all, in a slice',
      [{ ...seedRow, idx: 10 }, null, { ...slowRow, idx: 12, beganAt: 11 }],
    ],
    [
      // The unread row is commit 11 and the row with no index after it is commit 12, where the step began:
      // each takes the next place in the order, never its bare position.
      'an unread row and then a row with no index, in a slice',
      [
        { ...seedRow, idx: 10 },
        null,
        fastRow,
        { runtimeStageId: 'other#3', trace: [], idx: 13 },
        { ...slowRow, idx: 14, beganAt: 12 },
      ],
    ],
  ])('%s: it keeps its place in the order, and the candidate is the real one', async (_name, rows) => {
    expect((await candidateOf(rows as object[])).commit).toBe(0);
  });

  it('a row that says no index, in a record with rows taken out: no one candidate, and the export says so', async () => {
    // Found by the second reader (round 4). The whole log: 0 seed, 1 to 3 (not handed over), 4 fast, 5 slow,
    // which began at 2 and so read seed's x. With `fast` saying no index the door used to write the next
    // index on its copy, `fast` looked seen by `slow`, and it was exported as the candidate.
    const stepAt5 = { ...slowRow, idx: 5, beganAt: 2 };
    const holed = await candidateOf([{ ...seedRow, idx: 0 }, fastRow, stepAt5]);
    expect(holed.read?.['ft:basis']).toBe('unknown');
    expect(holed.read).not.toHaveProperty('ft:candidateEntity');
    expect(holed.gaps).toContainEqual(NOT_ONE_BINDING);
    // Said, there is one candidate either way.
    expect((await candidateOf([{ ...seedRow, idx: 0 }, { ...fastRow, idx: 4 }, stepAt5])).commit).toBe(0);
    expect((await candidateOf([{ ...seedRow, idx: 0 }, { ...fastRow, idx: 1 }, stepAt5])).commit).toBe(1);
  });

  it('a row that could not be read, in a record with rows taken out, is never a source and moves no window', async () => {
    // seed 0, an unreadable row, fast 4, slow 5 began at 4: the unreadable row is one of the commits 1 to
    // 3, seen by the step whichever it is. It holds no write, so the candidate is seed for certain.
    const rows = [{ ...seedRow, idx: 0 }, null, { ...fastRow, idx: 4 }, { ...slowRow, idx: 5, beganAt: 4 }];
    const { commit, gaps } = await candidateOf(rows as object[]);
    expect(commit).toBe(0);
    expect(gaps).not.toContainEqual(NOT_ONE_BINDING);
  });

  it('a row that could not be read keeps its place: rows that leave it no room contradict the record', async () => {
    // Row 1 cannot be read, and rows 2 and 3 say they are commits 1 and 2: one row too many for those
    // indices. The door cannot tell which of them is damaged, so the stamped row counts against nothing.
    const rows = [{ ...seedRow, idx: 0 }, null, { ...fastRow, idx: 1 }, { ...slowRow, idx: 2 }];
    const { read, gaps } = await candidateOf(rows as object[]);
    expect(read).toBeUndefined();
    expect(gaps).toContainEqual({
      code: 'invalid-data',
      commitIdx: 3,
      reason: 'read stamps do not fit the commit index',
    });
  });

  it('rows that say their own index are read by it: a slice of a log keeps its windows', async () => {
    // Rows 0 to 2 of this export were commits 7 to 9 of their log; the last began when that log held 8.
    const sliced = run({ beganAt: 8 });
    sliced.commitLog.forEach((row, at) => Object.assign(row, { idx: 7 + at }));
    const result = await exportProv(sliced, { base: 'urn:test:window/' });
    const nodes = result.document['@graph'];
    const read = nodes.find((node) => node['@type'] === 'ft:Read');
    const candidate = nodes.find((node) => node['@id'] === (read?.['ft:candidateEntity'] as { '@id': string })['@id']);
    expect(candidate?.['ft:commitIdx']).toBe(0);
  });
});
