import { deepEqual } from '../../memory/equality.js';
import type { LogAddress } from '../../memory/eventPosition.js';
import type { GapCode, GraphContext } from '../types.js';
import { boundWrite, committedRow } from './bind.js';
import { resolveInput } from './input.js';
import { allows, locators, writeLocator } from './policy.js';
import { resolves, type SourceLinkReplay } from './replay.js';
import type {
  RecordSourceLink,
  SourceLink,
  SourceLinkGap,
  SourceLinkPolicy,
  SourceLinkSelection,
  SourceLinkRow,
} from './types.js';

type NodeIdForWrite = (write: {
  readonly runtimeStageId: string;
  readonly commitIdx: number;
  readonly key: string;
}) => string;
type Result = { readonly link?: SourceLink; readonly gaps: readonly SourceLinkGap[] };

function rowMatches(link: RecordSourceLink, row: SourceLinkRow): boolean {
  const { runtimeStageId: _, commitIdx: __, ...output } = link.output;
  return (
    row.consumer === link.consumer.runtimeStageId &&
    row.linkBasis === link.linkBasis &&
    row.namedBy === link.namedBy &&
    row.check === link.check &&
    row.bounded === link.bounded &&
    row.leafWithheld === link.leafWithheld &&
    deepEqual(row.output, output, 'copies') &&
    deepEqual(row.input, link.input, 'copies')
  );
}

function outputLeaf(link: RecordSourceLink, nodeId: string): NonNullable<SourceLinkGap['output']> {
  const { key, element, pointer, span } = link.output;
  const selection: SourceLinkSelection & Pick<typeof link.output, 'span'> = Object.freeze({
    key,
    ...(element === undefined ? {} : { element }),
    ...(pointer === undefined ? {} : { pointer }),
    ...(span === undefined ? {} : { span }),
  });
  return Object.freeze({ nodeId, selection });
}

/** Resolve only fully authorized locators, and ask again before projecting a result. */
export function resolveLink(
  link: RecordSourceLink,
  address: LogAddress,
  context: GraphContext,
  policy: SourceLinkPolicy,
  nodeId: NodeIdForWrite,
  replayFor: () => SourceLinkReplay | undefined,
): Result {
  const lookup = locators(address, link);
  const outputAllowed = () => allows(policy, lookup.output, context);
  const allOthersAllowed = () => lookup.others.every((locator) => allows(policy, locator, context));
  if (!outputAllowed()) return { gaps: [{ code: 'not-permitted' }] };
  const output = outputLeaf(link, nodeId(link.output));
  if (!allOthersAllowed()) return { gaps: [{ code: 'not-permitted', output }] };
  const outputGap = (code: GapCode): Result => {
    if (!outputAllowed()) return { gaps: [{ code: 'not-permitted' }] };
    if (!allOthersAllowed()) return { gaps: [{ code: 'not-permitted', output }] };
    return {
      gaps: [
        { code, output },
        ...(link.bounded && code !== 'truncated' ? [{ code: 'truncated' as const, output }] : []),
      ],
    };
  };
  if (link.leafWithheld) return outputGap('redacted');
  const replay = replayFor();
  if (!replay) return outputGap('not-collected');
  const { commitIdx, runtimeStageId, key } = link.output;
  if (commitIdx >= replay.accounted || replay.log[commitIdx]?.runtimeStageId !== runtimeStageId)
    return outputGap('stale');
  if (replay.redacted(link.output, commitIdx)) return outputGap('redacted');
  if (!replay.exists(key, commitIdx) || !resolves(replay.value(key, commitIdx), link.output)) return outputGap('stale');
  if (link.check === 'no-match' || link.check === 'not-checked') return outputGap(link.check);
  if (!link.input || !lookup.view) return outputGap('not-collected');
  const input = resolveInput(replay, link, link.input);
  if ('gap' in input) return outputGap(input.gap);

  const row = committedRow(replay, link.witness);
  const bound = row && rowMatches(link, row) ? boundWrite(replay, row, link.witness) : undefined;
  const standing = bound?.runtimeStageId === runtimeStageId && bound.commitIdx === commitIdx ? 'witnessed' : 'declared';
  const origin =
    input.origin === undefined
      ? undefined
      : writeLocator(address, {
          ...link.input,
          commitIdx: input.origin,
          runtimeStageId: replay.log[input.origin].runtimeStageId,
        });
  const allowedAtResolution = origin !== undefined && allows(policy, origin, context);
  if (!outputAllowed()) return { gaps: [{ code: 'not-permitted' }] };
  if (!allOthersAllowed()) return { gaps: [{ code: 'not-permitted', output }] };
  const discloseOrigin = allowedAtResolution && allows(policy, origin, context);
  const gaps: SourceLinkGap[] = [];
  if (!discloseOrigin) gaps.push({ code: 'unavailable', reason: 'Origin is unavailable for this view.', output });
  if (link.bounded) gaps.push({ code: 'truncated', output });
  return {
    link: Object.freeze({
      attribution: 'source-link',
      standing,
      linkBasis: link.linkBasis,
      ...(link.namedBy === undefined ? {} : { namedBy: link.namedBy }),
      check: link.check,
      output,
      input: Object.freeze({
        view: lookup.view,
        ...(discloseOrigin
          ? {
              origin: Object.freeze({
                nodeId: nodeId({
                  key: origin.key,
                  commitIdx: origin.commitIdx!,
                  runtimeStageId: origin.runtimeStageId,
                }),
                write: origin,
              }),
            }
          : {}),
      }),
    }),
    gaps,
  };
}
