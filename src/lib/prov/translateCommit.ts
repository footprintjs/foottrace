import { nativeExecution } from './ids.js';
import { reference } from './translation.js';
import type { ProvCommitContext, ProvTranslation } from './translation.js';
import type { AdmittedCommit, ProvNode } from './types.js';

/** Pure, lazy step translation. Only the driver emits nodes, meters work and remembers accepted IDs. */
export function* translateCommit(
  context: ProvCommitContext,
  commit: AdmittedCommit,
): Generator<ProvTranslation, void, boolean> {
  const { ids } = context,
    { bundle, commitIdx } = commit,
    runtimeStageId = bundle.runtimeStageId;
  let native = context.activities.has(runtimeStageId);
  if (!native) {
    const parsed = nativeExecution(runtimeStageId);
    if (!parsed) {
      yield {
        kind: 'gap',
        gap: { code: 'unsupported', commitIdx, reason: 'native execution identity is unavailable' },
      };
    } else {
      const parent = context.parent;
      const node: ProvNode = {
        '@id': ids.activity(runtimeStageId),
        '@type': 'prov:Activity',
        'ft:stageId': parsed.stageId,
        'ft:executionIndex': parsed.executionIndex,
        ...(parsed.subflowPath === undefined ? {} : { 'ft:subflowPath': parsed.subflowPath }),
        'ft:inRecord': reference(ids.record()),
        ...(bundle.tags?.length ? { 'ft:tags': [...bundle.tags] } : {}),
        ...(parent && context.activities.has(parent)
          ? {
              'prov:wasInformedBy': reference(ids.activity(parent)),
              'prov:qualifiedCommunication': reference(ids.control(runtimeStageId)),
            }
          : {}),
        ...(context.hasUntrackedInput() ? { 'ft:untrackedInput': true } : {}),
      };
      native = yield { kind: 'node', node, activity: runtimeStageId };
    }
  }
  // An activity refusal does not skip scope evidence; a refused commit does skip its rows.
  for (const code of context.scopeGaps) {
    if (code === 'not-collected') yield { kind: 'routine-gap', category: 'scope-coverage' };
    else if (code === 'untracked-input') yield { kind: 'routine-gap', category: 'untracked-commit' };
    else if (code === 'redacted') yield { kind: 'routine-gap', category: 'redacted-commit' };
    else yield { kind: 'gap', gap: { code, commitIdx } };
  }
  if (
    !(yield {
      kind: 'node',
      node: {
        '@id': ids.commit(commitIdx),
        '@type': 'ft:Commit',
        'ft:commitIdx': commitIdx,
        'ft:inRecord': reference(ids.record()),
        ...(native ? { 'ft:execution': reference(ids.activity(runtimeStageId)) } : {}),
        ...(bundle.phase === undefined ? {} : { 'ft:phase': bundle.phase }),
      },
    })
  )
    return;
  const lastRows = new Map(commit.rows.map((row) => [row.path, row.rowIdx]));
  for (const row of commit.rows) {
    const hidden = context.hides(row.path),
      id = ids.write(commitIdx, row.rowIdx, hidden ? undefined : row.path);
    for (const code of context.readGaps(row)) {
      if (code === 'conservative') yield { kind: 'routine-gap', category: 'read-attribution' };
      else if (code === 'not-collected') yield { kind: 'routine-gap', category: 'read-coverage' };
      else yield { kind: 'gap', gap: { code, commitIdx, rowIdx: row.rowIdx } };
    }
    if (hidden) yield { kind: 'routine-gap', category: 'redacted-write' };
    if (lastRows.get(row.path) !== row.rowIdx) yield { kind: 'routine-gap', category: 'intermediate-write' };
    if (row.verb === 'append' || row.verb === 'merge') yield { kind: 'routine-gap', category: 'patch-value' };
    if (
      !(yield {
        kind: 'node',
        entity: id,
        node: {
          '@id': id,
          '@type': 'prov:Entity',
          'ft:commitIdx': commitIdx,
          'ft:rowIdx': row.rowIdx,
          'ft:verb': row.verb,
          'ft:inCommit': reference(ids.commit(commitIdx)),
          'ft:valueAvailability': 'not-exported',
          ...(hidden ? { 'ft:redacted': true } : { 'ft:path': row.path }),
          ...(row.verb === 'delete' ? { 'ft:deleted': true } : {}),
          ...(native ? { 'prov:wasGeneratedBy': reference(ids.activity(runtimeStageId)) } : {}),
        },
      })
    )
      return;
  }
}
