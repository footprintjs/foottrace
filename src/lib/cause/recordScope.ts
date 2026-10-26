import { prepareReadSources } from './recordSources.js';
import type { LogAddress } from '../memory/eventPosition.js';
import type { PreparedRecordScope, RecordGraphOptions, RecordScope } from './recordTypes.js';
import {
  addressKey,
  addressOf,
  bundleOf,
  recordList,
  mapOf,
  marksOf,
  recordName,
  names,
  recordOwn,
  RecordRefusal,
  spend,
} from './recordValidation.js';

/** Refuse an invalid limit before loading a scope or allocating its preparation budget. */
function boundedOption(value: unknown, defaultValue: number, maximum: number): number {
  const configuredValue = value ?? defaultValue;
  if (
    typeof configuredValue !== 'number' ||
    !Number.isSafeInteger(configuredValue) ||
    configuredValue < 1 ||
    configuredValue > maximum
  )
    throw new TypeError('cause: invalid record configuration');
  return configuredValue;
}

/** Read configuration as data so option accessors cannot execute during adapter construction. */
export function recordOptions(options: RecordGraphOptions): Required<RecordGraphOptions> {
  try {
    const prototype = Object.getPrototypeOf(options);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    return Object.freeze({
      maxCommits: boundedOption(recordOwn(options, 'maxCommits'), 256, 4096),
      maxFields: boundedOption(recordOwn(options, 'maxFields'), 20000, 1000000),
      maxEdges: boundedOption(recordOwn(options, 'maxEdges'), 64, 256),
      maxScopes: boundedOption(recordOwn(options, 'maxScopes'), 32, 256),
      loadTimeoutMs: boundedOption(recordOwn(options, 'loadTimeoutMs'), 1000, 30000),
    });
  } catch {
    throw new TypeError('cause: invalid record configuration');
  }
}

/** Spend one shared field budget before canonical readers see any untrusted scope data. */
export function prepareRecordScope(
  value: RecordScope,
  address: LogAddress,
  maximumCommits: number,
  maximumFields: number,
): PreparedRecordScope {
  if (addressKey(addressOf(recordOwn(value, 'address'))) !== addressKey(address)) throw new RecordRefusal();
  const rawLog = recordList(recordOwn(value, 'commitLog'), maximumCommits),
    budget = { left: maximumFields };
  const log = rawLog.map((_, commitIndex) => bundleOf(recordOwn(rawLog, String(commitIndex)), commitIndex, budget));
  const reads = mapOf(
    recordOwn(value, 'reads'),
    maximumCommits,
    (value) => {
      const readKeys = names(value, 128, true);
      spend(budget, readKeys.length);
      return readKeys;
    },
    budget,
  );
  const control = mapOf(
    recordOwn(value, 'controlDeps'),
    maximumCommits,
    (value) => ({ deciderId: recordName(recordOwn(value, 'deciderId')) }),
    budget,
  );
  const marks = mapOf(
    recordOwn(value, 'attention'),
    maximumCommits,
    (value) => {
      const attention = marksOf(value);
      spend(budget, attention.length + attention.reduce((count, mark) => count + mark.evidence.length, 0));
      return attention;
    },
    budget,
  );
  const sources = recordOwn(value, 'readSources');
  const readSources = prepareReadSources(
    sources,
    address,
    log,
    sources === undefined ? undefined : recordOwn(value, 'initialState'),
    budget,
  );
  return {
    address,
    log,
    reads,
    control,
    marks,
    complete: recordOwn(value, 'complete') === true,
    ...(readSources ? { readSources } : {}),
  };
}

/** Preserve both stage reads and stronger per-write prefixes, including their original encounter order. */
export function readKeysForStage(scope: PreparedRecordScope, runtimeStageId: string): string[] {
  // Captured per-write prefixes remain evidence even when a supplied stage-read map omits them.
  return [
    ...new Set([
      ...(scope.reads?.get(runtimeStageId) ?? []),
      ...scope.log
        .filter((bundle) => bundle.runtimeStageId === runtimeStageId)
        .flatMap((bundle) => bundle.trace.flatMap((entry) => entry.readKeys ?? [])),
    ]),
  ];
}
