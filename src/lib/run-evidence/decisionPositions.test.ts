import { describe, expect, it } from 'vitest';

import { evidenceStore } from '../../../test/helpers/evidenceFixture';
import { readStoredRecord } from '../time-travel/storedRecord.js';
import { readDecisionWindow } from './decisionPositions.js';

const root = ['r'];

function recording(reverse = false) {
  const store = evidenceStore();
  store.commit(root, 'first#0', {});
  if (reverse) store.note(root, 'run.decision', { id: 'decision#1', by: 'plain', chosen: 'continue' });
  store.commit(root, 'decision#1', { parent: 'first#0' });
  if (!reverse) store.note(root, 'run.decision', { id: 'decision#1', by: 'plain', chosen: 'continue' });
  store.commit(root, 'branch#2', { parent: 'decision#1' });
  store.close(root);
  const log = readStoredRecord(store.entries()).root('r');
  if (!log) throw new Error('Missing fixture log');
  return log;
}

describe('durable decision positions in a skipped-path window', () => {
  it('includes a decision after its own changing commit and before the next commit', () => {
    const result = readDecisionWindow(recording(), 2, 1, { left: 1000 });
    expect(result.decisions).toMatchObject([
      { decision: { id: 'decision#1', chosen: 'continue' }, commitPosition: 1, entryPosition: 3 },
    ]);
    expect(result.gaps).toEqual([]);
  });

  it('marks an in-window decision before capture start as uncollected', () => {
    const log = recording();
    for (const from of [0, 1]) {
      expect(readDecisionWindow(log, 3, 0, { left: 1000 }, from)).toMatchObject({
        decisions: [{ decision: { id: 'decision#1' }, commitPosition: 1 }],
        gaps: [],
      });
    }
    expect(readDecisionWindow(log, 3, 0, { left: 1000 }, 2)).toMatchObject({
      decisions: [],
      gaps: ['not-collected'],
    });
    expect(readDecisionWindow(log, 3, 2, { left: 1000 }, 2)).toMatchObject({
      decisions: [],
      gaps: [],
    });
  });

  it('locates a late decision note by its earlier commit when testing capture coverage', () => {
    const store = evidenceStore();
    store.commit(root, 'first#0', {});
    store.commit(root, 'decision#1', { parent: 'first#0' });
    store.commit(root, 'branch#2', { parent: 'decision#1' });
    store.note(root, 'run.decision', { id: 'decision#1', by: 'plain', chosen: 'continue' });
    store.close(root);
    const log = readStoredRecord(store.entries()).root('r')!;

    expect(readDecisionWindow(log, 3, 0, { left: 1000 }, 1)).toMatchObject({
      decisions: [{ decision: { id: 'decision#1' }, commitPosition: 1, entryPosition: 4 }],
      gaps: [],
    });
    expect(readDecisionWindow(log, 3, 0, { left: 1000 }, 2)).toMatchObject({
      decisions: [],
      gaps: ['not-collected'],
    });
  });

  it('excludes choices at a later commit and fails closed if its raw order was reversed', () => {
    expect(readDecisionWindow(recording(), 1, undefined, { left: 1000 }).decisions).toEqual([]);
    const reversed = readDecisionWindow(recording(true), 2, undefined, { left: 1000 });
    expect(reversed.decisions).toEqual([]);
    expect(reversed.gaps).toContain('conservative');
  });

  it('requires a verified opening and charges the row budget before admission', () => {
    const log = recording();
    expect(readDecisionWindow(log, 2, undefined, { left: 1 }).gaps).toEqual(['truncated']);
    expect(readDecisionWindow({ ...log, entries: log.entries.slice(1) }, 2, undefined, { left: 1000 }).gaps).toEqual([
      'not-collected',
    ]);
  });
});
