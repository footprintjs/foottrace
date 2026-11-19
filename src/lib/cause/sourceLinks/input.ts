import type { GapCode } from '../types.js';
import type { SourceLinkReplay } from './replay.js';
import { resolves } from './replay.js';
import { readServedRow } from './rows.js';
import type { RecordSourceLink, ServedRow, SourceLinkSelection } from './types.js';

type InputResolution = { readonly origin?: number } | { readonly gap: GapCode };

function requestGap(
  replay: SourceLinkReplay,
  first: number,
  consumer: string,
  served: RecordSourceLink['served'],
  input: SourceLinkSelection,
): GapCode | undefined {
  if (!served) return 'not-collected';
  const start = replay.appended(served.key, first);
  if (start === undefined) return 'not-collected';
  const list = replay.value(served.key, first);
  if (!Array.isArray(list)) return 'not-collected';
  replay.spend(list.length - start);
  let selected: ServedRow | undefined;
  for (let index = start; index < list.length; index++) {
    if (!Object.hasOwn(list, index)) continue;
    if (replay.redacted({ key: served.key, element: index }, first)) return 'not-collected';
    const row = readServedRow(list[index]);
    if (!row) continue;
    if (selected) return 'ambiguous';
    selected = row;
  }
  if (!selected || selected.consumer !== consumer) return 'not-collected';
  const servedKey = selected.served.find((item) => item.key === input.key);
  const index = input.element;
  const matches =
    index === undefined
      ? servedKey !== undefined && servedKey.elements === undefined
      : servedKey?.elements?.some(([start, end]) => start <= index && index < end);
  return matches ? undefined : selected.bounded ? 'truncated' : 'no-match';
}

/** Report the first unproven part of the consumer's view and served occurrence. */
export function resolveInput(
  replay: SourceLinkReplay,
  link: RecordSourceLink,
  input: SourceLinkSelection,
): InputResolution {
  const consumer = link.consumer.runtimeStageId;
  const first = replay.first(consumer);
  if (first === undefined || link.witness.commitIdx < first) return { gap: 'not-collected' };
  if (first >= replay.accounted || link.witness.commitIdx >= replay.accounted) return { gap: 'not-collected' };
  const view = replay.window(first);
  if (replay.writtenBetween({ key: input.key }, view.start, view.end)) return { gap: 'ambiguous' };
  const viewStop = view.start - 1;
  if (replay.redacted(input, viewStop)) return { gap: 'redacted' };
  if (!replay.exists(input.key, viewStop) || !resolves(replay.value(input.key, viewStop), input))
    return { gap: 'stale' };
  const missing = requestGap(replay, first, consumer, link.served, input);
  if (missing) return { gap: missing };
  if (replay.writtenBetween(input, view.start, link.witness.commitIdx + 1)) return { gap: 'stale' };
  const origin = replay.writer(input, view.start);
  return { ...(origin === undefined ? {} : { origin }) };
}
