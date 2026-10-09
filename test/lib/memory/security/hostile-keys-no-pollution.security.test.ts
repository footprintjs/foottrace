/** The primitive assertions split from footprintjs's mixed hostile-key suite at E3. */
import { afterEach, describe, expect, it } from 'vitest';

import { nativeDelete, nativeSet, ownChild, ownedRootOf, ownSpine } from '../../../../src/lib/memory/pathOps.js';
import { SharedMemory } from '../../../../src/lib/memory/SharedMemory.js';
import { applySmartMergeInto, DELIM, nextGeneration } from '../../../../src/lib/memory/utils.js';

const DENIED_NAMES = ['__proto__', 'constructor', 'prototype'] as const;

const SHARED_PROTOTYPES: object[] = [Object.prototype, Array.prototype, Function.prototype];

/** A failure in one case must not leave the next one (or the next file) polluted. */
afterEach(() => {
  for (const proto of SHARED_PROTOTYPES) delete (proto as Record<string, unknown>).polluted;
});

const clean = () => {
  for (const probe of [{}, [], Object.create(null) as object, () => undefined]) {
    expect((probe as Record<string, unknown>).polluted).toBeUndefined();
  }
  for (const proto of SHARED_PROTOTYPES) expect((proto as Record<string, unknown>).polluted).toBeUndefined();
};

/** Every object reachable from `root` by own enumerable keys has a standard prototype. */
function expectStandardPrototypes(root: unknown, where: string): void {
  const seen = new Set<object>();
  const stack: Array<[unknown, string]> = [[root, where]];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const [value, path] = next;
    if (value === null || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) {
      throw new Error(`${path} has a non-standard prototype`);
    }
    for (const key of Object.keys(value)) stack.push([(value as Record<string, unknown>)[key], `${path}.${key}`]);
  }
}

/** The denied names `value` holds as own keys, in order. */
const deniedOwnKeys = (value: unknown): string[] =>
  DENIED_NAMES.filter((name) => Object.prototype.hasOwnProperty.call(value, name));

// ── 1. primitives ─────────────────────────────────────────────────────────────

describe('1 — primitives: a path that names a denied segment is refused there', () => {
  it.each(DENIED_NAMES)('nativeSet writes nothing at a path ending in %s — at the root or one level down', (name) => {
    const root: Record<string, any> = { a: {} };
    nativeSet(root, [name], { polluted: 'leaf' });
    nativeSet(root, ['a', name], { polluted: 'leaf' });
    expect(Object.getPrototypeOf(root)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(root.a)).toBe(Object.prototype);
    expect(deniedOwnKeys(root)).toEqual([]);
    expect(deniedOwnKeys(root.a)).toEqual([]);
    clean();
  });

  it.each(DENIED_NAMES)('nativeDelete removes nothing at a path ending in %s, even an own data key', (name) => {
    const root = JSON.parse(`{"${name}":{"x":1},"a":{"${name}":{"x":1}}}`);
    nativeDelete(root, [name]);
    nativeDelete(root, ['a', name]);
    expect(deniedOwnKeys(root)).toEqual([name]);
    expect(deniedOwnKeys(root.a)).toEqual([name]);
  });

  it('ownSpine copies nothing through `__proto__`: neither the root nor a child changes prototype', () => {
    const owned = new WeakSet<object>();
    const root = ownedRootOf({ a: { k: 1 } }, owned);
    ownSpine(root, ['__proto__', 'x'], owned);
    ownSpine(root, ['a', '__proto__', 'x'], owned);
    expect(Object.getPrototypeOf(root)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(root.a)).toBe(Object.prototype);
  });

  it('ownChild answers nothing for a denied name, even where it is an own data key', () => {
    const parent = JSON.parse('{"__proto__":{"a":1},"constructor":{"a":1},"prototype":{"a":1}}');
    for (const name of DENIED_NAMES) expect(ownChild(parent, name)).toBeUndefined();
  });

  it.each(DENIED_NAMES)(
    'every replay refuses a row whose path ENDS at %s (live commit, fold, SharedMemory)',
    (name) => {
      for (const segs of [[name], ['a', name]]) {
        for (const verb of ['set', 'merge', 'append', 'delete'] as const) {
          const overwrite: Record<string, any> = {};
          const updates: Record<string, any> = {};
          let o = overwrite;
          let u = updates;
          for (const seg of segs.slice(0, -1)) {
            o = o[seg] = {};
            u = u[seg] = {};
          }
          // defineProperty makes the denied name a real own key of the bundle, as JSON.parse would.
          const own = { value: { polluted: 'row' }, enumerable: true, writable: true, configurable: true };
          Object.defineProperty(o, name, own);
          Object.defineProperty(u, name, own);
          const trace = [{ path: segs.join(DELIM), verb }];
          const base = Object.freeze({ a: Object.freeze({ k: 1 }) });
          const mem = new SharedMemory(undefined, { a: { k: 1 } });
          mem.applyPatch(overwrite, updates, trace);
          const states = [
            nextGeneration(base, updates, overwrite, trace),
            applySmartMergeInto(structuredClone(base), updates, overwrite, trace),
            mem.getState(),
          ];
          for (const state of states) {
            expect(state).toEqual({ a: { k: 1 } });
            expectStandardPrototypes(state, `${verb} ${segs.join('.')}`);
          }
        }
      }
      clean();
    },
  );
});
