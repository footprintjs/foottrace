import type { LogAddress } from '../memory/eventPosition.js';
import { addressOf, recordOwn } from '../evidence/recordData.js';
import type { RecordScopeLoader } from './recordTypes.js';
import type { GraphContext } from './types.js';
import { decodeRecordCapture } from '../evidence/recordCapture/decode.js';
import { exact, interval, member } from '../evidence/recordCapture/shape.js';
import {
  CAPTURE_CHANNELS,
  CAPTURE_MODES,
  type CaptureCoverage,
  type CaptureObservation,
  type CaptureQuery,
  type CaptureReason,
} from '../evidence/recordCapture/types.js';

export { decodeRecordCapture };
export type {
  CaptureChannel,
  CaptureCoverage,
  CaptureFailure,
  CaptureMode,
  CaptureObservation,
  CaptureQuery,
  CaptureReason,
  CaptureWitness,
} from '../evidence/recordCapture/types.js';

const unknown = (reason: CaptureReason): CaptureCoverage => ({ state: 'collection-unknown', reasons: [reason] });

function answer(note: CaptureObservation | undefined, query: CaptureQuery): CaptureCoverage {
  if (!note) return unknown('unverified');
  if (query.from < note.commits.from || query.to > note.commits.to) return unknown('interval-incomplete');
  const channel = note.channels[query.channel];
  const evidence = {
    reasons: [...channel.reasons],
    ...(note.failure && {
      failure: {
        category: note.failure.category,
        ...(note.failure.stage && { stage: { ...note.failure.stage } }),
      },
    }),
  };
  switch (channel.status) {
    case 'disabled':
      return { state: 'not-collected', ...evidence };
    case 'unknown':
      return { state: 'collection-unknown', ...evidence };
    case 'partial':
    case 'failed':
      return { state: channel.status, ...evidence };
    case 'collected':
      if (note.boundary !== 'completed') return { ...evidence, state: 'partial', reasons: ['interval-incomplete'] };
      if (channel.mode === query.mode || (channel.mode === 'full' && query.mode === 'summary'))
        return { state: 'covered', ...evidence };
      return { ...evidence, state: 'partial', reasons: ['missing-evidence'] };
  }
}

export async function captureCoverage(
  loader: RecordScopeLoader,
  address: LogAddress,
  query: CaptureQuery,
  context: GraphContext,
): Promise<CaptureCoverage> {
  try {
    if (!exact(query, ['channel', 'from', 'to', 'mode'], ['crossing'])) return unknown('unverified');
    const crossing = recordOwn(query, 'crossing');
    if (crossing === 'worker' || crossing === 'transport')
      return unknown(crossing === 'worker' ? 'worker-boundary' : 'transport-boundary');
    const channel = recordOwn(query, 'channel');
    const mode = recordOwn(query, 'mode');
    const range = interval({ from: recordOwn(query, 'from'), to: recordOwn(query, 'to') });
    if (
      context.signal.aborted ||
      crossing !== undefined ||
      !range ||
      !member(channel, CAPTURE_CHANNELS) ||
      !member(mode, CAPTURE_MODES[channel]) ||
      mode === 'off' ||
      mode === 'unknown'
    )
      return unknown('unverified');
    const scope = await loader.loadScope(addressOf(address), context);
    if ('failure' in scope || context.signal.aborted) return unknown('unverified');
    const gaps = loader.extraGapCodes(scope);
    if (!scope.complete || gaps?.length) return unknown('missing-evidence');
    return answer(scope.capture, { ...range, channel, mode });
  } catch {
    return unknown('unverified');
  }
}
