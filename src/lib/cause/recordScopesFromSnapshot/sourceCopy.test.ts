import { expect, it, vi } from 'vitest';
import { dataCopy, recordRefusalCode } from '../recordValidation.js';

const projection = { allowShared: true };

it('charges the same allowance for separate and shared copies of source evidence', () => {
  const source = Object.freeze({ kind: 'committed', commitIdx: 1 });
  const live = [source, source, source];
  const saved = JSON.parse(JSON.stringify(live));
  const left = { left: 100 },
    right = { left: 100 };
  expect(dataCopy(live, left, projection)).toEqual(dataCopy(saved, right, projection));
  expect(left.left).toBe(right.left);
  const required = 100 - left.left;
  for (const input of [live, saved]) {
    expect(() => dataCopy(input, { left: required }, projection)).not.toThrow();
    expect(() => dataCopy(input, { left: required - 1 }, projection)).toThrow();
  }
  // Other record channels still apply their existing repeated-identity policy.
  expect(() => dataCopy(live, { left: 100 })).toThrow();
});

it('refuses a reference back to an ancestor and a source accessor', () => {
  const parent: { child?: unknown } = {};
  parent.child = { parent };
  const read = vi.fn(() => 1);
  for (const value of [parent, Object.defineProperty({}, 'commitIdx', { get: read, enumerable: true })]) {
    let code;
    try {
      dataCopy(value, { left: 100 }, projection);
    } catch (error) {
      code = recordRefusalCode(error);
    }
    expect(code).toBe('invalid-data');
  }
  expect(read).not.toHaveBeenCalled();
});
