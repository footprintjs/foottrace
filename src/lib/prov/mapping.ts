import { collectControlParentCoverage, controlParentLookup } from '../cause/recordControl.js';
import { readKeysForStage } from '../cause/recordScope.js';
import type { PreparedRecordScope } from '../cause/recordTypes.js';
import { ProvBudget } from './budget.js';
import { nativeExecution, ProvIds } from './ids.js';
import { ProvOutput } from './output.js';
import type { AdmittedCommit, AdmittedProvRecord } from './types.js';

export interface ProvMapping {
  readonly record: AdmittedProvRecord;
  readonly budget: ProvBudget;
  readonly output: ProvOutput;
  readonly ids: ProvIds;
  readonly scope: PreparedRecordScope;
  readonly groups: ReadonlyMap<string, readonly AdmittedCommit[]>;
  readonly reads: ReadonlyMap<string, readonly string[]>;
  readonly controls: ReadonlyMap<string, string>;
  readonly activities: Set<string>;
  readonly entities: Set<string>;
  hidden(path: string): boolean;
}

/** Resolve privacy for the entire owned view before the first output node can disclose a path. */
export function prepareMapping(record: AdmittedProvRecord, budget: ProvBudget): ProvMapping {
  const groups = new Map<string, AdmittedCommit[]>();
  for (const commit of record.commits) {
    const id = commit.bundle.runtimeStageId;
    const group = groups.get(id);
    if (group) group.push(commit);
    else groups.set(id, [commit]);
  }
  const scope: PreparedRecordScope = {
    address: record.address ?? { logRunId: '', drillPath: [] },
    log: record.log,
    reads: record.reads,
    control: record.control,
    marks: record.attention,
    complete: false,
  };
  const reads = new Map<string, readonly string[]>(),
    visibility = new Map<string, boolean>();
  const inspect = (path: string) => {
    if (visibility.has(path) || !budget.spend('work')) return;
    visibility.set(path, record.privacy.hides(path));
  };
  for (const [runtimeStageId, commits] of groups) {
    if (
      !budget.spend(
        'work',
        commits.reduce((count, commit) => count + commit.rows.length + 1, 0),
      )
    )
      break;
    // The canonical union sees only this execution's own commits: no quadratic whole-log scan.
    const keys = readKeysForStage({ ...scope, log: commits.map((commit) => commit.bundle) }, runtimeStageId);
    reads.set(runtimeStageId, keys);
    for (const key of keys) inspect(key);
    for (const commit of commits) for (const row of commit.rows) inspect(row.path);
  }
  for (const read of record.readSources?.observations ?? []) inspect(read.path);
  // A late fail-closed transition also withholds every earlier cached disclosure decision.
  const hideAll = record.privacy.hideAllPaths || budget.exhausted('work');
  const controls = new Map<string, string>(),
    lookup = controlParentLookup(scope);
  for (const map of [record.reads, record.control, record.attention])
    for (const id of map?.keys() ?? []) {
      if (!budget.spend('work')) break;
      if (!groups.has(id))
        budget.addGap({
          code: 'unavailable',
          reason: 'captured evidence names an execution outside the admitted record',
        });
    }
  for (const [runtimeStageId, commits] of groups) {
    if (!record.control?.has(runtimeStageId)) continue;
    if (!budget.spend('work', record.log.length * 2 + 1)) break;
    collectControlParentCoverage(scope, { address: scope.address, runtimeStageId }, commits[0].commitIdx, (code) =>
      budget.addGap({ code, commitIdx: commits[0].commitIdx }),
    );
    const parent = lookup?.(runtimeStageId)?.deciderId;
    if (parent && nativeExecution(parent) && nativeExecution(runtimeStageId)) controls.set(runtimeStageId, parent);
  }
  return {
    record,
    budget,
    scope,
    groups,
    reads,
    controls,
    ids: new ProvIds(budget.limits.base, record.address),
    output: new ProvOutput(budget),
    activities: new Set(),
    entities: new Set(),
    hidden: (path) => hideAll || visibility.get(path) !== false,
  };
}
