import { describe, expect, it } from 'vitest';
import { admission, name } from './data.js';

// Fixed UTF-8 byte totals, independent of the implementation's counter.
// Unpaired UTF-16 surrogates use the same replacement encoding as TextEncoder.
describe('the 64 KiB reference-name envelope counts encoded bytes', () => {
  it.each([
    ['ASCII', 'a'.repeat(1024), 64, 0],
    ['two-byte scalar', 'é'.repeat(512), 64, 0],
    ['three-byte scalar', '漢'.repeat(341), 64, 64],
    ['surrogate pair', '😀'.repeat(256), 64, 0],
    ['lone high surrogate', '\ud800'.repeat(341), 64, 64],
    ['lone low surrogate', '\udc00'.repeat(341), 64, 64],
    ['separated surrogates', '\ud800a\udc00'.repeat(128), 73, 128],
  ] as const)('admits exactly 65,536 bytes of %s, then refuses one more', (_, chunk, count, remainder) => {
    const state = admission({ left: 1000 });
    for (let index = 0; index < count; index++) expect(name(chunk, state)).toBe(chunk);
    if (remainder) expect(name('a'.repeat(remainder), state)).toBe('a'.repeat(remainder));
    expect(() => name('x', state)).toThrow(expect.objectContaining({ code: 'node-limit' }));
  });

  it('counts a pair within one name once, and does not pair surrogates across separate names', () => {
    const state = admission({ left: 1000 });
    for (let index = 0; index < 63; index++) name('a'.repeat(1024), state);
    name('a'.repeat(1018), state);
    name('\ud800', state);
    name('\udc00', state);
    expect(() => name('x', state)).toThrow(expect.objectContaining({ code: 'node-limit' }));
  });
});
