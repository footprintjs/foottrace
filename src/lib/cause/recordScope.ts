import { admitSourceLinks, type SourceLinkInventory } from './sourceLinks/admission.js';
import { decodeRecordCapture } from './recordCapture.js';
import { prepareReadSources } from './recordSources.js';
import { prepareRecordSubflows, type PreparedRecordSubflows } from './recordSubflows.js';
import type { LogAddress } from '../memory/eventPosition.js';
import { placedAt } from '../memory/readWindow.js';
import { RUN_EVIDENCE_LIMITS } from '../run-evidence/kinds.js';
import type {
  PreparedRecordScope,
  RecordGraphOptions,
  RecordScope,
  ResolvedRecordGraphOptions,
} from './recordTypes.js';
import {
  addressKey,
  addressOf,
  dataCopy,
  bundleOf,
  recordList,
  mapOf,
  marksOf,
  recordName,
  names,
  recordOwn,
  RecordRefusal,
  recordRefusalCode,
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
export function recordOptions(options: RecordGraphOptions): ResolvedRecordGraphOptions {
  try {
    const prototype = Object.getPrototypeOf(options);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const policy = recordOwn(options, 'sourceLinkPolicy');
    if (policy !== undefined && typeof policy !== 'function') throw new TypeError();
    return Object.freeze({
      ...(policy === undefined
        ? {}
        : { sourceLinkPolicy: policy as NonNullable<RecordGraphOptions['sourceLinkPolicy']> }),
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
  maximumScopes = 32,
  sourceLinkPolicyIsSet = false,
): PreparedRecordScope {
  if (addressKey(addressOf(recordOwn(value, 'address'))) !== addressKey(address)) throw new RecordRefusal();
  const rawLog = recordList(recordOwn(value, 'commitLog'), maximumCommits),
    budget = { left: maximumFields };
  let after = -1;
  const log = rawLog.map((_, commitIndex) => {
    const bundle = bundleOf(recordOwn(rawLog, String(commitIndex)), after, budget);
    after = placedAt(bundle, after);
    return bundle;
  });
  const reads = mapOf(
    recordOwn(value, 'reads'),
    maximumCommits,
    (value) => {
      const readKeys = names(value, RUN_EVIDENCE_LIMITS.reads, true);
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
  let subflows: PreparedRecordSubflows;
  try {
    subflows = prepareRecordSubflows(recordOwn(value, 'subflows'), address, log, budget, maximumScopes);
  } catch (error) {
    // A refused optional channel does not erase already admitted local commits.
    subflows = { gaps: [recordRefusalCode(error) ?? 'invalid-data'] };
  }
  const capture = decodeRecordCapture(value, address, log);
  let sourceLinks: SourceLinkInventory | undefined;
  try {
    const inventory = recordOwn(value, 'sourceLinks');
    if (inventory !== undefined) sourceLinks = admitSourceLinks(inventory, budget);
  } catch (error) {
    sourceLinks = { links: [], gaps: [recordRefusalCode(error) ?? 'invalid-data'] };
  }
  // Snapshot the base during admission with the log, under the remaining field budget.
  // A link's own policy must still grant all locators before replay reads these values.
  let sourceLinkBase: PreparedRecordScope['sourceLinkBase'];
  if (sourceLinks?.links.length && sourceLinkPolicyIsSet) {
    try {
      const raw = recordOwn(value, 'initialState');
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw))
        sourceLinkBase = dataCopy(raw, budget) as Record<string, unknown>;
    } catch (error) {
      const code = recordRefusalCode(error);
      sourceLinks = { links: [], gaps: [code === 'node-limit' ? 'truncated' : 'invalid-data'] };
    }
  }
  const scope: PreparedRecordScope = {
    address,
    log,
    reads,
    control,
    marks,
    complete: recordOwn(value, 'complete') === true,
    ...(capture ? { capture } : {}),
    ...(readSources ? { readSources } : {}),
    subflows,
    ...(sourceLinks ? { sourceLinks } : {}),
    ...(sourceLinkBase ? { sourceLinkBase } : {}),
  };
  if (readSources) scope.sourceCoveredExecutions = sourceCoveredExecutions(scope);
  return scope;
}

/** Source absence is known only for collected executions; a write prefix covers that write, not every read. */
function sourceCoveredExecutions(scope: PreparedRecordScope): ReadonlySet<string> {
  const groups = new Map<string, PreparedRecordScope['log']>();
  for (const bundle of scope.log) {
    const group = groups.get(bundle.runtimeStageId) ?? [];
    group.push(bundle);
    groups.set(bundle.runtimeStageId, group);
  }
  const covered = new Set<string>(),
    sources = scope.readSources!;
  for (const [id, log] of groups) {
    if (!sources.owners.has(id) && !scope.reads?.has(id)) continue;
    const observed = new Set((sources.byOwner.get(id) ?? []).flatMap((read) => [read.path, read.occurrence.key]));
    // Reuse the canonical union on this execution's own bundles, avoiding a whole-log scan for every owner.
    if (readKeysForStage({ ...scope, log }, id).every((key) => observed.has(key))) covered.add(id);
  }
  return covered;
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
