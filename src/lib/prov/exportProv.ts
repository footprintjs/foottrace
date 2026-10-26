import { admitProvRecord } from './admission.js';
import { ProvBudget } from './budget.js';
import { mapAttention, mapControls } from './control.js';
import { prepareMapping } from './mapping.js';
import { mapRecord } from './mapRecord.js';
import { provOptions } from './options.js';
import { mapSourceReads } from './sourceReads.js';
import { mapReads } from './reads.js';
import type { ProvExport, ProvExportOptions } from './types.js';

/** Export a bounded single-record view. The async contract leaves room for separately reviewed future modes. */
export async function exportProv(record: unknown, options: ProvExportOptions): Promise<ProvExport> {
  const limits = provOptions(options),
    budget = new ProvBudget(limits);
  const admitted = admitProvRecord(record, limits, budget);
  const mapping = prepareMapping(admitted, budget);
  mapRecord(mapping);
  mapControls(mapping);
  mapAttention(mapping);
  mapReads(mapping);
  mapSourceReads(mapping);
  return mapping.output.finish();
}
