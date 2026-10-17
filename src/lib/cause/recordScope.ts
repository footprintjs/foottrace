import type { LogAddress } from '../memory/eventPosition.js';
import type { PreparedRecordScope, RecordGraphOptions, RecordScope } from './recordTypes.js';
import {
  addressKey,
  addressOf,
  bundleOf,
  list,
  mapOf,
  marksOf,
  name,
  names,
  own,
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
      maxCommits: boundedOption(own(options, 'maxCommits'), 256, 4096),
      maxFields: boundedOption(own(options, 'maxFields'), 20000, 1000000),
      maxEdges: boundedOption(own(options, 'maxEdges'), 64, 256),
      maxScopes: boundedOption(own(options, 'maxScopes'), 32, 256),
      loadTimeoutMs: boundedOption(own(options, 'loadTimeoutMs'), 1000, 30000),
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
  if (addressKey(addressOf(own(value, 'address'))) !== addressKey(address)) throw new RecordRefusal();
  const rawLog = list(own(value, 'commitLog'), maximumCommits),
    budget = { left: maximumFields };
  const log = rawLog.map((_, commitIndex) => bundleOf(own(rawLog, String(commitIndex)), commitIndex, budget));
  const reads = mapOf(
    own(value, 'reads'),
    maximumCommits,
    (value) => {
      const readKeys = names(value, 128, true);
      spend(budget, readKeys.length);
      return readKeys;
    },
    budget,
  );
  const control = mapOf(
    own(value, 'controlDeps'),
    maximumCommits,
    (value) => ({ deciderId: name(own(value, 'deciderId')) }),
    budget,
  );
  const marks = mapOf(
    own(value, 'attention'),
    maximumCommits,
    (value) => {
      const attention = marksOf(value);
      spend(budget, attention.length + attention.reduce((count, mark) => count + mark.evidence.length, 0));
      return attention;
    },
    budget,
  );
  return { address, log, reads, control, marks, complete: own(value, 'complete') === true };
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
