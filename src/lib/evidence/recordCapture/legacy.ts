import { recordList, recordOwn } from '../recordData.js';
import { exact, member } from './shape.js';
import {
  CAPTURE_CHANNELS,
  CAPTURE_MODES,
  type CaptureChannel,
  type CaptureMode,
  type CaptureReason,
  type ChannelObservation,
} from './types.js';

const OBSERVED = ['captured', 'disabled', 'partial', 'failed', 'unknown'] as const;
const REQUIRED = [
  'tracked-state-only',
  'final-attempt-views',
  'child-scopes-not-attested',
  'storage-not-attested',
] as const;
const LIMITS = [
  ...REQUIRED,
  'read-sources-not-collected',
  'resumed-segment',
  'redacted-export',
  'redaction-active',
  'custom-scope',
  'read-retention-failed',
  'commit-retention-failed',
  'attention-omitted',
  'recorder-snapshot-failed',
  'identity-omitted',
  'execution-broken',
  'modes-unavailable',
  'checkpoint-history-not-included',
  'source-history-not-included',
] as const;
type Limit = (typeof LIMITS)[number];
type GapStatus = 'unknown' | 'partial' | 'failed';
type ChannelGap = readonly [readonly CaptureChannel[], GapStatus, CaptureReason];

const HANDOFFS = ['inputHandoff', 'outputHandoff', 'fanoutHandoff'] as const;
const GAPS: Partial<Record<Limit, readonly ChannelGap[]>> = {
  'redacted-export': [[CAPTURE_CHANNELS, 'unknown', 'redacted']],
  'redaction-active': [[CAPTURE_CHANNELS, 'unknown', 'redacted']],
  'custom-scope': [[CAPTURE_CHANNELS, 'unknown', 'unsupported-scope']],
  'read-retention-failed': [[['reads'], 'failed', 'capture-failed']],
  'commit-retention-failed': [
    [['writes', 'commitWrites', 'writePrefixes'], 'failed', 'capture-failed'],
    [['attention'], 'partial', 'missing-evidence'],
    [['readSources', ...HANDOFFS], 'unknown', 'missing-evidence'],
  ],
  'attention-omitted': [[['attention'], 'partial', 'missing-evidence']],
  'recorder-snapshot-failed': [[['control'], 'failed', 'capture-failed']],
  'identity-omitted': [[['attention'], 'partial', 'missing-evidence']],
  'execution-broken': [[CAPTURE_CHANNELS, 'partial', 'interval-incomplete']],
  'modes-unavailable': [[['reads', 'writes', 'attention'], 'unknown', 'unverified']],
  'checkpoint-history-not-included': [[CAPTURE_CHANNELS, 'unknown', 'missing-evidence']],
  'source-history-not-included': [[['readSources'], 'unknown', 'missing-evidence']],
};

const MODES = ['readTracking', 'writeTracking', 'commitValues', 'writeProvenance'] as const;
const LEGACY_CHANNELS = ['reads', 'writes', 'attention', 'control', 'readSources'] as const;
const STRENGTH = { collected: 0, partial: 1, unknown: 2, failed: 3 } as const;

function legacyMode(observed: unknown): CaptureMode {
  return observed === 'captured' || observed === 'partial' || observed === 'failed' ? 'on' : 'unknown';
}

function observation(
  mode: CaptureMode,
  observed: unknown,
  gaps: readonly ChannelGap[],
  key: CaptureChannel,
): ChannelObservation {
  if (mode === 'off') return { mode, status: 'disabled', reasons: [] };
  let status: keyof typeof STRENGTH =
    observed === 'captured' ? 'collected' : observed === 'partial' || observed === 'failed' ? observed : 'unknown';
  const reasons = new Set<CaptureReason>();
  for (const [channels, gap, reason] of gaps) {
    if (!channels.includes(key)) continue;
    reasons.add(reason);
    if (STRENGTH[gap] > STRENGTH[status]) status = gap;
  }
  if (mode === 'unknown') status = 'unknown';
  if (status !== 'collected' && reasons.size === 0)
    reasons.add(status === 'failed' ? 'capture-failed' : status === 'partial' ? 'missing-evidence' : 'unverified');
  return { mode, status, reasons: [...reasons] };
}

/** Project the older root observation without extending its witness or inventing missing channel modes. */
export function legacyChannels(value: unknown, version: 1 | 2): Record<CaptureChannel, ChannelObservation> | undefined {
  const modes = recordOwn(value, 'modes');
  const channels = recordOwn(value, 'channels');
  if (!exact(modes, MODES) || !exact(channels, LEGACY_CHANNELS)) return undefined;
  const rawLimits = recordOwn(value, 'limitations');
  if (!Array.isArray(rawLimits) || Object.getPrototypeOf(rawLimits) !== Array.prototype) return undefined;
  const limits = recordList(rawLimits, LIMITS.length);
  if (
    !limits.every((limit): limit is Limit => member(limit, LIMITS)) ||
    new Set(limits).size !== limits.length ||
    !REQUIRED.every((limit) => limits.includes(limit)) ||
    limits.includes('read-sources-not-collected') !== (version === 1)
  )
    return undefined;
  const reads = recordOwn(modes, 'readTracking');
  const writes = recordOwn(modes, 'writeTracking');
  const commits = recordOwn(modes, 'commitValues');
  const prefixes = recordOwn(modes, 'writeProvenance');
  if (
    !member(reads, CAPTURE_MODES.reads) ||
    !member(writes, CAPTURE_MODES.writes) ||
    !member(commits, CAPTURE_MODES.commitWrites) ||
    !member(prefixes, CAPTURE_MODES.writePrefixes)
  )
    return undefined;
  const sources = recordOwn(channels, 'readSources');
  if (version === 1 ? sources !== 'not-collected' : !member(sources, OBSERVED)) return undefined;
  for (const key of ['reads', 'writes', 'attention', 'control'] as const)
    if (!member(recordOwn(channels, key), OBSERVED)) return undefined;
  if (
    (reads === 'off') !== (recordOwn(channels, 'reads') === 'disabled') ||
    (writes === 'off') !== (recordOwn(channels, 'writes') === 'disabled')
  )
    return undefined;
  const channelModes: Record<CaptureChannel, CaptureMode> = {
    reads,
    writes,
    commitWrites: commits,
    writePrefixes: prefixes,
    nestedReads: 'unknown',
    readSources: version === 1 ? 'off' : legacyMode(sources),
    inputHandoff: 'unknown',
    outputHandoff: 'unknown',
    fanoutHandoff: 'unknown',
    attention: legacyMode(recordOwn(channels, 'attention')),
    control: legacyMode(recordOwn(channels, 'control')),
  };
  const gaps = limits.flatMap((limit) => GAPS[limit] ?? []);
  return Object.fromEntries(
    CAPTURE_CHANNELS.map((key) => [key, observation(channelModes[key], recordOwn(channels, key), gaps, key)]),
  ) as Record<CaptureChannel, ChannelObservation>;
}
