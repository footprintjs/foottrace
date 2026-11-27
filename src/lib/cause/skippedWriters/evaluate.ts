import { canonicalSnapshot } from '../../canonical-json/canonical.js';
import type { JsonValue } from '../../canonical-json/types.js';
import { addressOf, recordOwn, recordRefusalCode, spend } from '../../evidence/recordData.js';
import type { LogAddress } from '../../memory/eventPosition.js';
import type { UnchangedWriteRecording } from '../../memory/unchangedWriteTypes.js';
import { ownedJsonFailureCode } from '../../owned-json/types.js';
import { readStoredRecord, type StoredLog } from '../../time-travel/storedRecord.js';
import { analyzeSkippedPaths, type SkippedGap, type SkippedPathCandidate } from './analyze.js';
import { normalizeSkippedChart } from './normalize.js';
import type { SkippedWork } from './types.js';

export const SKIPPED_QUERY_WORK = 100_000;
const INPUT_SHAPE_LIMIT = 20_000;
const INPUT_BYTE_LIMIT = 1024 * 1024;
const INPUT_BUDGET_REFUSALS = ['depth', 'nodes', 'fields', 'string-bytes', 'sort-work', 'output-bytes'];

export interface EvaluateSkippedPathsOptions {
  readonly address: LogAddress;
  readonly chart: unknown;
  /** Covered commit interval of the supplied evidence. `beforeIdx` is an exclusive commit index. */
  readonly from: number;
  readonly to: number;
}

export interface EvaluateSkippedPathsResult {
  readonly candidates: readonly SkippedPathCandidate[];
  readonly gaps: readonly SkippedGap[];
}

export const unavailableSkippedPaths = <G extends SkippedGap | 'chart-binding'>(gap: G) => ({
  candidates: [] as readonly never[],
  gaps: [gap],
});

/** The saved adapter already owns its digest-verified projection. Both paths use this normalization and fold. */
export function evaluateOwnedSkippedPaths(
  log: StoredLog,
  chart: JsonValue,
  key: string,
  beforeIdx: number,
  budget: SkippedWork,
  fromIdx: number,
  retained?: UnchangedWriteRecording,
): EvaluateSkippedPathsResult {
  const graph = normalizeSkippedChart(chart, budget);
  return typeof graph === 'string'
    ? unavailableSkippedPaths(graph)
    : analyzeSkippedPaths(log, graph, key, beforeIdx, budget, fromIdx, retained);
}

/**
 * Evaluate caller-supplied JSON recording entries and a chart projection in one bounded scope.
 * A candidate is a fact about the supplied inputs. This function issues no capture or catalog binding.
 */
export function evaluateSkippedPaths(
  entries: readonly unknown[],
  key: string,
  beforeIdx: number,
  options: EvaluateSkippedPathsOptions,
): EvaluateSkippedPathsResult {
  const budget = { left: SKIPPED_QUERY_WORK - INPUT_SHAPE_LIMIT * 2 };
  try {
    const address = addressOf(recordOwn(options, 'address'));
    const from = recordOwn(options, 'from');
    const to = recordOwn(options, 'to');
    if (
      typeof from !== 'number' ||
      typeof to !== 'number' ||
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      !Number.isSafeInteger(beforeIdx) ||
      from < 0 ||
      beforeIdx < from ||
      beforeIdx > to ||
      !Array.isArray(entries)
    )
      return unavailableSkippedPaths('invalid-data');

    // Own the JSON data before the general record reader reads it. Reserve both node and field
    // allowances from the shared budget, then charge the reader's entry grouping and sorting.
    const input = canonicalSnapshot(
      { entries, chart: recordOwn(options, 'chart') },
      { maxBytes: INPUT_BYTE_LIMIT, maxNodes: INPUT_SHAPE_LIMIT, maxFields: INPUT_SHAPE_LIMIT },
    ).value as { readonly entries: readonly JsonValue[]; readonly chart: JsonValue };
    const entryCount = input.entries.length;
    spend(budget, entryCount * (1 + Math.ceil(Math.log2(entryCount + 1))));
    const recording = readStoredRecord(input.entries, { entries: entryCount, missingCommits: 0 });
    const log = recording.log(address);
    if (!log || recording.unread.length || to > log.commitLog.length) return unavailableSkippedPaths('not-collected');
    return evaluateOwnedSkippedPaths(log, input.chart, key, beforeIdx, budget, from);
  } catch (error) {
    const limited =
      recordRefusalCode(error) === 'node-limit' || INPUT_BUDGET_REFUSALS.includes(ownedJsonFailureCode(error));
    return unavailableSkippedPaths(limited ? 'truncated' : 'invalid-data');
  }
}
