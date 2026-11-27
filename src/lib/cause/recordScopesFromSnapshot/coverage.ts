import type { LogAddress } from '../../memory/eventPosition.js';
import { prepareRecordSubflows, type RecordSubflows } from '../recordSubflows.js';
import { prepareRecordLog, recordRefusalCode } from '../recordValidation.js';
import { MAX_LOG, MAX_SCOPES, type Budget } from './read.js';

/** Only an output admitted against the parent log can witness a child's complete cut. */
export function admittedChildCuts(
  subflows: RecordSubflows,
  address: LogAddress,
  log: readonly unknown[],
  budget: Budget,
  payloadBudget: Budget,
) {
  if (!subflows.mounts.some((mount) => mount.outputHandoff !== undefined)) return undefined;
  try {
    const prepared = prepareRecordSubflows(
      subflows,
      address,
      prepareRecordLog(log, MAX_LOG, budget, undefined, payloadBudget),
      budget,
      MAX_SCOPES,
    );
    if (prepared.record === undefined) return { refusal: prepared.gaps[0] };
    const cuts = new Map<string, number>();
    for (const mount of prepared.record.mounts) {
      if (mount.outputHandoff?.status === 'captured') {
        cuts.set(mount.runtimeStageId, mount.outputHandoff.child.beforeCommitIdx);
      }
    }
    return { cuts };
  } catch (error) {
    return { refusal: recordRefusalCode(error) ?? ('invalid-data' as const) };
  }
}
