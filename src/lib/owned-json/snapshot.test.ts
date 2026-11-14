import { expect, it } from 'vitest';
import { ownedJsonSnapshot } from './snapshot.js';
import { OwnedJsonError } from './types.js';
import { utf8Bytes } from './utf8.js';

const bounds = {
  maxDepth: 16,
  maxNodes: 64,
  maxFields: 64,
  maxStringBytes: 4096,
  maxSortWork: 4096,
  maxBytes: 4096,
};

it('returns the same sorted JSON, with detached deeply frozen data and exact UTF-8 bytes', () => {
  const input = { '2': 2, '10': 10, nested: ['€😀', -0] };
  const snapshot = ownedJsonSnapshot(input, bounds);
  expect(snapshot.text).toBe('{"10":10,"2":2,"nested":["€😀",0]}');
  expect(snapshot.bytes).toBe(Buffer.byteLength(snapshot.text, 'utf8'));
  expect(snapshot.value).not.toBe(input);
  expect(Object.isFrozen(snapshot.value)).toBe(true);
  expect(Object.isFrozen((snapshot.value as typeof input).nested)).toBe(true);
  input.nested[0] = 'changed';
  expect(snapshot.text).toContain('€😀');
  expect((snapshot.value as typeof input).nested[0]).toBe('€😀');
  expect(Object.isFrozen(input)).toBe(false);
});

it('charges raw Unicode and escaped canonical output independently at their exact boundaries', () => {
  expect(ownedJsonSnapshot('€😀', { ...bounds, maxStringBytes: 7, maxBytes: 9 }).bytes).toBe(9);
  expect(() => ownedJsonSnapshot('€😀', { ...bounds, maxStringBytes: 6 })).toThrowError(
    new OwnedJsonError('string-bytes'),
  );
  expect(() => ownedJsonSnapshot('€😀', { ...bounds, maxBytes: 8 })).toThrowError(new OwnedJsonError('output-bytes'));
  expect(ownedJsonSnapshot('\n', { ...bounds, maxStringBytes: 1, maxBytes: 4 }).bytes).toBe(4);
});

it.each(['\ud800', '\udfff', 'a\ud800x'])('rejects a lone surrogate before counting its bytes: %s', (input) => {
  expect(() => ownedJsonSnapshot(input, bounds)).toThrowError(new OwnedJsonError('unicode'));
});

it('refuses getters without executing them and charges shared objects on every occurrence', () => {
  let calls = 0;
  const getter = Object.defineProperty({}, 'secret', { enumerable: true, get: () => ++calls });
  expect(() => ownedJsonSnapshot(getter, bounds)).toThrowError(new OwnedJsonError('unsupported'));
  expect(calls).toBe(0);
  const shared = { value: 1 };
  expect(ownedJsonSnapshot([shared, shared], bounds).text).toBe('[{"value":1},{"value":1}]');
  expect(() => ownedJsonSnapshot([shared, shared], { ...bounds, maxNodes: 4 })).toThrowError(
    new OwnedJsonError('nodes'),
  );
});

it.each(['ASCII', 'é', '€', '😀', 'e\u0301', JSON.stringify('\ud800')])(
  'counts supported UTF-8 text exactly without an encoder capability: %s',
  (text) => expect(utf8Bytes(text)).toBe(Buffer.byteLength(text, 'utf8')),
);
