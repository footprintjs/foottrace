import type { Attention } from '../cause/types.js';
import {
  dataField,
  dataKeys,
  dataList,
  dataString,
  ProvBudget,
  ProvDataRefusal,
  requireSpend,
  refusalCode,
} from './budget.js';
import { admitAttention } from './admitMaps.js';

export interface TreeEvidence {
  reads?: Map<string, string[]>;
  attention?: Map<string, readonly Attention[]>;
}

/** Bounded structural traversal: read values are never evaluated, including getter-valued read entries. */
export function admitTree(tree: unknown, budget: ProvBudget): TreeEvidence {
  if (tree === undefined) return {};
  const reads = new Map<string, Set<string>>(),
    attention = new Map<string, Attention[]>();
  const visited = new Set<object>(),
    stack: { value: unknown; depth: number }[] = [];
  const schedule = (value: unknown, depth: number): void => {
    if (depth > budget.limits.maxDepth) throw new ProvDataRefusal('depth-limit');
    if (value && typeof value === 'object' && visited.has(value)) {
      budget.addGap({ code: 'cycle', reason: 'execution tree revisits a node' });
      return;
    }
    requireSpend(budget, 'nodes');
    if (value && typeof value === 'object') visited.add(value);
    stack.push({ value, depth });
  };
  try {
    schedule(tree, 0);
  } catch (error) {
    budget.addGap({ code: refusalCode(error), reason: 'execution tree evidence unavailable' });
    return {};
  }
  let collectedReads = false,
    collectedAttention = false;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    try {
      requireSpend(budget, 'work');
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProvDataRefusal();
      const rawId = dataField(value, 'runtimeStageId', budget),
        rawReads = dataField(value, 'stageReads', budget);
      const id = rawId === undefined ? undefined : dataString(rawId, budget);
      if (rawReads !== undefined) {
        const keys = dataKeys(rawReads, budget, true);
        requireSpend(budget, 'reads', keys.length);
        collectedReads = true;
        if (id !== undefined) {
          let set = reads.get(id);
          if (!set) {
            set = new Set();
            reads.set(id, set);
          }
          for (const key of keys) set.add(key);
        }
      }
      const marks = dataField(value, 'attention', budget);
      if (marks !== undefined) {
        const admitted = admitAttention(marks, budget);
        collectedAttention = true;
        if (id !== undefined) {
          let marks = attention.get(id);
          if (!marks) {
            marks = [];
            attention.set(id, marks);
          }
          for (const mark of admitted) marks.push(mark);
        }
      }
      if (dataField(value, 'subflowId', budget) !== undefined)
        budget.addGap({
          code: 'scope-boundary',
          reason: 'additional child scopes are not exported by the single-record core',
        });
      const next = dataField(value, 'next', budget),
        children = dataField(value, 'children', budget);
      if (next !== undefined) schedule(next, depth + 1);
      if (children !== undefined)
        for (const child of dataList(children, budget.remaining('nodes'), budget)) schedule(child, depth + 1);
    } catch (error) {
      budget.addGap({ code: refusalCode(error), reason: 'execution tree evidence unavailable' });
      if (budget.exhausted('work') || budget.exhausted('fields')) break;
    }
  }
  return {
    ...(collectedReads ? { reads: new Map([...reads].map(([id, names]) => [id, [...names]])) } : {}),
    ...(collectedAttention ? { attention } : {}),
  };
}
