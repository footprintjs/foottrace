import { READ_SOURCE_V1_CEILINGS } from './format.js';
import type { ReadSource, ReadSourceOccurrence, ReadSourceSnapshot } from './types.js';
import { READ_SOURCE_GAPS } from './types.js';
import {
  sourceAddress,
  sourceName,
  sourceBytes,
  sourceInteger,
  sourceKey,
  sourceLimits,
  sourceList,
  sourceOwn,
  sourceOwner,
} from './admission.js';

function sourceOf(value: unknown): ReadSource {
  const kind = sourceOwn(value, 'kind');
  if (kind === 'base') return Object.freeze({ kind, base: sourceInteger(sourceOwn(value, 'base'), 1) });
  if (kind === 'committed') return Object.freeze({ kind, commitIdx: sourceInteger(sourceOwn(value, 'commitIdx')) });
  if (kind === 'staged')
    return Object.freeze({
      kind,
      frame: sourceInteger(sourceOwn(value, 'frame'), 1),
      generation: sourceInteger(sourceOwn(value, 'generation'), 1),
    });
  const reason = sourceOwn(value, 'reason');
  if (kind === 'unavailable' && READ_SOURCE_GAPS.includes(reason as never))
    return Object.freeze({ kind, reason: reason as (typeof READ_SOURCE_GAPS)[number] });
  throw new TypeError('read sources: invalid source');
}

/** Structural admission only; a consumer must separately validate scope and referenced native rows. */
export function decodeReadSourceSnapshot(value: unknown): ReadSourceSnapshot | undefined {
  try {
    if (sourceOwn(value, 'version') !== 1) return undefined;
    const limits = sourceLimits(sourceOwn(value, 'limits'), READ_SOURCE_V1_CEILINGS);
    let remaining = limits.maxBytes;
    const spend = (bytes: number) => {
      remaining -= bytes;
      if (remaining < 0) throw new TypeError('read sources: byte limit');
    };
    let headerStrings = 0;
    const address = sourceAddress(sourceOwn(value, 'address'), (input) => {
      const name = sourceName(input),
        bytes = sourceBytes(name);
      spend(bytes);
      headerStrings += bytes;
      return name;
    });
    const segment = sourceInteger(sourceOwn(value, 'segment'), 1);
    spend(
      sourceBytes({ version: 1, limits, address, segment, status: 'captured', occurrences: [], gaps: [] }) -
        headerStrings,
    );
    const status = sourceOwn(value, 'status');
    if (status !== 'captured' && status !== 'partial' && status !== 'failed' && status !== 'retired') return undefined;
    let previous = 0;
    const counts = new Map<string, number>();
    const occurrences = sourceList(
      sourceOwn(value, 'occurrences'),
      limits.maxOccurrences,
      (input): ReadSourceOccurrence => {
        const ordinal = sourceInteger(sourceOwn(input, 'ordinal'), 1);
        if (ordinal <= previous) throw new TypeError('read sources: invalid order');
        previous = ordinal;
        const owner = sourceOwner(input),
          source = sourceOf(sourceOwn(input, 'source'));
        const attemptStatus = sourceOwn(input, 'attemptStatus');
        if (attemptStatus !== (owner.attemptId === undefined ? 'unavailable' : 'known'))
          throw new TypeError('read sources: invalid owner');
        const frameValue = sourceOwn(input, 'frame');
        const frame = frameValue === undefined ? undefined : sourceInteger(frameValue, 1);
        if (source.kind === 'staged' && source.frame !== frame) throw new TypeError('read sources: invalid frame');
        if (source.kind === 'base' && source.base !== segment) throw new TypeError('read sources: invalid base');
        const disposition = sourceOwn(input, 'disposition');
        if (disposition !== 'active' && disposition !== 'released' && disposition !== 'discarded')
          throw new TypeError('read sources: invalid disposition');
        const count = (counts.get(owner.runtimeStageId) ?? 0) + 1;
        if (count > limits.maxPerExecution) throw new TypeError('read sources: invalid count');
        counts.set(owner.runtimeStageId, count);
        let addressBytes = 0;
        const stateAddress = sourceList(sourceOwn(input, 'stateAddress'), 64, (part) => {
          const key = sourceKey(part),
            bytes = sourceBytes(key);
          spend(bytes);
          addressBytes += bytes;
          return key;
        });
        const row = Object.freeze({
          ordinal,
          ...owner,
          attemptStatus: owner.attemptId === undefined ? ('unavailable' as const) : ('known' as const),
          ...(frame === undefined ? {} : { frame }),
          key: sourceKey(sourceOwn(input, 'key')),
          stateAddress,
          source,
          disposition,
        });
        spend(sourceBytes(row) - addressBytes + 1);
        return row;
      },
    );
    if (occurrences.length) remaining++;
    const seen = new Set<string>();
    const gaps = sourceList(sourceOwn(value, 'gaps'), READ_SOURCE_GAPS.length, (input) => {
      const reason = sourceOwn(input, 'reason');
      if (!READ_SOURCE_GAPS.includes(reason as never) || seen.has(reason as string))
        throw new TypeError('read sources: invalid gap');
      seen.add(reason as string);
      const exact = sourceOwn(input, 'exact');
      if (typeof exact !== 'boolean') throw new TypeError('read sources: invalid gap');
      const gap = Object.freeze({
        reason: reason as (typeof READ_SOURCE_GAPS)[number],
        count: sourceInteger(sourceOwn(input, 'count'), 1),
        exact,
      });
      spend(sourceBytes(gap) + 1);
      return gap;
    });
    if (gaps.length) remaining++;
    if (status === 'captured' && (gaps.length || occurrences.some((row) => row.source.kind === 'unavailable')))
      return undefined;
    const result: ReadSourceSnapshot = Object.freeze({
      version: 1,
      address,
      segment,
      status,
      occurrences,
      gaps,
      limits,
    });
    return sourceBytes(result) <= limits.maxBytes ? result : undefined;
  } catch {
    return undefined;
  }
}
