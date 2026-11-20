/**
 * slice/keysReadSources.ts — the shipped {@link KeysReadSource} strategies.
 *
 * The canonical strategy list and rationale live on the KeysReadSource type
 * (types.ts) — the doc consumers hover. This file holds the implementations.
 *
 * Deliberately NOT here: a QualityRecorder adapter. Importing recorder/ would
 * drag this leaf library up the dependency DAG. The adapter is a one-liner at
 * the call site instead: `(id) => recorder.getByKey(id)?.keysRead ?? []`.
 */

import type { KeysReadLookup } from '../memory/backtrack.js';
import type { ExecutionTree } from '../memory/types.js';
import type { KeysReadSource } from './types.js';

/** Narrow only the object shape this reader uses; stored values stay opaque. */
function isReadTreeObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAccessor(slot: PropertyDescriptor | undefined): boolean {
  return slot !== undefined && !Object.hasOwn(slot, 'value');
}

function ownDataValue(holder: object, key: string): unknown {
  const slot = Object.getOwnPropertyDescriptor(holder, key);
  return isAccessor(slot) ? undefined : slot?.value;
}

/** Use the engine's distinct, lexical read names when its unset-read list is present. */
function trackedReadNames(stageReads: Record<string, unknown> | undefined, unset: unknown): string[] {
  const keys = stageReads
    ? Object.keys(stageReads).filter((key) => !isAccessor(Object.getOwnPropertyDescriptor(stageReads, key)))
    : [];
  const unsetKeys: string[] = [];
  try {
    if (!Array.isArray(unset)) return keys;
    // Enumerate actual array indices, without scanning holes or consulting a caller's iterator.
    for (const name of Object.getOwnPropertyNames(unset)) {
      const index = Number(name);
      if (!Number.isInteger(index) || index < 0 || index >= 2 ** 32 - 1 || String(index) !== name) continue;
      const key = ownDataValue(unset, name);
      if (typeof key === 'string') unsetKeys.push(key);
    }
  } catch {
    // A revoked or throwing proxy cannot provide this optional evidence.
    return keys;
  }
  // Older recordings and unusable side lists keep the read map's existing order.
  return unsetKeys.length === 0 ? keys : [...new Set([...keys, ...unsetKeys])].sort();
}

/**
 * Post-hoc reads from a finished run's execution tree — ZERO setup.
 *
 * WHY this works: a stage's `stageReads` records the keys it tracked-read
 * whenever the `readTracking` dial ≠ 'off' ('full' is the
 * engine default; 'summary' replaces VALUES with markers but keeps the
 * KEYS — and keys are all a slice needs). The optional `undefinedReadKeys`
 * list preserves reads of unset keys when JSON drops their values. Under 'off' this source returns
 * empty read-sets — detectable via `coverage.stepsWithReads === 0`, which
 * `sliceForKey` copies onto the slice so tools can say "reads were not
 * recorded" instead of the lie "no dependencies".
 *
 * SUBFLOW PAIRING (important): a subflow runs in an ISOLATED runtime — its
 * commits live in `snapshot.subflowResults[sfId].commitLog`, its reads in
 * `snapshot.subflowResults[sfId].executionTree`. Trees and logs must be
 * paired from the SAME scope: to slice a key inside a subflow, re-anchor
 * there —
 *
 * ```ts
 * const sf = snapshot.subflowResults['sf-tools'];
 * sliceForKey(sf.commitLog, key, keysReadFromExecutionTree(sf.executionTree));
 * ```
 *
 * Passing multiple trees widens READ resolution only (useful when one log
 * genuinely spans them); it does not let a root-log slice cross a subflow
 * mount — see README.md § Subflow boundaries.
 *
 * A live {@link ExecutionTree} or unknown saved JSON uses this same traversal.
 * Malformed tree fields throw a TypeError naming their source path; no partial
 * reads strategy is returned. Optional fields may be absent or undefined, but
 * null nodes, sparse arrays and wrongly shaped fields are not missing evidence
 * to silently skip. Only own data fields are read. Read-map values are opaque,
 * and malformed unset-read lists or entries supply no keys.
 * Cycles/shared objects are visited once; existing traversal order is retained.
 * Coverage counts observed nodes and nonempty read sets, not capture completeness.
 * This is an ordinary-data boundary, not a sandbox for hostile proxies.
 */
export function keysReadFromExecutionTree(tree: unknown): KeysReadSource {
  const byStep = new Map<string, string[]>();
  let steps = 0;
  // The tree is acyclic by construction (next/children), but this walker is
  // also handed CONSUMER-provided data — a visited set makes a cycle in a
  // hand-built tree a non-event instead of an infinite loop.
  const visited = new Set<object>();
  const stack: { node: unknown; path: string }[] = [];
  const pushNodes = (nodes: readonly unknown[], path: string): void => {
    for (let i = 0; i < nodes.length; i++) {
      const slot = Object.getOwnPropertyDescriptor(nodes, i);
      // Holes still reach shape validation. Accessors supply no evidence.
      if (!isAccessor(slot)) stack.push({ node: slot?.value, path: `${path}[${i}]` });
    }
  };
  if (Array.isArray(tree)) {
    pushNodes(tree, '$');
  } else {
    stack.push({ node: tree, path: '$' });
  }
  while (stack.length > 0) {
    const { node, path } = stack.pop()!;
    if (!isReadTreeObject(node)) throw new TypeError(`keysReadFromExecutionTree: ${path} must be an object`);
    if (visited.has(node)) continue;
    visited.add(node);
    const runtimeStageId = ownDataValue(node, 'runtimeStageId');
    const stageReads = ownDataValue(node, 'stageReads');
    const next = ownDataValue(node, 'next');
    const children = ownDataValue(node, 'children');
    const branches = ownDataValue(node, 'branches');
    if (runtimeStageId !== undefined && typeof runtimeStageId !== 'string') {
      throw new TypeError(`keysReadFromExecutionTree: ${path}.runtimeStageId must be a string when present`);
    }
    if (stageReads !== undefined && !isReadTreeObject(stageReads)) {
      throw new TypeError(`keysReadFromExecutionTree: ${path}.stageReads must be an object when present`);
    }
    if (children !== undefined && !Array.isArray(children)) {
      throw new TypeError(`keysReadFromExecutionTree: ${path}.children must be an array when present`);
    }
    if (branches !== undefined && !Array.isArray(branches)) {
      throw new TypeError(`keysReadFromExecutionTree: ${path}.branches must be an array when present`);
    }
    if (runtimeStageId) {
      steps++;
      const keys = trackedReadNames(stageReads, ownDataValue(node, 'undefinedReadKeys'));
      if (keys.length > 0) byStep.set(runtimeStageId, keys);
    }
    if (next !== undefined) stack.push({ node: next, path: `${path}.next` });
    if (children !== undefined) pushNodes(children, `${path}.children`);
    if (branches !== undefined) {
      // Pushed in the same order as a root list (and `children`), so a duplicated id resolves the same way in both.
      for (let b = 0; b < branches.length; b++) {
        const slot = Object.getOwnPropertyDescriptor(branches, b);
        if (isAccessor(slot)) continue;
        const chain = slot?.value;
        if (!Array.isArray(chain)) {
          throw new TypeError(`keysReadFromExecutionTree: ${path}.branches[${b}] must be an array`);
        }
        pushNodes(chain, `${path}.branches[${b}]`);
      }
    }
  }
  return {
    kind: 'execution-tree',
    lookup: (runtimeStageId: string) => byStep.get(runtimeStageId) ?? [],
    coverage: { steps, stepsWithReads: byStep.size },
  };
}

/**
 * Reads from a prebuilt map — e.g. collected live from
 * `ScopeRecorder.onRead` events, or deserialized from a stored trace.
 */
export function keysReadFromMap(
  map: ReadonlyMap<string, readonly string[]> | Readonly<Record<string, readonly string[]>>,
): KeysReadSource {
  // Own-property guard on the object form: runtimeStageIds are consumer-
  // influenced strings; without it, an id like 'constructor' would read
  // through the prototype chain (the same hardening posture as the engine's
  // nativeGet/prototype-pollution guards).
  const get: (id: string) => readonly string[] | undefined =
    map instanceof Map
      ? (id) => map.get(id)
      : (id) =>
          Object.prototype.hasOwnProperty.call(map, id) ? (map as Record<string, readonly string[]>)[id] : undefined;
  return {
    kind: 'map',
    lookup: (runtimeStageId: string) => [...(get(runtimeStageId) ?? [])],
  };
}

/**
 * Normalize the ergonomic union: callers may pass a full strategy object or
 * a bare lookup function (wrapped as kind 'custom-fn' so the honesty
 * breadcrumb still says where reads came from).
 */
export function resolveKeysReadSource(src: KeysReadSource | KeysReadLookup): KeysReadSource {
  return typeof src === 'function' ? { kind: 'custom-fn', lookup: src } : src;
}
