/**
 * equality.ts — structural equality of committed-state values: THE owner of
 * "what counts as a change". What `TransactionBuffer`'s net-change filter, the
 * admitted record's compare, the read model's writer rule and the
 * borrowed-mutation guard all ask. Its one import is the classifier of value
 * kinds (`capture/valueKinds.ts`, a leaf); re-exported from `utils.ts`, so no
 * importer moved.
 */

import { type ValueKind, kindOf } from '../capture/valueKinds.js';

/**
 * Structural deep equality for committed-state values.
 *
 * Used by {@link TransactionBuffer} to decide whether a stage actually CHANGED
 * a path or merely re-wrote / reverted it to the value it already held (a
 * "no-op write"), and by `borrowedMutation.firstDifferingPath` to find where a
 * borrowed read moved. Committed state must survive `structuredClone`, so the
 * values it can hold are the kinds the clone keeps, and two values are equal
 * when a record holds the same thing for both. Every kind has ONE arm below
 * (`equalPairs`' switch over `ValueKind` — a kind added to the union does not
 * compile until it is compared). Before 9.22.0 a Date, Map or Set was compared
 * as an object with no own keys, and until 9.44.2 so were a RegExp, an Error,
 * a boxed primitive, an ArrayBuffer, a DataView and a Blob: any two of a kind
 * were "equal", so `$setValue('re', /y/g)` over `/x/g` committed no row and
 * live state kept the OLD value.
 *
 * Semantics:
 *   - reference / identical-primitive short-circuits first (cheap fast path)
 *   - `NaN` equals `NaN` (primitive compare falls back to `Object.is`)
 *   - two values of different KINDS are never equal (a `Date` is never `{}`,
 *     an array never `{ 0: … }`)
 *   - `Date`: same `getTime()` (two invalid dates are equal)
 *   - `RegExp`: same `source` and `flags` (the clone resets `lastIndex`)
 *   - `Error`: the same restored kind (one of the six built-in error names,
 *     else `Error`), own `message`, `stack` and own `cause` (deep) — what the
 *     clone keeps; any other own field is dropped by it, so it never counts
 *     (the admitted record's law)
 *   - a boxed primitive: the same wrapper type and the same primitive inside
 *   - an `ArrayBuffer`: length, resizability and bytes; a typed array or a
 *     `DataView`: its type and the bytes IT views — never the rest of its
 *     buffer (a Node `Buffer` views a slice of a shared pool, and the record
 *     keeps the view's bytes only: `capture/freeze.ts · freezeRecord`)
 *   - `Map`: same size AND, per key of `a`, `b` holds a deep-equal value —
 *     keys by `Map` identity (`SameValueZero`), values deep
 *   - `Set`: same size AND every member of `a` is deep-equal to SOME member
 *     of `b` (order-insensitive — a Set has no order to compare by)
 *   - an OPAQUE value (a Blob, a `DOMException` — content this library cannot
 *     read): by the caller's {@link OpaqueRule} — equal only to itself by
 *     default (replacing one is always a change), or, when both sides are
 *     copies of one record, equal to any other of its kind
 *   - arrays: equal length AND deep-equal element-wise (order-sensitive; an
 *     array's expando keys are out of contract and not compared)
 *   - objects: identical set of keys that HOLD a value AND deep-equal per key.
 *     An own key whose value is `undefined` counts as ABSENT: it is this
 *     library's other spelling of a deleted key (`'full'` mode flattens
 *     `delete` into `key: undefined`; `'delta'` mode's `delete` verb removes
 *     the key), and every consumer — JSON, the fold, `commitValueAt`, the
 *     mirror — reads the two spellings as one state. So must the net-change
 *     filter (9.19.1): `{}` and `{ k: undefined }` are not a change. Arrays
 *     are untouched — a slot holding `undefined` is still a slot.
 *
 * Cost & safety:
 *   - Allocates only transient `Object.keys` arrays, an error's property
 *     descriptors and a byte view per compared buffer — no clones (but one
 *     probe clone per class prototype, remembered: `capture/valueKinds.ts ·
 *     kindOf`). It is strictly cheaper than the `structuredClone` the commit
 *     already performs.
 *   - Primitive comparisons (the bulk of state) are O(1) via the `===` /
 *     `Object.is` fast paths; only nested objects/arrays incur a walk, bounded
 *     by the value's own size.
 *   - Terminates on CYCLIC values (9.18.1): a state value must survive
 *     `structuredClone`, and `structuredClone` preserves cycles — so a
 *     self-referencing value is a legal value, not an out-of-contract one. A
 *     pair of objects already under comparison is treated as equal (the
 *     structural answer, lodash `isEqual` semantics); acyclic inputs see no
 *     change. Dev mode still warns about cycles at write time
 *     (`ScopeFacade.setValue`) because they surprise narrative and JSON.
 */
export function deepEqual(a: any, b: any, opaque: OpaqueRule = 'identity'): boolean {
  return equalPairs(a, b, undefined, opaque);
}

/**
 * How {@link deepEqual} compares two OPAQUE values (a Blob, a `DOMException` —
 * content this library cannot read):
 *
 *   - `'identity'` (the default) — equal only to itself. The answer when one
 *     side is a value a stage handed in: the net-change filter
 *     (`TransactionBuffer`), the append check (`deltaEncoding`). A new object
 *     is a change, because nothing can say it is not.
 *   - `'copies'` — equal to any other of its kind. The answer when BOTH sides
 *     are copies of one recorded value — a fold's generations (`logModel`,
 *     `elementProvenance`), a retained read against live state
 *     (`borrowedMutation`), the record replayed against the read-back
 *     (`admission`): copies never share identity, so identity would call every
 *     opaque value changed.
 */
export type OpaqueRule = 'identity' | 'copies';

/**
 * What a comparison knows about the object pairs it has met. Created lazily by
 * the first object pair, so primitive compares allocate nothing.
 *
 * A pair is in one of four states (the number stored for `a → b`):
 *
 *   - **still being compared** (its depth on the stack, `>= 0`). Meeting it
 *     again is a cycle: the pair is taken as equal BY ASSUMPTION, and the
 *     comparison that met it remembers how far up the assumption reaches
 *     ({@link SeenPairs.low}).
 *   - **`PROVEN`** equal, or **`DISPROVEN`**: compared to the end with nothing
 *     in the comparison leaning on a pair above it. A fact — true whatever
 *     happens to the comparisons around it.
 *   - **`LEANING`**: compared to the end and equal, but only as long as a pair
 *     still being compared above it is equal. It is kept on a list
 *     ({@link SeenPairs.leaning}) and answers "equal, by the same assumption"
 *     when met again, so a value that points back at itself is still walked
 *     once. The list is settled when the pair it leans on is: every entry
 *     made inside a comparison becomes `PROVEN` when that comparison ends
 *     equal with nothing above it leaned on, and is forgotten when it ends
 *     different.
 *
 * A "different" that leaned on a pair above it is never stored. It can be an
 * accident of the search: a set pairs its members greedily, and a member
 * paired on a wrong assumption can leave another member with no partner. That
 * is also what makes a set safe: it tries a member against candidates that do
 * not match, so a `false` there does not end the comparison, and nothing such
 * a failed try believed is left behind to be read later as known.
 *
 * (The bookkeeping is the one Tarjan's strongly-connected-components walk
 * keeps: `low` is the lowlink, the list is the component stack.)
 */
interface SeenPairs {
  /** `a → b → state` (see above). */
  readonly pairs: WeakMap<object, Map<object, number>>;
  /** The stack depth the next pair gets. */
  depth: number;
  /** The shallowest still-open pair the comparison in progress leaned on; `Infinity` for none. */
  low: number;
  /** The `LEANING` pairs, oldest first, each as the map and key that hold its state. */
  readonly leaning: Array<[Map<object, number>, object]>;
  /** The shallowest pair any entry of {@link leaning} leans on; `Infinity` when the list is empty. */
  leaningLow: number;
}

const PROVEN = -1;
const DISPROVEN = -2;
const LEANING = -3;

function equalPairs(a: any, b: any, seen: SeenPairs | undefined, opaque: OpaqueRule): boolean {
  if (a === b) return true; // same reference or identical primitive
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b; // one is null, the other isn't
  if (typeof a !== 'object') return Object.is(a, b); // NaN-safe primitive compare

  const kind = kindOf(a);
  if (kind !== kindOf(b)) return false;
  switch (kind) {
    // Atoms: their content is a slot, not their keys.
    case 'date':
      return Object.is(Date.prototype.getTime.call(a), Date.prototype.getTime.call(b));
    case 'regexp':
      return a.source === b.source && a.flags === b.flags;
    case 'boxed':
      return tagOf(a) === tagOf(b) && equalPairs(a.valueOf(), b.valueOf(), seen, opaque);
    case 'buffer':
      return equalBuffers(a, b);
    case 'view':
      return equalViews(a, b);
    case 'opaque':
      return opaque === 'copies' && tagOf(a) === tagOf(b); // `a === b` was answered above
    case 'plain':
    case 'array':
    case 'map':
    case 'set':
    case 'error':
      return equalContainers(a, b, kind, seen, opaque);
    default:
      return unknownKind(kind);
  }
}

/** The kinds whose content is other values: compared part by part, under the cycle guard. */
function equalContainers(a: any, b: any, kind: ValueKind, seen: SeenPairs | undefined, opaque: OpaqueRule): boolean {
  seen ??= { pairs: new WeakMap(), depth: 0, low: Infinity, leaning: [], leaningLow: Infinity };
  let partners = seen.pairs.get(a);
  const state = partners?.get(b);
  if (state === PROVEN) return true;
  if (state === DISPROVEN) return false;
  if (state !== undefined) {
    // Cycle guard — a pair we are already inside is equal by assumption. So is a pair that was
    // found equal on such an assumption: it reaches as far up as the list it is on does.
    const reach = state === LEANING ? seen.leaningLow : state;
    if (reach < seen.low) seen.low = reach;
    return true;
  }
  if (!partners) seen.pairs.set(a, (partners = new Map()));

  const depth = seen.depth++;
  const outerLow = seen.low;
  const leaningFrom = seen.leaning.length;
  const outerLeaningLow = seen.leaningLow;
  partners.set(b, depth);
  seen.low = Infinity;
  const equal = equalParts(a, b, kind, seen, opaque);
  seen.depth = depth;

  // Closed: nothing in this comparison leaned on a pair above it (a pair that met ITSELF again is
  // closed here: equal on the assumption that it is equal is equal). Then the answer is a fact.
  const closed = seen.low >= depth;
  if (closed || !equal) {
    // Whatever was found equal in here by leaning on this pair, or on a pair inside it, is settled
    // with it: proven when this is a proven equal, forgotten when this is different.
    for (let i = leaningFrom; i < seen.leaning.length; i++) {
      const [states, other] = seen.leaning[i];
      if (equal) states.set(other, PROVEN);
      else states.delete(other);
    }
    seen.leaning.length = leaningFrom;
    seen.leaningLow = outerLeaningLow;
  }
  if (closed) partners.set(b, equal ? PROVEN : DISPROVEN);
  else if (equal) {
    partners.set(b, LEANING);
    seen.leaning.push([partners, b]);
    if (seen.low < seen.leaningLow) seen.leaningLow = seen.low;
  } else partners.delete(b);
  // An answer that leaned on a pair above tells the comparisons in between, for either answer.
  seen.low = closed ? outerLow : Math.min(outerLow, seen.low);
  return equal;
}

/** The parts of two containers of one kind, compared in order; the first difference ends it. */
function equalParts(a: any, b: any, kind: ValueKind, seen: SeenPairs, opaque: OpaqueRule): boolean {
  if (kind === 'map') return equalMaps(a, b, seen, opaque);
  if (kind === 'set') return equalSets(a, b, seen, opaque);
  if (kind === 'error') return equalErrors(a, b, seen, opaque);
  if (kind === 'array') {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!equalPairs(a[i], b[i], seen, opaque)) return false;
    }
    return true;
  }

  // Objects: only keys that HOLD a value take part — an own `undefined` is a
  // deleted key, the same state as an absent one (see the contract above).
  let aHeld = 0;
  for (const key of Object.keys(a)) {
    if (a[key] === undefined) continue;
    aHeld++;
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!equalPairs(a[key], b[key], seen, opaque)) return false;
  }
  let bHeld = 0;
  for (const key of Object.keys(b)) if (b[key] !== undefined) bHeld++;
  return aHeld === bHeld;
}

function unknownKind(kind: never): never {
  throw new TypeError(`deepEqual: no comparison for the value kind '${String(kind)}'`);
}

/** `[object Number]`, `[object Uint8Array]` … — the built-in type a boxed value or a view carries. */
function tagOf(value: object): string {
  return Object.prototype.toString.call(value);
}

/** The same view type over the same bytes — the bytes the view sees, wherever they sit in its buffer. */
function equalViews(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (tagOf(a) !== tagOf(b) || a.byteLength !== b.byteLength) return false;
  if (a.buffer === b.buffer && a.byteOffset === b.byteOffset) return true;
  const p = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const q = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return false;
  return true;
}

/** The same length, resizability and bytes. */
function equalBuffers(a: ArrayBufferLike, b: ArrayBufferLike): boolean {
  if (a === b) return true;
  const x = a as ArrayBufferLike & { resizable?: boolean; maxByteLength?: number };
  const y = b as typeof x;
  if (x.byteLength !== y.byteLength || x.resizable !== y.resizable || x.maxByteLength !== y.maxByteLength) {
    return false;
  }
  const p = new Uint8Array(a);
  const q = new Uint8Array(b);
  for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return false;
  return true;
}

/** The six error names `structuredClone` restores; any other name comes back an `Error`. */
const ERROR_NAMES = new Set(['EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError']);

/**
 * Two errors as the clone keeps them: the restored kind, the own `message`,
 * the `stack` and the own `cause` (deep). Any other own field is dropped by
 * the clone, so it never counts.
 */
function equalErrors(a: Error, b: Error, seen: SeenPairs, opaque: OpaqueRule): boolean {
  if (errorKindOf(a) !== errorKindOf(b) || stackOf(a) !== stackOf(b)) return false;
  const aMessage = ownData(a, 'message');
  const bMessage = ownData(b, 'message');
  if (String(aMessage?.value) !== String(bMessage?.value) || !aMessage !== !bMessage) return false;
  const aCause = ownData(a, 'cause');
  const bCause = ownData(b, 'cause');
  if (!aCause || !bCause) return !aCause === !bCause;
  return equalPairs(aCause.value, bCause.value, seen, opaque);
}

function errorKindOf(error: Error): string {
  const name = String(error.name);
  return ERROR_NAMES.has(name) ? name : 'Error';
}

function stackOf(error: Error): string | undefined {
  const stack = error.stack;
  return typeof stack === 'string' ? stack : undefined;
}

/** An own DATA property, boxed — how the clone reads an error's `message` and `cause`. */
function ownData(value: object, key: string): { value: unknown } | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ? { value: descriptor.value }
    : undefined;
}

function equalMaps(a: Map<unknown, unknown>, b: Map<unknown, unknown>, seen: SeenPairs, opaque: OpaqueRule): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (!b.has(key)) return false;
    if (!equalPairs(value, b.get(key), seen, opaque)) return false;
  }
  return true;
}

/**
 * Order-insensitive, deep per member. Quadratic in the worst case for sets of
 * objects — a set of primitives (the common shape) is one `has` per member.
 */
function equalSets(a: Set<unknown>, b: Set<unknown>, seen: SeenPairs, opaque: OpaqueRule): boolean {
  if (a.size !== b.size) return false;
  // The members of `b` that no member of `a` IS — the only ones a member of `a` can pair with by
  // content. Listed once, and only when a member needs it.
  let unmatched: unknown[] | undefined;
  for (const member of a) {
    // SameValueZero first — primitives and shared references pair with themselves, one `has`.
    if (b.has(member)) continue;
    // A primitive `b` does not hold has no equal there.
    if (member === null || typeof member !== 'object') return false;
    unmatched ??= [...b].filter((candidate) => !a.has(candidate));
    // Each match retires its slot so two structurally-equal members of `a`
    // cannot both claim the same member of `b`. A candidate that does not match
    // leaves only a fact behind ({@link SeenPairs}), so trying it is safe.
    const found = unmatched.findIndex((candidate) => equalPairs(member, candidate, seen, opaque));
    if (found < 0) return false;
    unmatched.splice(found, 1);
  }
  return true;
}
