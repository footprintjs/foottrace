import { expect, it } from 'vitest';
import { absolutePath } from './absolutePath.js';

it('keeps root and namespaced literal segments without encoding or mutating inputs', () => {
  const address = ['runs', 'one'];
  const path = ['a.b', ''];
  expect(absolutePath([], path, 'x/y')).toEqual(['a.b', '', 'x/y']);
  const actual = absolutePath(address, path, 'x\u001fy');
  expect(actual).toEqual(['runs', 'one', 'a.b', '', 'x\u001fy']);
  expect(actual).not.toBe(path);
  expect(address).toEqual(['runs', 'one']);
  expect(path).toEqual(['a.b', '']);
});
