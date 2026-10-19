import { reference } from './mapRecord.js';
import type { ProvMapping } from './mapping.js';

/** Only already-admitted, same-scope, strictly earlier governing executions are standard communication. */
export function mapControls(mapping: ProvMapping): void {
  for (const [child, parent] of mapping.controls) {
    if (mapping.output.full) break;
    if (!mapping.activities.has(child) || !mapping.activities.has(parent)) continue;
    mapping.output.add({
      '@id': mapping.ids.control(child),
      '@type': 'prov:Communication',
      'prov:activity': reference(mapping.ids.activity(parent)),
      'ft:relation': 'control',
    });
  }
}

/** Preserve admitted codes; references without a supported binding remain a visible evidence gap. */
export function mapAttention(mapping: ProvMapping): void {
  if (!mapping.budget.spend('work', mapping.record.commits.length)) return;
  const commitIndexes = new Set(mapping.record.commits.map((commit) => commit.commitIdx));
  for (const [runtimeStageId, marks] of mapping.record.attention ?? []) {
    if (mapping.output.full || !mapping.budget.spend('work')) return;
    if (!mapping.activities.has(runtimeStageId)) {
      mapping.budget.addGap({ code: 'unavailable', reason: 'attention execution is outside the admitted record' });
      continue;
    }
    for (let ordinal = 0; ordinal < marks.length; ordinal++) {
      if (mapping.output.full) break;
      const mark = marks[ordinal],
        evidence = [];
      for (const item of mark.evidence) {
        if (!mapping.budget.spend('work', item.length + 1)) return;
        const match = /^commit:(0|[1-9][0-9]*)$/.exec(item),
          index = match ? Number(match[1]) : -1;
        if (Number.isSafeInteger(index) && commitIndexes.has(index))
          evidence.push(reference(mapping.ids.commit(index)));
        else
          mapping.budget.addGap({
            code: 'not-permitted',
            reason: 'attention reference has no supported export binding',
          });
      }
      mapping.output.add({
        '@id': mapping.ids.attention(runtimeStageId, ordinal),
        '@type': 'ft:Attention',
        'ft:activity': reference(mapping.ids.activity(runtimeStageId)),
        'ft:kind': mark.kind,
        'ft:reason': mark.reason,
        'ft:evidence': evidence,
      });
    }
  }
}
