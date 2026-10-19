import { boundedList, EvidenceRefusal, ownData } from '../evidence/admission.js';
import type { GapCode } from '../evidence/codes.js';
import { wellFormed } from './options.js';
import { ProvGaps } from './gaps.js';
import type { ProvRoutineGap } from './gaps.js';
import type { ProvExportGap, ProvLimits } from './types.js';

export type ProvCost = 'work' | 'fields' | 'rows' | 'reads' | 'nodes' | 'relations' | 'stringBytes';
const limitKey = {
  work: 'maxWork',
  fields: 'maxFields',
  rows: 'maxRows',
  reads: 'maxReads',
  nodes: 'maxNodes',
  relations: 'maxRelations',
  stringBytes: 'maxStringBytes',
} as const;
export class ProvDataRefusal extends EvidenceRefusal {
  constructor(code: GapCode = 'invalid-data') {
    super(code, 'prov: unavailable record evidence');
  }
}
const refuse = (code?: GapCode): ProvDataRefusal => new ProvDataRefusal(code);
const descriptors = { translateTrapErrors: true, requireOwnValue: true };

/** A single allowance covers admission and mapping; refused work is never presented as evidence. */
export class ProvBudget {
  private readonly usage = new Map<ProvCost, number>();
  private readonly refused = new Set<ProvCost>();
  private readonly reports: ProvGaps;
  constructor(readonly limits: ProvLimits) {
    this.reports = new ProvGaps(limits.maxOutputBytes);
  }
  get gaps(): readonly ProvExportGap[] {
    return this.reports.gaps;
  }
  get gapBytes(): number {
    return this.reports.reservedBytes;
  }
  outputLimitReached(): void {
    this.reports.markOutputLimit();
  }
  spend(kind: ProvCost, count = 1): boolean {
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      (this.usage.get(kind) ?? 0) + count > this.limits[limitKey[kind]]
    ) {
      this.refused.add(kind);
      this.addGap({ code: 'truncated', reason: 'export ' + limitKey[kind] + ' limit reached' });
      return false;
    }
    this.usage.set(kind, (this.usage.get(kind) ?? 0) + count);
    return true;
  }
  remaining(kind: ProvCost): number {
    return this.limits[limitKey[kind]] - (this.usage.get(kind) ?? 0);
  }
  exhausted(kind: ProvCost): boolean {
    return this.refused.has(kind);
  }
  addGap(gap: ProvExportGap): void {
    this.reports.add(gap);
  }
  summarizeGap(kind: ProvRoutineGap): void {
    this.reports.summarize(kind);
  }
}

export function requireSpend(budget: ProvBudget, kind: ProvCost, count = 1): void {
  if (!budget.spend('work', count) || (kind !== 'work' && !budget.spend(kind, count))) throw refuse('truncated');
}
export function dataField(value: unknown, key: string, budget: ProvBudget): unknown {
  requireSpend(budget, 'fields');
  return ownData(value, key, refuse, descriptors);
}
export function dataList(value: unknown, maximum: number, budget: ProvBudget): readonly unknown[] {
  return boundedList(
    value,
    maximum,
    (item) => {
      requireSpend(budget, 'fields');
      return item;
    },
    {
      refuse,
      overflow: 'truncated',
      freeze: false,
      descriptors,
      translateArrayErrors: true,
    },
  );
}
/** String identity admission counts exact UTF-8 bytes without allocating an encoded copy. */
export function dataString(value: unknown, budget: ProvBudget, allowEmpty = true): string {
  if (budget.exhausted('stringBytes') || budget.exhausted('work')) throw refuse('truncated');
  if (
    typeof value !== 'string' ||
    (!allowEmpty && !value.length) ||
    value.length > budget.limits.maxStringBytes ||
    !wellFormed(value)
  )
    throw refuse();
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdbff ? (index++, 4) : 3;
  }
  requireSpend(budget, 'stringBytes', bytes);
  return value;
}
/** Bound the canonical U+001F path grammar before index helpers allocate one trie node per segment. */
export function dataPath(value: unknown, budget: ProvBudget): string {
  const path = dataString(value, budget);
  requireSpend(budget, 'work', path.length);
  let depth = 1;
  for (let index = 0; index < path.length; index++) {
    if (path.charCodeAt(index) === 31 && ++depth > budget.limits.maxDepth) throw refuse('depth-limit');
  }
  return path;
}
export function dataPaths(value: unknown, budget: ProvBudget, kind: 'reads' | 'fields' = 'reads'): string[] {
  return dataList(value, kind === 'reads' ? budget.limits.maxReads : budget.limits.maxFields, budget).map((item) => {
    requireSpend(budget, kind);
    return dataPath(item, budget);
  });
}
export function dataNames(value: unknown, budget: ProvBudget, kind: 'reads' | 'fields' = 'reads'): string[] {
  return dataList(value, kind === 'reads' ? budget.limits.maxReads : budget.limits.maxFields, budget).map((item) => {
    requireSpend(budget, kind);
    return dataString(item, budget);
  });
}
/** Obtain keys without reading their values; every retained name is owned and charged. */
export function dataKeys(value: unknown, budget: ProvBudget, paths = false): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw refuse();
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    throw refuse();
  }
  requireSpend(budget, 'fields', keys.length);
  return keys.map((key) => (paths ? dataPath(key, budget) : dataString(key, budget)));
}
export function refusalCode(error: unknown): GapCode {
  return error instanceof ProvDataRefusal ? error.code : 'invalid-data';
}
