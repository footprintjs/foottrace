/**
 * The PROV export and a `set` row the writer built on its step's view (`TraceEntry.builtOnView`).
 *
 * The export does not link a write to what it was built on (`docs/prov.md`): such a row is exported as
 * the write it is, byte for byte as the same row without the mark. Its door still reads the mark, for
 * one reason: a record from outside is checked once, at the door. A mark that cannot be one says the
 * producer and this reader do not agree about the row, and the commit is left out with the reason,
 * never exported with the mark quietly dropped.
 *
 * Test types: regression (a marked row exports as before), security (a mark that cannot be one).
 */
import { describe, expect, it } from 'vitest';

import { exportProv } from '../../../src/prov.js';

/** `start` sets a; `fill` sets a (the row under test); `use` reads a and writes `out`. */
const run = (row: object) => ({
  commitLog: [
    { runtimeStageId: 'start#0', trace: [{ path: 'a', verb: 'set' }] },
    { runtimeStageId: 'fill#1', trace: [{ path: 'a', verb: 'set', ...row }] },
    { runtimeStageId: 'use#2', trace: [{ path: 'out', verb: 'set', readKeys: ['a'] }] },
  ],
});
const exported = (row: object) => exportProv(run(row), { base: 'urn:test:view/' });

describe('the PROV export and a row the writer built on the view', () => {
  it('a marked row exports exactly as the same row without the mark', async () => {
    const plain = await exported({});
    const marked = await exported({ builtOnView: true });
    expect(marked.document).toEqual(plain.document);
    expect(marked.gaps).toEqual(plain.gaps);
  });

  it.each([
    ['a value that is not the mark', { builtOnView: 'yes' }],
    ['false', { builtOnView: false }],
    ['the mark on a row that is not a set', { builtOnView: true, verb: 'merge' }],
  ])('%s: the commit is left out and the gap says so', async (_name, row) => {
    const plain = await exported({});
    const damaged = await exported(row);
    expect(damaged.gaps).toContainEqual({ code: 'invalid-data', commitIdx: 1, reason: 'unreadable commit bundle' });
    expect(damaged.document['@graph'].length).toBeLessThan(plain.document['@graph'].length);
  });
});
