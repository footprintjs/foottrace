import { describe, expect, it } from 'vitest';
import { canonicalizeJson } from './canonical.js';
import { CanonicalJsonError } from './types.js';

describe('strict canonical JSON', () => {
  it('sorts raw UTF-16 names, including integer-like names, recursively', () => {
    expect(canonicalizeJson({ '2': 2, '10': 10, z: { b: 2, a: 1 } })).toBe('{"10":10,"2":2,"z":{"a":1,"b":2}}');
    expect(
      canonicalizeJson({ '\u20ac': 1, '\r': 2, '\ufb33': 3, '1': 4, '\ud83d\ude00': 5, '\u0080': 6, '\u00f6': 7 }),
    ).toBe('{"\\r":2,"1":4,"\u0080":6,"\u00f6":7,"\u20ac":1,"\ud83d\ude00":5,"\ufb33":3}');
  });
  it('keeps strings and array order, normalizes negative zero, and accepts finite binary64 values', () => {
    expect(canonicalizeJson([-0, 333333333.33333329, 1e30, 4.5, 2e-3, 1e-27, 'e\u0301', '\u00e9'])).toBe(
      '[0,333333333.3333333,1e+30,4.5,0.002,1e-27,"e\u0301","\u00e9"]',
    );
    expect(canonicalizeJson(9007199254740992)).toBe('9007199254740992');
  });
  it('does not invoke getters or toJSON, or freeze borrowed values', () => {
    let reads = 0;
    const getter = Object.defineProperty({}, 'secret', { enumerable: true, get: () => ++reads });
    const custom = { toJSON: () => ++reads };
    expect(() => canonicalizeJson(getter)).toThrow();
    expect(() => canonicalizeJson(custom)).toThrow();
    expect(reads).toBe(0);
    const borrowed = { a: [1] };
    expect(canonicalizeJson(borrowed)).toBe('{"a":[1]}');
    expect(Object.isFrozen(borrowed)).toBe(false);
    expect(Object.isFrozen(borrowed.a)).toBe(false);
  });
  it.each([
    undefined,
    NaN,
    Infinity,
    1n,
    Symbol('x'),
    () => 1,
    new Date(0),
    new Map(),
    new Array(1),
    '\ud800',
    '\udfff',
  ])('refuses unsupported data without a partial result: %s', (value) =>
    expect(() => canonicalizeJson(value)).toThrow(),
  );
  it('refuses cycles but expands and charges shared acyclic values per occurrence', () => {
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(() => canonicalizeJson(cycle)).toThrow();
    const shared = { a: 1 };
    expect(canonicalizeJson([shared, shared])).toBe('[{"a":1},{"a":1}]');
    expect(() => canonicalizeJson([shared, shared], { maxNodes: 4 })).toThrow();
  });
  it('preserves prototype-shaped names as data and refuses unsupported own members', () => {
    const value = JSON.parse('{"__proto__":{"x":1},"constructor":2}');
    expect(canonicalizeJson(value)).toBe('{"__proto__":{"x":1},"constructor":2}');
    expect(({} as { x?: number }).x).toBeUndefined();
    expect(() => canonicalizeJson({ [Symbol('x')]: 1 })).toThrow();
    expect(() => canonicalizeJson(Object.defineProperty({}, 'hidden', { value: 1 }))).toThrow();
    expect(() => canonicalizeJson(Object.assign([1], { extra: 2 }))).toThrow();
  });
  it.each([
    [{ a: { b: 1 } }, { maxDepth: 1 }],
    [{ a: 1, b: 2 }, { maxFields: 1 }],
    ['\u20ac', { maxStringBytes: 2 }],
    ['\n', { maxBytes: 3 }],
    [{ b: 1, a: 2 }, { maxSortWork: 1 }],
  ])('refuses a bounded resource instead of returning a prefix', (value, options) => {
    expect(() => canonicalizeJson(value, options)).toThrow();
  });
  it('refuses option getters and impossible or unknown limits', () => {
    let reads = 0;
    const options = Object.defineProperty({}, 'maxBytes', { get: () => ++reads });
    for (const bad of [options, { maxBytes: Infinity }, { maxDepth: 10000 }, { maxNodes: 0 }, { extra: 1 }])
      expect(() => canonicalizeJson(null, bad as never)).toThrow();
    expect(reads).toBe(0);
  });
});

it('sanitizes even a forged public error thrown by a descriptor trap', () => {
  const forged = new CanonicalJsonError('unsupported');
  forged.message = 'SECRET';
  const input = new Proxy(
    {},
    {
      ownKeys: () => {
        throw forged;
      },
    },
  );
  try {
    canonicalizeJson(input);
    throw new Error('Expected refusal');
  } catch (error) {
    expect((error as Error).message).toBe('Canonical JSON refused: unsupported');
  }
});

// Factual binary64 vectors from RFC 8785 Appendix B, https://www.rfc-editor.org/rfc/rfc8785#appendix-B
it.each([
  ['0000000000000000', '0'],
  ['8000000000000000', '0'],
  ['0000000000000001', '5e-324'],
  ['8000000000000001', '-5e-324'],
  ['7fefffffffffffff', '1.7976931348623157e+308'],
  ['ffefffffffffffff', '-1.7976931348623157e+308'],
  ['4340000000000000', '9007199254740992'],
  ['c340000000000000', '-9007199254740992'],
  ['4430000000000000', '295147905179352830000'],
  ['44b52d02c7e14af5', '9.999999999999997e+22'],
  ['44b52d02c7e14af6', '1e+23'],
  ['44b52d02c7e14af7', '1.0000000000000001e+23'],
  ['444b1ae4d6e2ef4e', '999999999999999700000'],
  ['444b1ae4d6e2ef4f', '999999999999999900000'],
  ['444b1ae4d6e2ef50', '1e+21'],
  ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
  ['3eb0c6f7a0b5ed8d', '0.000001'],
  ['41b3de4355555553', '333333333.3333332'],
  ['41b3de4355555554', '333333333.33333325'],
  ['41b3de4355555555', '333333333.3333333'],
  ['41b3de4355555556', '333333333.3333334'],
  ['41b3de4355555557', '333333333.33333343'],
  ['becbf647612f3696', '-0.0000033333333333333333'],
  ['43143ff3c1cb0959', '1424953923781206.2'],
  ['7fffffffffffffff', null],
  ['7ff0000000000000', null],
])('serializes RFC binary64 %s', (hex, expected) => {
  const bytes = new DataView(new ArrayBuffer(8));
  bytes.setBigUint64(0, BigInt('0x' + hex));
  const value = bytes.getFloat64(0);
  if (expected === null) expect(() => canonicalizeJson(value)).toThrow();
  else expect(canonicalizeJson(value)).toBe(expected);
});
