import type { LogAddress } from '../../memory/eventPosition.js';
import type { CommitBundle } from '../../memory/types.js';
import { addressKey, addressOf, recordList, recordOwn } from '../recordData.js';
import { legacyChannels } from './legacy.js';
import { exact, interval, member, safelyCopyFailure, witness } from './shape.js';
import {
  BOUNDARIES,
  CAPTURE_CHANNELS,
  CAPTURE_MODES,
  CAPTURE_REASONS,
  type CaptureChannel,
  type CaptureObservation,
  type ChannelObservation,
} from './types.js';

const COMMON = ['version', 'scope', 'runId', 'logAddress', 'commits', 'boundary', 'persistence', 'channels'] as const;
const LEGACY = [...COMMON, 'modes', 'limitations'];
const STATUSES = ['collected', 'disabled', 'partial', 'failed', 'unknown'] as const;

function currentChannels(value: unknown): CaptureObservation['channels'] | undefined {
  if (!exact(value, CAPTURE_CHANNELS)) return undefined;
  const entries: [CaptureChannel, ChannelObservation][] = [];
  for (const key of CAPTURE_CHANNELS) {
    const channel = recordOwn(value, key);
    if (!exact(channel, ['mode', 'status', 'reasons'])) return undefined;
    const mode = recordOwn(channel, 'mode');
    const status = recordOwn(channel, 'status');
    const rawReasons = recordOwn(channel, 'reasons');
    if (!Array.isArray(rawReasons) || Object.getPrototypeOf(rawReasons) !== Array.prototype) return undefined;
    const reasons = recordList(rawReasons, CAPTURE_REASONS.length);
    if (
      !member(mode, CAPTURE_MODES[key]) ||
      !member(status, STATUSES) ||
      !reasons.every((reason): reason is (typeof CAPTURE_REASONS)[number] => member(reason, CAPTURE_REASONS)) ||
      new Set(reasons).size !== reasons.length ||
      (mode === 'off') !== (status === 'disabled') ||
      (mode === 'unknown' && status !== 'unknown') ||
      (status === 'collected' || status === 'disabled') !== (reasons.length === 0)
    )
      return undefined;
    entries.push([key, { mode, status, reasons }]);
  }
  return Object.fromEntries(entries) as CaptureObservation['channels'];
}

function actualInterval(log: readonly CommitBundle[], from: number, to: number): boolean {
  if (to === from) return from === 0 ? log.length === 0 : log.some((bundle) => bundle.idx === from - 1);
  if (to - from > log.length) return false;
  let expected = from;
  for (const bundle of log) {
    if (expected === to) break;
    if (bundle.idx === undefined) continue;
    if (bundle.idx < expected) continue;
    if (bundle.idx !== expected) return false;
    expected++;
  }
  return expected === to;
}

/** A malformed optional annotation cannot refuse a scope or hide its independent positive evidence. */
export function decodeRecordCapture(
  scope: unknown,
  address: LogAddress,
  log: readonly CommitBundle[],
): CaptureObservation | undefined {
  try {
    const reference = witness(recordOwn(scope, 'captureWitness'));
    const scopeKey = addressKey(address);
    if (!reference || reference.source !== 'live' || addressKey(reference.logAddress) !== scopeKey) return undefined;
    const note = recordOwn(scope, 'capture');
    const version = recordOwn(note, 'version');
    if (version !== 1 && version !== 2 && version !== 3) return undefined;
    const nativeAddress = recordOwn(note, 'logAddress');
    const commits = interval(recordOwn(note, 'commits'));
    const boundary = recordOwn(note, 'boundary');
    const status = recordOwn(boundary, 'status');
    if (
      !exact(note, version === 3 ? COMMON : LEGACY) ||
      recordOwn(note, 'scope') !== (version === 3 ? 'log' : 'root-log') ||
      recordOwn(note, 'runId') !== reference.runId ||
      recordOwn(note, 'persistence') !== 'memory-only' ||
      !exact(nativeAddress, ['logRunId', 'drillPath']) ||
      addressKey(addressOf(nativeAddress)) !== scopeKey ||
      (version !== 3 && address.drillPath.length !== 0) ||
      !commits ||
      commits.from !== reference.commits.from ||
      commits.to !== reference.commits.to ||
      !actualInterval(log, commits.from, commits.to) ||
      !exact(boundary, ['status'], ['failure']) ||
      !member(status, BOUNDARIES) ||
      status !== reference.boundary
    )
      return undefined;
    const rawFailure = recordOwn(boundary, 'failure');
    const failure =
      rawFailure === undefined ? undefined : safelyCopyFailure(rawFailure, reference.runId, version === 3);
    if (rawFailure !== undefined && (!failure || (status !== 'failed' && status !== 'cancelled'))) return undefined;
    const channels = version === 3 ? currentChannels(recordOwn(note, 'channels')) : legacyChannels(note, version);
    return channels ? { commits, boundary: status, ...(failure && { failure }), channels } : undefined;
  } catch {
    return undefined;
  }
}
