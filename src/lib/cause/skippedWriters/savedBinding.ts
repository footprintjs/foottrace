import { canonicalSnapshot } from '../../canonical-json/canonical.js';
import type { JsonValue } from '../../canonical-json/types.js';
import type { LogAddress } from '../../memory/eventPosition.js';
import { ownedJsonFailureCode } from '../../owned-json/types.js';
import type { SkippedWork } from './types.js';

const PROJECTION_VERSION = 'footprint.skipped-chart.v1';
const MAX_PROJECTION_BYTES = 1024 * 1024;
const BUDGET_REFUSALS = ['depth', 'nodes', 'fields', 'string-bytes', 'sort-work', 'output-bytes'];

export interface SavedChartCapture {
  /** Host-resolved immutable version of the whole recording, including stored decision notes. */
  readonly recordingVersion: string;
  readonly runId: string;
  readonly address: LogAddress;
  readonly from: number;
  readonly to: number;
}

export interface TrustedSavedChartBinding extends SavedChartCapture {
  readonly version: typeof PROJECTION_VERSION;
  readonly digest: string;
}

function sameCapture(capture: SavedChartCapture, binding: TrustedSavedChartBinding): boolean {
  if (
    !capture.recordingVersion ||
    !capture.runId ||
    !Number.isSafeInteger(capture.from) ||
    !Number.isSafeInteger(capture.to) ||
    capture.from < 0 ||
    capture.to < capture.from
  )
    return false;
  const actual = capture.address;
  const expected = binding.address;
  return (
    capture.recordingVersion === binding.recordingVersion &&
    capture.runId === binding.runId &&
    capture.from === binding.from &&
    capture.to === binding.to &&
    actual.logRunId === expected.logRunId &&
    actual.drillPath.length === expected.drillPath.length &&
    actual.drillPath.every((mount, i) => mount === expected.drillPath[i])
  );
}

async function digestProjection(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

function captureProjection(projection: unknown, budget?: SkippedWork) {
  const allowance = budget ? Math.min(10_000, Math.floor(budget.left / 2)) : 10_000;
  if (budget) budget.left -= allowance * 2;
  return canonicalSnapshot(
    { version: PROJECTION_VERSION, graph: projection },
    { maxBytes: MAX_PROJECTION_BYTES, maxNodes: allowance, maxFields: allowance },
  );
}

/** Derive the capture-time digest of the immutable projected topology and declarations. */
export async function savedChartDigest(projection: unknown): Promise<string> {
  return digestProjection(captureProjection(projection).text);
}

/**
 * The caller supplies a binding retrieved from the trusted recording catalog.
 * A chart and a digest provided only by the chart's caller cannot supply this authority.
 */
export async function readBoundSavedProjection(
  capture: SavedChartCapture,
  binding: TrustedSavedChartBinding | undefined,
  chart: unknown,
  budget?: SkippedWork,
): Promise<
  | { readonly status: 'host-attested'; readonly projection: JsonValue }
  | { readonly status: 'chart-binding' | 'truncated' }
> {
  if (!binding || binding.version !== PROJECTION_VERSION || !sameCapture(capture, binding))
    return { status: 'chart-binding' };
  const expectedDigest = binding.digest;
  if (!/^[a-f0-9]{64}$/.test(expectedDigest)) return { status: 'chart-binding' };
  try {
    if (budget && budget.left < 2) return { status: 'truncated' };
    const snapshot = captureProjection(chart, budget);
    if ((await digestProjection(snapshot.text)) !== expectedDigest) return { status: 'chart-binding' };
    return { status: 'host-attested', projection: (snapshot.value as { readonly graph: JsonValue }).graph };
  } catch (error) {
    return { status: BUDGET_REFUSALS.includes(ownedJsonFailureCode(error)) ? 'truncated' : 'chart-binding' };
  }
}
