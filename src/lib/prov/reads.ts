import { buildKeyIndex, lastIndexBefore, writeEntry } from '../slice/keyIndex.js';
import { pathSegments } from '../memory/paths.js';
import { reference } from './translation.js';
import type { ProvMapping } from './mapping.js';
import type { AdmittedRow } from './types.js';

function lastRow(rows: readonly AdmittedRow[], key: string): AdmittedRow | undefined {
  for (let index = rows.length - 1; index >= 0; index--) if (rows[index].path === key) return rows[index];
  return undefined;
}

/** Canonical temporal writer lookup is a candidate source, never proof of an intra-stage read version. */
export function mapReads(mapping: ProvMapping): void {
  const { record, budget, ids, output } = mapping;
  if (![...mapping.reads.values()].some((keys) => keys.length)) return;
  // Prefix trie strings can cost length*depth, not merely one unit per retained trace row.
  let indexCost = record.log.length,
    indexNodes = 0;
  for (const bundle of record.log)
    for (const row of bundle.trace) {
      const depth = pathSegments(row.path).length;
      indexCost += (row.path.length + 1) * depth;
      indexNodes += depth;
    }
  if (!budget.spend('work', indexCost) || !budget.spend('nodes', indexNodes)) return;
  const index = buildKeyIndex(record.log, () => []);
  if (!budget.spend('work', record.commits.length)) return;
  const byCommitIndex = new Map(record.commits.map((commit) => [commit.commitIdx, commit]));
  for (const [runtimeStageId, commits] of mapping.groups) {
    if (output.full || !mapping.activities.has(runtimeStageId)) continue;
    const keys = mapping.reads.get(runtimeStageId) ?? [],
      readIds = new Map<string, string>();
    for (let ordinal = 0; ordinal < keys.length; ordinal++) {
      if (output.full) break;
      const key = keys[ordinal];
      // Charge a conservative upper bound before invoking readers whose internal work is not metered.
      if (!budget.spend('work', indexCost + key.length + 1)) return;
      const readId = ids.read(runtimeStageId, ordinal),
        hidden = mapping.hidden(key);
      const previous = lastIndexBefore(index.writesOf(key), commits[0].commitIdx);
      const entry = previous === undefined ? undefined : writeEntry(record.log[previous], key);
      const source =
        previous === undefined || !entry || entry.path !== key
          ? undefined
          : lastRow(byCommitIndex.get(previous)?.rows ?? [], key);
      const candidate = source
        ? ids.write(source.commitIdx, source.rowIdx, mapping.hidden(source.path) ? undefined : source.path)
        : undefined;
      if (previous !== undefined && !candidate) budget.summarizeGap('read-basis');
      budget.summarizeGap('read-version');
      if (hidden) budget.summarizeGap('redacted-read');
      if (
        output.add({
          '@id': readId,
          '@type': 'ft:Read',
          'ft:activity': reference(ids.activity(runtimeStageId)),
          ...(hidden ? { 'ft:redacted': true } : { 'ft:path': key }),
          'ft:basis': candidate && mapping.entities.has(candidate) ? 'candidate' : 'unknown',
          ...(candidate && mapping.entities.has(candidate) ? { 'ft:candidateEntity': reference(candidate) } : {}),
        })
      )
        readIds.set(key, readId);
    }
    for (const commit of commits)
      for (const row of commit.rows) {
        const target = ids.write(row.commitIdx, row.rowIdx, mapping.hidden(row.path) ? undefined : row.path);
        if (!mapping.entities.has(target)) continue;
        const candidates = row.readKeys ?? keys;
        for (let ordinal = 0; ordinal < candidates.length; ordinal++) {
          if (output.full || !budget.spend('work')) return;
          const source = readIds.get(candidates[ordinal]);
          if (!source) {
            budget.addGap({ code: 'unavailable', commitIdx: row.commitIdx, rowIdx: row.rowIdx });
            continue;
          }
          const relationId = ids.candidate(row.commitIdx, row.rowIdx, ordinal);
          if (
            !output.add({
              '@id': relationId,
              '@type': 'ft:PossibleDerivation',
              'ft:source': reference(source),
              'ft:target': reference(target),
              'ft:attribution': row.readKeys === undefined ? 'stage-level' : 'reads-prefix',
            })
          )
            return;
          if (!output.add({ '@id': target, 'ft:possibleDerivation': reference(relationId) })) return;
        }
      }
  }
}
