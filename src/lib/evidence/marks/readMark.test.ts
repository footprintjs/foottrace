import { expect, it } from 'vitest';
import { admitMarks, retainValidMarks } from '../marks.js';

const policy = {
  refuse: () => new Error('fixed refusal'),
  descriptors: { translateTrapErrors: false, requireOwnValue: false },
};
const valid = { kind: 'error', reason: 'ERROR_RECORDED', evidence: ['proof'] };

it('keeps atomic descriptor order and captures each supplied field once', () => {
  const events: string[] = [];
  const wrap = <T extends object>(value: T, name: string): T =>
    new Proxy(value, {
      getPrototypeOf(target) {
        events.push(`${name}:prototype`);
        return Reflect.getPrototypeOf(target);
      },
      getOwnPropertyDescriptor(target, key) {
        events.push(`${name}:${String(key)}`);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
  const refs = wrap(['proof'], 'refs');
  const item = wrap({ ...valid, evidence: refs }, 'mark');
  const raw = wrap([item], 'list');
  expect(admitMarks(raw, policy)).toEqual([valid]);
  expect(events).toEqual([
    'list:prototype',
    'list:length',
    'list:0',
    'mark:prototype',
    'mark:kind',
    'mark:reason',
    'mark:evidence',
    'refs:prototype',
    'refs:length',
    'refs:0',
  ]);
});

it('reads both discriminants before rejecting an invalid kind, but no evidence', () => {
  const seen: string[] = [];
  const item = new Proxy(
    { ...valid, kind: '' },
    {
      getOwnPropertyDescriptor(target, key) {
        seen.push(String(key));
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    },
  );
  expect(() => admitMarks([item], policy)).toThrow('fixed refusal');
  expect(seen).toEqual(['kind', 'reason']);
});

it('retains strict caller-specific list and reference caps without raising them to query defaults', () => {
  expect(() => admitMarks([valid, valid], { ...policy, marks: 1 })).toThrow('fixed refusal');
  expect(() => admitMarks([{ ...valid, evidence: ['a', 'b'] }], { ...policy, refs: 1 })).toThrow('fixed refusal');
  expect(admitMarks([valid, valid], { ...policy, marks: 2, refs: 1 })).toEqual([valid, valid]);
});

it('does not invoke nested thenables, iterators or caller collection methods in either strategy', () => {
  let invoked = 0;
  const item = Object.defineProperty({ ...valid }, 'then', { get: () => (++invoked, undefined) });
  const raw = [item];
  Object.defineProperty(raw, Symbol.iterator, { get: () => (++invoked, undefined) });
  Object.defineProperty(raw, 'map', { get: () => (++invoked, undefined) });
  expect(admitMarks(raw, policy)).toEqual([valid]);
  expect(retainValidMarks(raw, policy)).toEqual({ marks: [valid], rejected: false });
  expect(invoked).toBe(0);
});
