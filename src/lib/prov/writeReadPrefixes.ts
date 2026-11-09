import { writePrefixReads } from '../read-sources/write-prefixes/admit.js';
import { reference } from './translation.js';
import type { ProvMapping } from './mapping.js';

/** An observation prefix is possible derivation, never PROV's established wasDerivedFrom. */
export function mapWriteReadPrefixes(mapping: ProvMapping, emittedReads: ReadonlyMap<number, string>): void {
  const { record, budget, ids, output } = mapping,
    prepared = record.readSources?.writePrefixes;
  if (!prepared) return;
  for (const prefix of prepared.writes.values()) {
    const row = record.log[prefix.commitIdx]?.trace[prefix.rowIdx];
    if (output.full || !budget.spend('work')) return;
    if (!row || mapping.hidden(row.path) || prefix.status !== 'observed') {
      budget.addGap({ code: 'unavailable', commitIdx: prefix.commitIdx, rowIdx: prefix.rowIdx });
      continue;
    }
    const frameSize = prepared.byFrame.get(prefix.frame)?.length ?? 0;
    if (!budget.spend('work', Math.ceil(Math.log2(frameSize + 1)) + Math.min(prefix.count, budget.limits.maxReads) + 1))
      return;
    const selected = writePrefixReads(prepared, prefix, budget.limits.maxReads);
    if (!selected.complete) budget.addGap({ code: 'unavailable', commitIdx: prefix.commitIdx, rowIdx: prefix.rowIdx });
    const target = ids.write(prefix.commitIdx, prefix.rowIdx, row.path);
    if (!mapping.entities.has(target)) {
      budget.addGap({ code: 'unavailable' });
      continue;
    }
    for (const read of selected.reads) {
      if (output.full || !budget.spend('work') || !budget.spend('reads')) return;
      const source = emittedReads.get(read.occurrence.ordinal);
      if (!source) {
        budget.addGap({ code: 'unavailable' });
        continue;
      }
      const relationId =
        ids.prefix + 'observed-before-write/' + prefix.commitIdx + '/' + prefix.rowIdx + '/' + read.occurrence.ordinal;
      if (
        !output.add({
          '@id': relationId,
          '@type': 'ft:PossibleDerivation',
          'ft:source': reference(source),
          'ft:target': reference(target),
          'ft:attribution': 'observed-before-write',
        })
      )
        return;
      if (!output.add({ '@id': target, 'ft:possibleDerivation': reference(relationId) })) return;
    }
  }
}
