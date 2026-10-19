import { collectReadCoverage, collectScopeCoverage } from '../cause/recordCoverage.js';
import { nativeExecution } from './ids.js';
import type { ProvMapping } from './mapping.js';
import type { AdmittedCommit, ProvNode } from './types.js';

export const reference = (id: string): ProvNode => ({ '@id': id });

function execution(mapping: ProvMapping, commit: AdmittedCommit): void {
  const runtimeStageId = commit.bundle.runtimeStageId;
  if (mapping.activities.has(runtimeStageId)) return;
  const parsed = nativeExecution(runtimeStageId);
  if (!parsed) {
    mapping.budget.addGap({
      code: 'unsupported',
      commitIdx: commit.commitIdx,
      reason: 'native execution identity is unavailable',
    });
    return;
  }
  const parent = mapping.controls.get(runtimeStageId);
  const node: ProvNode = {
    '@id': mapping.ids.activity(runtimeStageId),
    '@type': 'prov:Activity',
    'ft:stageId': parsed.stageId,
    'ft:executionIndex': parsed.executionIndex,
    ...(parsed.subflowPath === undefined ? {} : { 'ft:subflowPath': parsed.subflowPath }),
    'ft:inRecord': reference(mapping.ids.record()),
    ...(commit.bundle.tags?.length ? { 'ft:tags': [...commit.bundle.tags] } : {}),
    ...(parent && mapping.activities.has(parent)
      ? {
          'prov:wasInformedBy': reference(mapping.ids.activity(parent)),
          'prov:qualifiedCommunication': reference(mapping.ids.control(runtimeStageId)),
        }
      : {}),
    ...(mapping.groups.get(runtimeStageId)?.some((entry) => entry.bundle.untrackedSources?.length)
      ? { 'ft:untrackedInput': true }
      : {}),
  };
  if (mapping.output.add(node)) mapping.activities.add(runtimeStageId);
}

/** One execution activity, per-commit metadata, and one binding entity per original write occurrence. */
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
    const { bundle, commitIdx } = commit;
    execution(mapping, commit);
    const native = mapping.activities.has(bundle.runtimeStageId);
    collectScopeCoverage(mapping.scope, bundle, undefined, (code) => {
      if (code === 'not-collected') budget.summarizeGap('scope-coverage');
      else if (code === 'untracked-input') budget.summarizeGap('untracked-commit');
      else if (code === 'redacted') budget.summarizeGap('redacted-commit');
      else budget.addGap({ code, commitIdx });
    });
    if (
      !output.add({
        '@id': ids.commit(commitIdx),
        '@type': 'ft:Commit',
        'ft:commitIdx': commitIdx,
        'ft:inRecord': reference(ids.record()),
        ...(native ? { 'ft:execution': reference(ids.activity(bundle.runtimeStageId)) } : {}),
        ...(bundle.phase === undefined ? {} : { 'ft:phase': bundle.phase }),
      })
    )
      break;
    const lastRows = new Map(commit.rows.map((row) => [row.path, row.rowIdx]));
    for (const row of commit.rows) {
      if (output.full) break;
      const hidden = mapping.hidden(row.path),
        id = ids.write(commitIdx, row.rowIdx, hidden ? undefined : row.path);
      collectReadCoverage(
        mapping.scope,
        { address: mapping.scope.address, runtimeStageId: bundle.runtimeStageId, key: row.path },
        row.readKeys !== undefined,
        (code) => {
          if (code === 'conservative') budget.summarizeGap('read-attribution');
          else if (code === 'not-collected') budget.summarizeGap('read-coverage');
          else budget.addGap({ code, commitIdx, rowIdx: row.rowIdx });
        },
      );
      if (hidden) budget.summarizeGap('redacted-write');
      if (lastRows.get(row.path) !== row.rowIdx) budget.summarizeGap('intermediate-write');
      if (row.verb === 'append' || row.verb === 'merge') budget.summarizeGap('patch-value');
      if (
        output.add({
          '@id': id,
          '@type': 'prov:Entity',
          'ft:commitIdx': commitIdx,
          'ft:rowIdx': row.rowIdx,
          'ft:verb': row.verb,
          'ft:inCommit': reference(ids.commit(commitIdx)),
          'ft:valueAvailability': 'not-exported',
          ...(hidden ? { 'ft:redacted': true } : { 'ft:path': row.path }),
          ...(row.verb === 'delete' ? { 'ft:deleted': true } : {}),
          ...(native ? { 'prov:wasGeneratedBy': reference(ids.activity(bundle.runtimeStageId)) } : {}),
        })
      )
        mapping.entities.add(id);
    }
  }
}
