function ownDataValue(holder: object, key: string): unknown {
  const slot = Object.getOwnPropertyDescriptor(holder, key);
  return slot && Object.hasOwn(slot, 'value') ? slot.value : undefined;
}

/** Retain insertion order except when the engine's unset list contributes names. */
export function mergeTrackedReadNames(keys: string[], unset: readonly string[]): string[] {
  return unset.length === 0 ? keys : [...new Set([...keys, ...unset])].sort();
}

/** Merge the engine's unset-read names into the existing read map. */
export function trackedReadNames(
  node: object,
  stageReads: Record<string, unknown> | undefined,
  spendSlots?: (count: number) => void,
): string[] {
  const keys = stageReads === undefined ? [] : Object.keys(stageReads);
  let unset: unknown[];
  let names: string[];
  try {
    const value = ownDataValue(node, 'undefinedReadKeys');
    if (!Array.isArray(value)) return keys;
    unset = value;
    names = Object.getOwnPropertyNames(unset);
  } catch {
    // An unreadable optional list supplies no evidence.
    return keys;
  }
  spendSlots?.(names.length);
  try {
    const unsetKeys: string[] = [];
    // Enumerate actual array indices, without scanning holes or consulting a caller's iterator.
    for (const name of names) {
      const index = Number(name);
      if (!Number.isInteger(index) || index < 0 || index >= 2 ** 32 - 1 || String(index) !== name) continue;
      const key = ownDataValue(unset, name);
      if (typeof key === 'string') unsetKeys.push(key);
    }
    // Use the engine's lexical order when the side list contributes evidence.
    return mergeTrackedReadNames(keys, unsetKeys);
  } catch {
    // A throwing descriptor lookup or revoked optional list supplies no evidence.
    return keys;
  }
}
