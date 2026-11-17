import { expect, it } from 'vitest';
import { RecordFrame } from '../../write.js';

it('offers the explicit native paired-read entry without replacing value-only doors', () => {
  expect(typeof RecordFrame.prototype.readWithSource).toBe('function');
  expect(typeof RecordFrame.prototype.readTracked).toBe('function');
  expect(typeof Object.getOwnPropertyDescriptor(RecordFrame.prototype, 'readWithLocation')?.value).toBe('function');
});
