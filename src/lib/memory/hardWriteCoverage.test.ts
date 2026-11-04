import { describe, expect, it } from 'vitest';

import { hardWriteCovers } from './hardWriteCoverage.js';
import { normalisePath } from '../record-paths/codec.js';

const covers = (writes: (string | number)[][], path: (string | number)[]) =>
  hardWriteCovers(new Set(writes.map(normalisePath)), path);

describe('hard-write path coverage', () => {
  it('covers the written path and its descendants', () => {
    expect(covers([['cfg']], ['cfg'])).toBe(true);
    expect(covers([['cfg']], ['cfg', 'gone'])).toBe(true);
    expect(covers([['cfg', 'gone']], ['cfg', 'gone', 'child'])).toBe(true);
  });

  it('does not make a child write own its parent or sibling', () => {
    expect(covers([['cfg', 'gone']], ['cfg'])).toBe(false);
    expect(covers([['cfg', 'gone']], ['cfg', 'later'])).toBe(false);
  });

  it('keeps similar segment names separate', () => {
    expect(covers([['a']], ['ab'])).toBe(false);
    expect(covers([['a', 'b']], ['a', 'bc'])).toBe(false);
    expect(covers([['ab']], ['a', 'b'])).toBe(false);
  });

  it('preserves literal dotted keys', () => {
    expect(covers([['a.b']], ['a.b', 'child'])).toBe(true);
    expect(covers([['a.b']], ['a', 'b'])).toBe(false);
    expect(covers([['a', 'b']], ['a.b'])).toBe(false);
  });

  it('normalizes numeric array indices as the writer does', () => {
    expect(covers([['items', 0]], ['items', '0', 'value'])).toBe(true);
    expect(covers([['items', '0']], ['items', 1])).toBe(false);
  });

  it('preserves empty segments', () => {
    expect(covers([['']], ['', 'child'])).toBe(true);
    expect(covers([['a', '']], ['a', '', 'child'])).toBe(true);
    expect(covers([['a', '']], ['a', 'child'])).toBe(false);
  });

  it('does not confuse an empty path with an empty-string key', () => {
    expect(covers([['']], [])).toBe(false);
    expect(covers([['']], [''])).toBe(true);
  });

  it('leaves paths uncovered when nothing hard-wrote them', () => {
    expect(covers([], ['cfg', 'later'])).toBe(false);
    expect(covers([['other']], ['cfg', 'later'])).toBe(false);
  });
});
