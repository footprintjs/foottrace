import type { LogAddress } from '../../memory/eventPosition.js';

export const CAPTURE_MODES = {
  reads: ['full', 'summary', 'off', 'unknown'],
  writes: ['full', 'summary', 'off', 'unknown'],
  commitWrites: ['full', 'delta', 'unknown'],
  writePrefixes: ['reads-prefix', 'off', 'unknown'],
  nestedReads: ['on', 'off', 'unknown'],
  readSources: ['on', 'off', 'unknown'],
  inputHandoff: ['on', 'off', 'unknown'],
  outputHandoff: ['on', 'off', 'unknown'],
  fanoutHandoff: ['on', 'off', 'unknown'],
  attention: ['on', 'off', 'unknown'],
  control: ['on', 'off', 'unknown'],
} as const;
export type CaptureChannel = keyof typeof CAPTURE_MODES;
export type CaptureMode = (typeof CAPTURE_MODES)[CaptureChannel][number];
export const CAPTURE_CHANNELS = Object.keys(CAPTURE_MODES) as CaptureChannel[];
export const CAPTURE_REASONS = [
  'redacted',
  'budget-exhausted',
  'capture-failed',
  'missing-evidence',
  'missing-child',
  'unsupported-scope',
  'worker-boundary',
  'transport-boundary',
  'interval-incomplete',
  'unverified',
] as const;
export type CaptureReason = (typeof CAPTURE_REASONS)[number];

export const BOUNDARIES = ['running', 'completed', 'paused', 'failed', 'cancelled'] as const;
export const FAILURE_CATEGORIES = [
  'timeout',
  'rate-limited',
  'server',
  'network',
  'auth',
  'permanent',
  'unknown',
] as const;
export interface CaptureFailure {
  readonly category: (typeof FAILURE_CATEGORIES)[number];
  readonly stage?: Readonly<{ runId: string; runtimeStageId: string }>;
}

export interface CaptureInterval {
  readonly from: number;
  readonly to: number;
}

/** Supply these from the admitted record, independently of its optional capture note. */
export interface CaptureWitness {
  readonly logAddress: LogAddress;
  readonly runId: string;
  readonly commits: CaptureInterval;
  readonly boundary: (typeof BOUNDARIES)[number];
  readonly source: 'live' | 'saved';
}

export interface CaptureQuery extends CaptureInterval {
  readonly channel: CaptureChannel;
  readonly mode: Exclude<CaptureMode, 'off' | 'unknown'>;
  readonly crossing?: 'worker' | 'transport';
}

export interface CaptureCoverage {
  readonly state: 'covered' | 'not-collected' | 'partial' | 'failed' | 'collection-unknown';
  readonly reasons: readonly CaptureReason[];
  readonly failure?: CaptureFailure;
}

export interface ChannelObservation {
  readonly mode: CaptureMode;
  readonly status: 'collected' | 'disabled' | 'partial' | 'failed' | 'unknown';
  readonly reasons: readonly CaptureReason[];
}

export interface CaptureObservation {
  readonly commits: CaptureInterval;
  readonly boundary: CaptureWitness['boundary'];
  readonly failure?: CaptureFailure;
  readonly channels: Readonly<Record<CaptureChannel, ChannelObservation>>;
}
