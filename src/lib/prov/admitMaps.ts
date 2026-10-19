import type { Attention } from '../cause/types.js';
import { attention as canonicalAttention } from '../cause/validation.js';
import type { ControlDependency } from '../memory/backtrack.js';
import type { LogAddress } from '../memory/eventPosition.js';
import {
  dataField,
  dataKeys,
  dataList,
  dataNames,
  dataPaths,
  dataString,
  ProvBudget,
  ProvDataRefusal,
  requireSpend,
  refusalCode,
} from './budget.js';

/** Admit an owned metadata projection, then reuse the existing attention vocabulary validator. */
export function admitAttention(value: unknown, budget: ProvBudget): readonly Attention[] {
  const projected = dataList(value, 32, budget).map((raw) => {
    const kind = dataString(dataField(raw, 'kind', budget), budget),
      reason = dataString(dataField(raw, 'reason', budget), budget);
    const evidence = dataNames(dataField(raw, 'evidence', budget), budget, 'fields');
    return { kind, reason, evidence };
  });
  return canonicalAttention(projected);
}

export function admitMap<T>(
  value: unknown,
  budget: ProvBudget,
  read: (value: unknown) => T,
): Map<string, T> | undefined {
  if (value === undefined) return undefined;
  const result = new Map<string, T>();
  try {
    for (const key of dataKeys(value, budget)) {
      requireSpend(budget, 'nodes');
      result.set(key, read(dataField(value, key, budget)));
    }
  } catch (error) {
    budget.addGap({ code: refusalCode(error), reason: 'captured evidence map unavailable' });
  }
  return result;
}

export interface CapturedMaps {
  reads?: Map<string, string[]>;
  control?: Map<string, ControlDependency>;
  attention?: Map<string, readonly Attention[]>;
}

export function admitMaps(source: unknown, budget: ProvBudget): CapturedMaps {
  const maps: CapturedMaps = {};
  for (const key of ['reads', 'controlDeps', 'attention'] as const) {
    try {
      const raw = dataField(source, key, budget);
      if (key === 'reads') maps.reads = admitMap(raw, budget, (value) => dataPaths(value, budget));
      else if (key === 'controlDeps')
        maps.control = admitMap(raw, budget, (value) => ({
          deciderId: dataString(dataField(value, 'deciderId', budget), budget),
        }));
      else maps.attention = admitMap(raw, budget, (value) => admitAttention(value, budget));
    } catch (error) {
      budget.addGap({ code: refusalCode(error), reason: 'captured evidence map unavailable' });
    }
  }
  return maps;
}

/** Only an explicitly present exact native address is admitted; no runtime identity is guessed. */
export function admitAddress(source: unknown, budget: ProvBudget): LogAddress | undefined {
  try {
    const value = dataField(source, 'address', budget);
    if (value === undefined) return undefined;
    const logRunId = dataString(dataField(value, 'logRunId', budget), budget, false);
    const drillPath = dataNames(dataField(value, 'drillPath', budget), budget, 'fields');
    if (drillPath.length > budget.limits.maxDepth || drillPath.some((segment) => !segment)) throw new ProvDataRefusal();
    return Object.freeze({ logRunId, drillPath: Object.freeze(drillPath) });
  } catch (error) {
    budget.addGap({ code: refusalCode(error), reason: 'native log address unavailable' });
    return undefined;
  }
}
