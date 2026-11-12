/**
 * controlDepsFromMap — the door from a SAVED control map to `causalChain`'s `controlDeps` option.
 *
 * What is pinned: a map that went through a file walks back exactly as the live lookup did; the map is
 * data someone else may have written (inherited names, getters, wrong shapes) and the lookup never
 * throws and never hands such data to the walk; and a `controlDeps` that is not a function is refused
 * at the call, by name, with the helper to use instead.
 */
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import {
  causalChain,
  controlDepsFromMap,
  flattenCausalDAG,
  formatCausalChain,
  keysReadFromMap,
  sliceForKey,
  type CommitBundle,
  type ControlDepLookup,
} from '../../../src';

function commit(stageId: string, runtimeStageId: string, keysWritten: string[], idx: number): CommitBundle {
  return {
    idx,
    stage: stageId,
    stageId,
    runtimeStageId,
    trace: keysWritten.map((k) => ({ path: k, verb: 'set' as const })),
    redactedPaths: [],
    overwrite: Object.fromEntries(keysWritten.map((k) => [k, `val-${k}`])),
    updates: {},
  };
}

/** seed writes score; route reads it and decides; high writes result (the chosen branch). */
const log = [
  commit('seed', 'seed#0', ['score'], 0),
  commit('route', 'route#1', [], 1),
  commit('high', 'high#2', ['result'], 2),
];
const reads = keysReadFromMap({ 'route#1': ['score'], 'high#2': [] });
const saved = { 'high#2': { deciderId: 'route#1', label: 'score over 50' } };
const live: ControlDepLookup = (id) => (id === 'high#2' ? { deciderId: 'route#1', label: 'score over 50' } : undefined);

describe('a saved control map walks back as the live lookup did', () => {
  it('gives the same chain after a trip through JSON', () => {
    const fromFile = JSON.parse(JSON.stringify(saved));
    const viaMap = causalChain(log, 'high#2', reads.lookup, { controlDeps: controlDepsFromMap(fromFile) })!;
    const viaLive = causalChain(log, 'high#2', reads.lookup, { controlDeps: live })!;
    expect(formatCausalChain(viaMap)).toBe(formatCausalChain(viaLive));
    expect(flattenCausalDAG(viaMap).map((n) => n.runtimeStageId)).toEqual(['high#2', 'route#1', 'seed#0']);
    const control = viaMap.parentEdges.find((edge) => edge.kind === 'control')!;
    expect(control.parent.runtimeStageId).toBe('route#1');
    expect(control.key).toBe('score over 50');
  });

  it('is the same for sliceForKey, which passes the option through', () => {
    const slice = sliceForKey(log, 'result', reads, { controlDeps: controlDepsFromMap(saved) });
    const baseline = sliceForKey(log, 'result', reads, { controlDeps: live });
    expect(formatCausalChain(slice.root!)).toBe(formatCausalChain(baseline.root!));
    expect(flattenCausalDAG(slice.root!).map((n) => n.runtimeStageId)).toContain('route#1');
  });

  it('keeps an edge without a label, and an edge whose label is undefined', () => {
    const lookup = controlDepsFromMap({ a: { deciderId: 'd#1' }, b: { deciderId: 'd#1', label: undefined } });
    expect(lookup('a')).toEqual({ deciderId: 'd#1' });
    expect(lookup('b')).toEqual({ deciderId: 'd#1' });
    expect('label' in lookup('b')!).toBe(false);
  });

  it('returns a fresh edge with only the two fields the walk reads', () => {
    const entry = { deciderId: 'd#1', label: 'rule', extra: 'ignored' };
    const edge = controlDepsFromMap({ 'x#2': entry })('x#2')!;
    expect(edge).toEqual({ deciderId: 'd#1', label: 'rule' });
    expect(edge).not.toBe(entry);
  });

  it('answers undefined for a step the map does not hold', () => {
    expect(controlDepsFromMap(saved)('seed#0')).toBeUndefined();
  });

  it('accepts a null-prototype object and a plain object made in another realm', () => {
    const bare = Object.assign(Object.create(null), saved);
    expect(controlDepsFromMap(bare)('high#2')).toEqual(saved['high#2']);
    const foreign = runInNewContext("({ 'high#2': { deciderId: 'route#1' } })");
    expect(controlDepsFromMap(foreign)('high#2')).toEqual({ deciderId: 'route#1' });
  });
});

describe('the map is data from a file: only own data, only the shape the walk needs', () => {
  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'])(
    'reads nothing through the prototype for the id %s',
    (id) => {
      expect(controlDepsFromMap({})(id)).toBeUndefined();
      expect(controlDepsFromMap({ 'a#0': { deciderId: 'd#1' } })(id)).toBeUndefined();
    },
  );

  it('reads an own property named __proto__ as data', () => {
    const parsed = JSON.parse('{"__proto__": {"deciderId": "d#1"}}');
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expect(controlDepsFromMap(parsed)('__proto__')).toEqual({ deciderId: 'd#1' });
  });

  it('never runs a getter, on the map or on an entry', () => {
    let ran = 0;
    const map: Record<string, unknown> = {};
    Object.defineProperty(map, 'get#1', {
      enumerable: true,
      get() {
        ran++;
        return { deciderId: 'd#1' };
      },
    });
    const entry = {};
    Object.defineProperty(entry, 'deciderId', {
      enumerable: true,
      get() {
        ran++;
        return 'd#1';
      },
    });
    map['entry#2'] = entry;
    const labelled = { deciderId: 'd#1' };
    Object.defineProperty(labelled, 'label', {
      enumerable: true,
      get() {
        ran++;
        return 'rule';
      },
    });
    map['label#3'] = labelled;
    const lookup = controlDepsFromMap(map as never);
    expect([lookup('get#1'), lookup('entry#2'), lookup('label#3')]).toEqual([undefined, undefined, undefined]);
    expect(ran).toBe(0);
  });

  it('does not read a deciderId or label an entry only inherits', () => {
    const inherited = Object.create({ deciderId: 'd#1', label: 'rule' });
    expect(controlDepsFromMap({ 'a#0': inherited })('a#0')).toBeUndefined();
    const half = Object.create({ label: 'rule' });
    half.deciderId = 'd#1';
    expect(controlDepsFromMap({ 'a#0': half })('a#0')).toEqual({ deciderId: 'd#1' });
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['a string', 'd#1'],
    ['a number', 7],
    ['an array', ['d#1']],
    ['an empty object', {}],
    ['a deciderId that is a number', { deciderId: 7 }],
    ['a deciderId that is an object', { deciderId: { id: 'd#1' } }],
    ['a deciderId that is undefined', { deciderId: undefined }],
    ['a label that is a number', { deciderId: 'd#1', label: 3 }],
    ['a label that is null', { deciderId: 'd#1', label: null }],
    ['a label that is an object', { deciderId: 'd#1', label: { text: 'x' } }],
  ])('gives undefined for %s', (_name, entry) => {
    expect(controlDepsFromMap({ 'a#0': entry } as never)('a#0')).toBeUndefined();
  });

  it('never throws at lookup time, whatever it is asked or finds', () => {
    const throwing = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('trap');
        },
      },
    );
    const lookup = controlDepsFromMap({ 'a#0': throwing } as never);
    expect(lookup('a#0')).toBeUndefined();
    const revocable = Proxy.revocable({ 'b#1': { deciderId: 'd#1' } }, {});
    const revoked = controlDepsFromMap(revocable.proxy);
    revocable.revoke();
    expect(revoked('b#1')).toBeUndefined();
    expect(lookup(undefined as never)).toBeUndefined();
    expect(lookup(Symbol('s') as never)).toBeUndefined();
    expect(lookup(7 as never)).toBeUndefined();
  });

  it('reads the caller object LIVE, like keysReadFromMap: a later entry and a later edit are seen', () => {
    const map: Record<string, { deciderId: string; label?: string }> = { 'a#1': { deciderId: 'd#0' } };
    const lookup = controlDepsFromMap(map);
    expect(lookup('b#2')).toBeUndefined();
    map['b#2'] = { deciderId: 'd#1', label: 'late' };
    map['a#1'].deciderId = 'd#9';
    expect(lookup('b#2')).toEqual({ deciderId: 'd#1', label: 'late' });
    expect(lookup('a#1')).toEqual({ deciderId: 'd#9' });
    delete map['b#2'];
    expect(lookup('b#2')).toBeUndefined();
  });

  it('hands the walk an edge it can use only when the decider is in the log: a hostile id is just no edge', () => {
    const hostile = controlDepsFromMap({ 'high#2': { deciderId: 'ghost#99' } });
    const root = causalChain(log, 'high#2', reads.lookup, { controlDeps: hostile })!;
    expect(root.parentEdges.filter((edge) => edge.kind === 'control')).toEqual([]);
  });
});

describe('what the lookup does not decide', () => {
  it('asks nothing of the log: a decider that ran AFTER the step is linked as the map names it', () => {
    // The order check (a decider must come before the step it governs) is the cause layer's own, made where the
    // log is in hand; a map-only lookup has no log. A reader who needs it checks the map against the log first.
    const lookup = controlDepsFromMap({ 'route#1': { deciderId: 'high#2' } });
    const root = causalChain(log, 'route#1', reads.lookup, { controlDeps: lookup })!;
    expect(
      root.parentEdges.filter((edge) => edge.kind === 'control').map((edge) => edge.parent.runtimeStageId),
    ).toEqual(['high#2']);
  });
});

describe('controlDepsFromMap refuses a map that is not a plain object', () => {
  it.each<[string, unknown, string]>([
    ['undefined', undefined, 'undefined'],
    ['null', null, 'null'],
    ['an array', [], 'an array'],
    ['a Map', new Map([['a#1', { deciderId: 'd#1' }]]), 'a Map'],
    ['a string', '{"a#1":{"deciderId":"d#1"}}', 'a string'],
    ['a number', 3, 'a number'],
    ['a function', () => undefined, 'a function'],
    ['a class instance', new (class Saved {})(), 'an object'],
    ['a Date', new Date(0), 'an object'],
  ])('%s', (_name, value, got) => {
    expect(() => controlDepsFromMap(value as never)).toThrow(TypeError);
    expect(() => controlDepsFromMap(value as never)).toThrow(/^controlDepsFromMap: expected a plain object/);
    expect(() => controlDepsFromMap(value as never)).toThrow(new RegExp(`got ${got}$`));
  });

  it('a Proxy whose prototype trap throws is refused with the same TypeError', () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('trap');
        },
      },
    );
    expect(() => controlDepsFromMap(hostile)).toThrow(TypeError);
    expect(() => controlDepsFromMap(hostile)).toThrow(/^controlDepsFromMap: expected a plain object/);
  });
});

describe('a controlDeps that is not a function is refused at the call', () => {
  const message = /^causalChain: controlDeps must be a function; for a saved map use controlDepsFromMap\(map\)/;

  it.each<[string, unknown]>([
    ['the saved object', saved],
    ['an empty object', {}],
    ['a Map', new Map()],
    ['null', null],
    ['an array', []],
    ['a string', 'high#2'],
    ['a number', 1],
    ['an object that has a lookup method', { lookup: live }],
  ])('causalChain, given %s', (_name, value) => {
    expect(() => causalChain(log, 'high#2', reads.lookup, { controlDeps: value as never })).toThrow(TypeError);
    expect(() => causalChain(log, 'high#2', reads.lookup, { controlDeps: value as never })).toThrow(message);
  });

  it('refuses before looking at the log: an empty log and an unknown start id are refused too', () => {
    expect(() => causalChain([], 'nothing#0', reads.lookup, { controlDeps: saved as never })).toThrow(message);
    expect(() => causalChain(log, 'nothing#0', reads.lookup, { controlDeps: saved as never })).toThrow(message);
  });

  it('sliceForKey refuses it too, also where the walk would never start (an empty log, a key never written)', () => {
    const sliceMessage = /^sliceForKey: controlDeps must be a function; for a saved map use controlDepsFromMap\(map\)/;
    expect(() => sliceForKey(log, 'result', reads, { controlDeps: saved as never })).toThrow(sliceMessage);
    expect(() => sliceForKey([], 'result', reads, { controlDeps: saved as never })).toThrow(TypeError);
    expect(() => sliceForKey(log, 'never-written', reads, { controlDeps: saved as never })).toThrow(sliceMessage);
  });

  it('says what it was given, so the mistake can be found', () => {
    expect(() => causalChain(log, 'high#2', reads.lookup, { controlDeps: saved as never })).toThrow(
      /\(got an object\)$/,
    );
    expect(() => causalChain(log, 'high#2', reads.lookup, { controlDeps: new Map() as never })).toThrow(
      /\(got a Map\)$/,
    );
    expect(() => causalChain(log, 'high#2', reads.lookup, { controlDeps: null as never })).toThrow(/\(got null\)$/);
  });

  it('leaves the accepted ways alone: a function, and no option at all', () => {
    expect(() => causalChain(log, 'high#2', reads.lookup, { controlDeps: live })).not.toThrow();
    expect(() => causalChain(log, 'high#2', reads.lookup, { controlDeps: controlDepsFromMap(saved) })).not.toThrow();
    expect(() => causalChain(log, 'high#2', reads.lookup, { controlDeps: undefined })).not.toThrow();
    expect(() => causalChain(log, 'high#2', reads.lookup, {})).not.toThrow();
    expect(() => causalChain(log, 'high#2', reads.lookup)).not.toThrow();
    expect(() => sliceForKey(log, 'result', reads, { controlDeps: live })).not.toThrow();
    expect(() => sliceForKey(log, 'result', reads)).not.toThrow();
  });
});
