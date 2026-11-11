import { readSourcesOf, windowOf } from '../memory/readWindow.js';
import { buildKeyIndex, lastIndexBefore, writeEntry } from '../slice/keyIndex.js';
import { pathSegments } from '../record-paths/codec.js';
import { reference } from './translation.js';
import type { ProvMapping } from './mapping.js';
import type { AdmittedRow } from './types.js';

function lastRow(rows: readonly AdmittedRow[], key: string): AdmittedRow | undefined {
  for (let index = rows.length - 1; index >= 0; index--) if (rows[index].path === key) return rows[index];
  return undefined;
}

/**
 * Canonical temporal writer lookup is a candidate source, never proof of an intra-stage read version.
 *
 * WHICH writer is the one rule's answer (`memory/readWindow.ts`): the last write before the step began.
 * When the key was also written inside the step's read window there is no one candidate (the read may be
 * of any of them), and this export has one slot: it names none and says `read-basis`, never a guess.
 */
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
      // The index was charged once above; a lookup walks the key's trie path, then binary-searches its writes.
      if (!budget.spend('work', key.length + 1)) return;
      const readId = ids.read(runtimeStageId, ordinal),
        hidden = mapping.hidden(key);
      const writes = index.writesOf(key);
      if (!budget.spend('work', writes.length + Math.ceil(Math.log2(writes.length + 1)))) return;
      const sources = readSourcesOf(key, windowOf(record.log, commits[0].commitIdx), (_key, before) => {
        return lastIndexBefore(writes, before) ?? -1;
      });
      const contested = sources.during.length > 0;
      const previous = sources.before < 0 ? undefined : sources.before;
      if (previous !== undefined && !budget.spend('work', record.log[previous].trace.length)) return;
      const entry = previous === undefined ? undefined : writeEntry(record.log[previous], key);
      const source =
        contested || previous === undefined || !entry || entry.path !== key
          ? undefined
          : lastRow(byCommitIndex.get(previous)?.rows ?? [], key);
      const candidate = source
        ? ids.write(source.commitIdx, source.rowIdx, mapping.hidden(source.path) ? undefined : source.path)
        : undefined;
      if ((previous !== undefined || contested) && !candidate) budget.summarizeGap('read-basis');
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
