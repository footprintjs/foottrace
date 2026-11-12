/**
 * memory/controlDeps.ts — the door from a SAVED control map to `causalChain`'s `controlDeps` option.
 *
 * WHY it exists: a tool that keeps a run's control edges as plain data (which decision let which step
 * run, `{ 'high#2': { deciderId: 'route#1', label: 'score over 50' } }`) and later walks back from a
 * value has an object, and `controlDeps` wants a function. Handing the object over used to fail from
 * inside the walk ("controlDeps is not a function"), so every reader wrapped it by hand — and a hand
 * wrapper over a file is where `__proto__` or a getter gets through. `keysReadFromMap` is the same
 * door for reads; this is the one for control edges.
 *
 * Two functions, one job each:
 * - {@link controlDepsFromMap} makes the lookup from a plain object;
 * - {@link requireControlDepsFunction} refuses, where it is given, anything else a caller passes as
 *   `controlDeps`. There is ONE way in: a function. A map is never accepted silently in its place.
 */

import type { ControlDepLookup, ControlDependency } from './backtrackTypes.js';

function isPlainObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  // A literal, JSON.parse's result or Object.create(null): the prototype is the root of its chain. Comparing
  // against `Object.prototype` itself would refuse an object made in another realm (a worker, a vm context).
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

/** What a value is, in a word a message can name; never throws (a hostile Proxy is just "an object"). */
function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value !== 'object') return `a ${typeof value}`;
  if (Array.isArray(value)) return 'an array';
  try {
    return value instanceof Map ? 'a Map' : 'an object';
  } catch {
    return 'an object';
  }
}

/** An OWN DATA property's value; a missing one, an inherited one and a getter all read as absent. */
function ownDataValue(holder: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(holder, name);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

/**
 * One edge, as the walk needs it: `deciderId` a string (the walk looks it up in the log by that id) and
 * `label`, when there is one, a string (it is the edge's `key`). Anything else is not an edge.
 * A FRESH object is returned, so the walk never holds the caller's edge and a getter on it never runs.
 */
function edgeOf(candidate: unknown): ControlDependency | undefined {
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  const deciderId = ownDataValue(candidate, 'deciderId');
  if (typeof deciderId !== 'string') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(candidate, 'label');
  if (descriptor === undefined) return { deciderId };
  // A label that cannot be read as plain data is a malformed edge, not an edge without a label.
  if (!('value' in descriptor)) return undefined;
  if (descriptor.value === undefined) return { deciderId };
  return typeof descriptor.value === 'string' ? { deciderId, label: descriptor.value } : undefined;
}

/**
 * The control lookup `causalChain` (and `sliceForKey`) take as `controlDeps`, over a saved control map:
 * a plain object from a step's `runtimeStageId` to `{ deciderId, label? }`, the shape a control
 * recorder saves.
 *
 * ```ts
 * const saved = JSON.parse(text); // { 'high#2': { deciderId: 'route#1', label: 'score over 50' } }
 * causalChain(log, 'high#2', reads.lookup, { controlDeps: controlDepsFromMap(saved) });
 * ```
 *
 * The map is data from a file someone else may have written, so:
 * - Only OWN DATA properties are read: never the prototype (`__proto__`, `constructor`, `toString` as a
 *   step id give `undefined`) and never a getter.
 * - An entry is an edge only when `deciderId` is a string and `label` is absent or a string. Anything
 *   else gives `undefined`, as does an id the map does not hold; the lookup never throws.
 * - The returned edge is a fresh `{ deciderId, label? }`; no other field of the entry gets through.
 *
 * LIVE, like `keysReadFromMap`: the object is not copied. Each lookup reads it as it is then, so an
 * entry added after this call is seen and an edited one answers with its new value. Freeze or copy the
 * map first when it must not change under the walk.
 *
 * The lookup says nothing about the log: a `deciderId` the log does not hold gives no edge in the walk
 * (a gap, not an error), and the walk links the decider the map names without asking whether it ran
 * before the step.
 *
 * @throws TypeError when `map` is not a plain object (an array, a Map, a class instance, a function, a
 *   primitive). Wrong input is refused here, once, in words that say what to pass.
 */
export function controlDepsFromMap(map: Readonly<Record<string, ControlDependency>>): ControlDepLookup {
  let plain = false;
  try {
    plain = isPlainObject(map);
  } catch {
    // A hostile Proxy whose prototype trap throws is not a plain object.
  }
  if (!plain) {
    throw new TypeError(
      `controlDepsFromMap: expected a plain object (a literal, JSON.parse's result) from a step's runtimeStageId to { deciderId, label? }, got ${kindOf(
        map,
      )}`,
    );
  }
  return (runtimeStageId: string): ControlDependency | undefined => {
    try {
      return typeof runtimeStageId === 'string' ? edgeOf(ownDataValue(map, runtimeStageId)) : undefined;
    } catch {
      // The lookup never throws at walk time (a Proxy whose traps throw, a revoked Proxy): no edge.
      return undefined;
    }
  };
}

/**
 * Refuse a `controlDeps` option that is not a function, at the call and by name. `undefined` and `null`
 * are the option absent (a caller that passes `x ?? null` has always worked and still does). `where` is
 * the public function the caller called.
 */
export function requireControlDepsFunction(value: unknown, where: string): void {
  if (value !== undefined && value !== null && typeof value !== 'function') {
    throw new TypeError(
      `${where}: controlDeps must be a function; for a saved map use controlDepsFromMap(map) (got ${kindOf(value)})`,
    );
  }
}
