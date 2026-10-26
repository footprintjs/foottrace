import { reference } from './translation.js';
import type { ProvMapping } from './mapping.js';

/** Usage is a recorded read of a proven entity. Output derivation remains a separate, unavailable fact. */
export function mapSourceReads(mapping: ProvMapping): void {
  const { record, budget, ids, output } = mapping;
  for (const read of record.readSources?.observations ?? []) {
    if (output.full || !budget.spend('reads') || !budget.spend('work')) return;
    const { occurrence } = read,
      runtimeStageId = occurrence.runtimeStageId;
    if (!mapping.activities.has(runtimeStageId) || mapping.hidden(read.path)) {
      budget.addGap({ code: 'unavailable', reason: 'exact read entity join unavailable' });
      continue;
    }
    let entity: string;
    if (read.commitIdx === undefined) {
      entity = ids.initial(read.path);
      if (!mapping.entities.has(entity)) {
        if (
          !output.add({
            '@id': entity,
            '@type': 'prov:Entity',
            'ft:path': read.path,
            'ft:initial': true,
            'ft:valueAvailability': 'not-exported',
          })
        )
          return;
        mapping.entities.add(entity);
      }
    } else {
      if (record.log[read.commitIdx].trace[read.rowIdx!]?.verb !== 'set') {
        budget.addGap({ code: 'unsupported', reason: 'exact read entity join unavailable' });
        continue;
      }
      entity = ids.write(read.commitIdx, read.rowIdx!, read.path);
      if (!mapping.entities.has(entity)) {
        budget.addGap({ code: 'unavailable', reason: 'exact read entity join unavailable' });
        continue;
      }
    }
    const readId = ids.prefix + 'observed-read/' + occurrence.ordinal;
    if (
      !output.add({
        '@id': readId,
        '@type': 'ft:Read',
        'ft:activity': reference(ids.activity(runtimeStageId)),
        'ft:path': read.path,
        'ft:ordinal': occurrence.ordinal,
        'ft:attemptId': occurrence.attemptId!,
        'ft:disposition': occurrence.disposition,
        'ft:basis': 'recorded-source',
        'ft:sourceEntity': reference(entity),
      })
    )
      return;
    if (!output.add({ '@id': ids.activity(runtimeStageId), 'prov:used': reference(entity) })) return;
  }
}
