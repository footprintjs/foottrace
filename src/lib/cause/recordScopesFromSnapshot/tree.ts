import { recordName, refuseRecord, spend } from '../../evidence/recordData.js';
import { mergeTrackedReadNames } from '../../memory/stageReadNames.js';
import { field, list, plain, type Budget } from './read.js';

export function snapshotTree(tree: unknown, budget: Budget) {
  const ids = new Set<string>();
  const mounts: string[] = [];
  const reads = new Map<string, readonly string[]>();
  const seen = new Set<object>();
  const nodes: unknown[] = tree == null ? [] : [tree];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    spend(budget, 1);
    if (!plain(node) || seen.has(node)) throw refuseRecord();
    seen.add(node);
    const id = field(node, 'runtimeStageId');
    const mount = field(node, 'subflowId');
    if (id !== undefined && id !== '') {
      const name = recordName(id);
      if (ids.has(name)) throw refuseRecord();
      ids.add(name);
      if (typeof mount === 'string' && mount.length > 0) mounts.push(name);
      const row = field(node, 'stageReads');
      if (row !== undefined && !plain(row)) throw refuseRecord();
      const keys = Object.keys(row ?? {});
      spend(budget, keys.length);
      const unset = field(node, 'undefinedReadKeys');
      const all = mergeTrackedReadNames(
        keys,
        unset === undefined ? [] : list(unset, budget).map((key) => recordName(key, true)),
      );
      if (all.length > 0) reads.set(name, Object.freeze(all.map((key) => recordName(key, true))));
    }
    const next = field(node, 'next');
    if (next != null) nodes.push(next);
    const children = field(node, 'children');
    if (children !== undefined) for (const child of list(children, budget)) nodes.push(child);
  }
  return { ids, mounts, reads: Object.freeze(Object.fromEntries(reads)) };
}
