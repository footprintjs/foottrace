import { collectReadCoverage, collectScopeCoverage } from '../cause/recordCoverage.js';
import type { GapCode } from '../evidence/codes.js';
import type { ProvMapping } from './mapping.js';
import { translateCommit } from './translateCommit.js';
import { reference } from './translation.js';
import type { ProvCommitContext } from './translation.js';
import type { AdmittedCommit } from './types.js';

/** Canonical coverage readers stay at the driver boundary; the translator receives only owned facts. */
function commitContext(mapping: ProvMapping, commit: AdmittedCommit): ProvCommitContext {
  const scopeGaps: GapCode[] = [];
  collectScopeCoverage(mapping.scope, commit.bundle, undefined, (code) => scopeGaps.push(code));
  return {
    ids: mapping.ids,
    activities: mapping.activities,
    parent: mapping.controls.get(commit.bundle.runtimeStageId),
    hasUntrackedInput: () =>
      mapping.groups.get(commit.bundle.runtimeStageId)?.some((entry) => entry.bundle.untrackedSources?.length) ?? false,
    scopeGaps,
    hides: (path: string) => mapping.hidden(path),
    readGaps: (row: AdmittedCommit['rows'][number]) => {
      const gaps: GapCode[] = [];
      collectReadCoverage(
        mapping.scope,
        { address: mapping.scope.address, runtimeStageId: commit.bundle.runtimeStageId, key: row.path },
        row.readKeys !== undefined,
        (code) => gaps.push(code),
      );
      return gaps;
    },
  };
}

/** Apply lazy step effects in historical order; failed admission never registers an identity. */
export function mapRecord(mapping: ProvMapping): void {
  const { record, ids, output, budget } = mapping;
  output.add({
    '@id': ids.record(),
    '@type': 'ft:Record',
    ...(record.address
      ? { 'ft:logRunId': record.address.logRunId, 'ft:drillPath': [...record.address.drillPath] }
      : {}),
  });
  for (const commit of record.commits) {
    if (output.full) break;
    const iterator = translateCommit(commitContext(mapping, commit), commit);
    let next = iterator.next();
    while (!next.done) {
      const effect = next.value;
      let accepted = false;
      if (effect.kind === 'gap') budget.addGap(effect.gap);
      else if (effect.kind === 'routine-gap') budget.summarizeGap(effect.category);
      else {
        accepted = output.add(effect.node);
        if (accepted && effect.activity !== undefined) mapping.activities.add(effect.activity);
        if (accepted && effect.entity !== undefined) mapping.entities.add(effect.entity);
      }
      next = iterator.next(accepted);
    }
  }
}
