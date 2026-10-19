import type { Attention } from '../cause/types.js';
import { admitBundle, gapBundle } from './admitBundle.js';
import { admitAddress, admitMaps } from './admitMaps.js';
import { admitTree } from './admitTree.js';
import { dataField, ProvBudget, ProvDataRefusal, requireSpend, refusalCode } from './budget.js';
import { inspectPrivacy } from './privacy.js';
import type { AdmittedCommit, AdmittedProvRecord, ProvLimits } from './types.js';

/** Copy the indexed prefix without following getters; a skipped tail is privacy-unknown. */
function logPrefix(source: unknown, budget: ProvBudget): { log: unknown[]; truncated: boolean } {
  try {
    const primary = dataField(source, 'commitLog', budget);
    const value = primary === undefined ? dataField(source, 'history', budget) : primary;
    if (value === undefined) {
      budget.addGap({ code: 'not-collected', reason: 'commit log was not captured' });
      return { log: [], truncated: true };
    }
    if (!Array.isArray(value)) throw new ProvDataRefusal();
    const length = dataField(value, 'length', budget);
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) throw new ProvDataRefusal();
    const truncated = length > budget.limits.maxCommits,
      log: unknown[] = [];
    if (truncated) budget.addGap({ code: 'truncated', reason: 'commit limit reached' });
    for (let index = 0; index < Math.min(length, budget.limits.maxCommits); index++) {
      try {
        log.push(dataField(value, String(index), budget));
      } catch (error) {
        budget.addGap({ code: refusalCode(error), commitIdx: index, reason: 'commit entry unavailable' });
        log.push(undefined);
        if (budget.exhausted('work') || budget.exhausted('fields')) return { log, truncated: true };
      }
    }
    return { log, truncated };
  } catch (error) {
    budget.addGap({ code: refusalCode(error), reason: 'commit log unavailable' });
    return { log: [], truncated: true };
  }
}

function mergeMap<T>(
  left: Map<string, T> | undefined,
  right: Map<string, T> | undefined,
  combine: (a: T, b: T) => T,
): Map<string, T> | undefined {
  if (!left) return right;
  if (!right) return left;
  for (const [key, value] of right) left.set(key, left.has(key) ? combine(left.get(key)!, value) : value);
  return left;
}

/** No caller-owned evidence crosses an asynchronous boundary: admission finishes synchronously. */
export function admitProvRecord(
  source: unknown,
  limits: ProvLimits,
  budget = new ProvBudget(limits),
): AdmittedProvRecord {
  const prefix = logPrefix(source, budget),
    inspected = inspectPrivacy(prefix.log, prefix.truncated, budget);
  const commits: AdmittedCommit[] = [],
    log = prefix.log.map(() => gapBundle());
  for (let commitIdx = 0; commitIdx < prefix.log.length; commitIdx++) {
    const commit = admitBundle(prefix.log[commitIdx], commitIdx, inspected.redactions.get(commitIdx) ?? [], budget);
    if (commit) {
      commits.push(commit);
      log[commitIdx] = commit.bundle;
    }
    if (budget.exhausted('work') || budget.exhausted('fields')) break;
  }
  try {
    if (dataField(source, 'subflowResults', budget) !== undefined)
      budget.addGap({
        code: 'scope-boundary',
        reason: 'additional child scopes are not exported by the single-record core',
      });
  } catch (error) {
    budget.addGap({ code: refusalCode(error), reason: 'child-scope evidence unavailable' });
  }
  const maps = admitMaps(source, budget);
  let tree = {} as ReturnType<typeof admitTree>;
  try {
    tree = admitTree(dataField(source, 'executionTree', budget), budget);
  } catch (error) {
    budget.addGap({ code: refusalCode(error), reason: 'execution tree evidence unavailable' });
  }
  const attention = mergeMap<readonly Attention[]>(maps.attention, tree.attention, (a, b) => [...a, ...b]);
  // Accumulate each retained read once; cloning the prefix for every row would be quadratic.
  let allReads: Map<string, string[]> | undefined;
  const readSets = new Map<string, Set<string>>();
  const appendReads = (id: string, names: readonly string[]): void => {
    requireSpend(budget, 'work');
    let set = readSets.get(id);
    if (!set) {
      set = new Set();
      readSets.set(id, set);
    }
    for (const name of names) {
      requireSpend(budget, 'work');
      set.add(name);
    }
  };
  const capturedReads = maps.reads !== undefined || tree.reads !== undefined;
  try {
    for (const source of [maps.reads, tree.reads]) if (source) for (const [id, names] of source) appendReads(id, names);
    for (const commit of commits)
      for (const row of commit.rows)
        if (row.readKeys !== undefined) appendReads(commit.bundle.runtimeStageId, row.readKeys);
  } catch (error) {
    budget.addGap({ code: refusalCode(error), reason: 'read evidence merge limit reached' });
  }
  if (capturedReads || readSets.size) allReads = new Map([...readSets].map(([id, names]) => [id, [...names]]));
  const address = admitAddress(source, budget);
  budget.addGap({ code: 'not-collected', reason: 'native capture and ending attestation is unavailable' });
  return {
    commits,
    log,
    ...(allReads ? { reads: allReads } : {}),
    ...(maps.control ? { control: maps.control } : {}),
    ...(attention ? { attention } : {}),
    ...(address ? { address } : {}),
    privacy: inspected.privacy,
    gaps: budget.gaps,
    complete: false,
  };
}
