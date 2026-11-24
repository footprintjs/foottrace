import { addressKey, addressOf } from '../../evidence/recordData.js';
import type { LogAddress } from '../../memory/eventPosition.js';
import type { UnchangedWriteRecording } from '../../memory/unchangedWriteTypes.js';
import type { StoredLog, StoredRecord } from '../../time-travel/storedRecord.js';
import { analyzeBoundSkippedPaths, type CouldHaveChangedCandidate, type SkippedGap } from './analyze.js';
import { normalizeSkippedChart } from './normalize.js';
import { readBoundSavedProjection, type SavedChartCapture, type TrustedSavedChartBinding } from './savedBinding.js';

export const SKIPPED_QUERY_WORK = 100_000;

export interface SavedSkippedChartAuthority {
  /**
   * Resolve the exact admitted record and scope from an independent host catalog.
   * Return undefined when access is denied. An authorized capture can omit its chart binding.
   */
  lookup(
    recording: StoredRecord,
    address: LogAddress,
  ):
    | {
        readonly capture: SavedChartCapture;
        readonly binding?: TrustedSavedChartBinding;
        readonly retained?: UnchangedWriteRecording;
      }
    | undefined;
}

export interface CouldHaveChangedOptions {
  readonly address: LogAddress;
  /** Candidate versioned chart projection, as admitted and served by the host. */
  readonly chart: unknown;
  readonly authority: SavedSkippedChartAuthority;
}

export interface CouldHaveChangedResult {
  readonly candidates: readonly CouldHaveChangedCandidate[];
  readonly gaps: readonly (SkippedGap | 'chart-binding')[];
}

interface SavedSkippedQuery {
  readonly log: StoredLog;
  readonly chart: unknown;
  readonly approved: NonNullable<ReturnType<SavedSkippedChartAuthority['lookup']>>;
}

type QueryFailure = 'chart-binding' | 'not-collected';

export const unavailableSkippedPaths = (gap: CouldHaveChangedResult['gaps'][number]): CouldHaveChangedResult => ({
  candidates: [],
  gaps: [gap],
});

export function savedSkippedQuery(
  recording: StoredRecord,
  options: CouldHaveChangedOptions | undefined,
): SavedSkippedQuery | QueryFailure {
  if (!options) return 'chart-binding';
  try {
    const address = addressOf(options.address);
    const approved = options.authority.lookup(recording, address);
    if (!approved || addressKey(addressOf(approved.capture.address)) !== addressKey(address)) return 'chart-binding';
    const log = recording.log(address);
    if (!log || recording.unread.length || approved.capture.to > log.commitLog.length) return 'not-collected';
    return { log, chart: options.chart, approved };
  } catch {
    return 'chart-binding';
  }
}

export async function analyzeSavedSkippedPaths(
  query: SavedSkippedQuery,
  key: string,
  beforeIdx: number,
): Promise<CouldHaveChangedResult> {
  const { capture, binding, retained } = query.approved;
  const fromIdx = capture.from;
  if (!Number.isSafeInteger(beforeIdx) || beforeIdx < fromIdx || beforeIdx > capture.to)
    return unavailableSkippedPaths('chart-binding');
  const budget = { left: SKIPPED_QUERY_WORK };
  try {
    const verified = await readBoundSavedProjection(capture, binding, query.chart, budget);
    if (verified.status !== 'host-attested') return unavailableSkippedPaths(verified.status);
    const graph = normalizeSkippedChart(verified.projection, verified.status, budget);
    if (typeof graph === 'string') return unavailableSkippedPaths(graph);
    return analyzeBoundSkippedPaths(query.log, graph, key, beforeIdx, budget, fromIdx, retained);
  } catch {
    return unavailableSkippedPaths('chart-binding');
  }
}

/** Explain possible writers on excluded paths in one independently bound saved scope. */
export async function couldHaveChanged(
  recording: StoredRecord,
  key: string,
  beforeIdx: number,
  options?: CouldHaveChangedOptions,
): Promise<CouldHaveChangedResult> {
  const query = savedSkippedQuery(recording, options);
  return typeof query === 'string' ? unavailableSkippedPaths(query) : analyzeSavedSkippedPaths(query, key, beforeIdx);
}
