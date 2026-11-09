import { sourceBytes, sourceInteger, sourceList, sourceOwn, sourceOwner } from '../admission.js';
import type { ReadSourceLimits, ReadSourceOccurrence } from '../types.js';
import { WRITE_READ_V2_CEILINGS } from './format.js';
import type { WriteReadFrame, WriteReadPrefix, WriteReadPrefixes } from './types.js';

/** Source-format-2 sidecar admission. Saved producer authenticity remains a host boundary. */
export function decodeWriteReadPrefixes(
  value: unknown,
  occurrences: readonly ReadSourceOccurrence[],
  limits: ReadSourceLimits,
  spend: (bytes: number) => void,
): WriteReadPrefixes {
  if (sourceOwn(value, 'version') !== 1) throw new TypeError('read prefixes: invalid format');
  const status = sourceOwn(value, 'status'),
    omitted = sourceInteger(sourceOwn(value, 'omitted'));
  if ((status !== 'captured' && status !== 'partial') || (status === 'captured' && omitted))
    throw new TypeError('read prefixes: invalid status');
  const completions = new Set<number>(),
    byFrame = new Map<number, ReadSourceOccurrence[]>();
  for (const row of occurrences) {
    if (row.completed === undefined || row.frame === undefined || completions.has(row.completed))
      throw new TypeError('read prefixes: invalid completion');
    completions.add(row.completed);
    const rows = byFrame.get(row.frame) ?? [];
    rows.push(row);
    byFrame.set(row.frame, rows);
  }
  const manifests = new Map<number, WriteReadFrame>();
  const frames = sourceList(
    sourceOwn(value, 'frames'),
    Math.min(limits.maxOrigins, WRITE_READ_V2_CEILINGS.maxFrames),
    (input) => {
      const owner = sourceOwner(input),
        frame = sourceInteger(sourceOwn(input, 'frame'), 1),
        count = sourceInteger(sourceOwn(input, 'count')),
        writes = sourceInteger(sourceOwn(input, 'writes'));
      if (!owner.attemptId || manifests.has(frame) || count > limits.maxOccurrences)
        throw new TypeError('read prefixes: invalid frame');
      const row = Object.freeze({ frame, ...owner, count, writes });
      spend(sourceBytes(row) + 1);
      manifests.set(frame, row);
      return row;
    },
  );
  if (status === 'captured') {
    for (const [frame, manifest] of manifests) {
      const rows = byFrame.get(frame) ?? [];
      if (
        manifest.count !== rows.length ||
        rows.some((row) => row.runtimeStageId !== manifest.runtimeStageId || row.attemptId !== manifest.attemptId)
      )
        throw new TypeError('read prefixes: incomplete frame');
    }
    for (const frame of byFrame.keys()) if (!manifests.has(frame)) throw new TypeError('read prefixes: missing frame');
  }
  const sortedCompletions = new Map(
    [...byFrame].map(([frame, rows]) => [frame, rows.map((row) => row.completed!).sort((a, b) => a - b)]),
  );
  const prefixCount = (frame: number, through: number): number => {
    const rows = sortedCompletions.get(frame) ?? [];
    let left = 0,
      right = rows.length;
    while (left < right) {
      const middle = (left + right) >>> 1;
      if (rows[middle] <= through) left = middle + 1;
      else right = middle;
    }
    return left;
  };
  let finalCompletion = 0;
  for (const completed of completions) finalCompletion = Math.max(finalCompletion, completed);
  if (finalCompletion !== occurrences.length) throw new TypeError('read prefixes: incomplete completion sequence');
  const identities = new Set<string>(),
    frameWrites = new Map<number, number>();
  const writes = sourceList(
    sourceOwn(value, 'writes'),
    Math.min(limits.maxOccurrences, WRITE_READ_V2_CEILINGS.maxWrites),
    (input) => {
      const owner = sourceOwner(input),
        commitIdx = sourceInteger(sourceOwn(input, 'commitIdx')),
        rowIdx = sourceInteger(sourceOwn(input, 'rowIdx')),
        frame = sourceInteger(sourceOwn(input, 'frame'), 1),
        through = sourceInteger(sourceOwn(input, 'through')),
        count = sourceInteger(sourceOwn(input, 'count'));
      const state = sourceOwn(input, 'status'),
        reason = sourceOwn(input, 'reason'),
        manifest = manifests.get(frame),
        key = JSON.stringify([commitIdx, rowIdx]);
      if (
        !owner.attemptId ||
        identities.has(key) ||
        !manifest ||
        manifest.runtimeStageId !== owner.runtimeStageId ||
        manifest.attemptId !== owner.attemptId ||
        count > manifest.count ||
        (state !== 'observed' && state !== 'unavailable')
      )
        throw new TypeError('read prefixes: invalid write');
      if (
        state === 'observed'
          ? reason !== undefined
          : reason !== 'unsupported-write' && reason !== 'owner-unavailable' && reason !== 'redacted'
      )
        throw new TypeError('read prefixes: invalid reason');
      if ((status === 'captured' && through > finalCompletion) || prefixCount(frame, through) !== count)
        throw new TypeError('read prefixes: incomplete prefix');
      const row: WriteReadPrefix = Object.freeze({
        commitIdx,
        rowIdx,
        frame,
        ...owner,
        through,
        count,
        status: state,
        ...(reason === undefined ? {} : { reason: reason as WriteReadPrefix['reason'] }),
      });
      identities.add(key);
      frameWrites.set(frame, (frameWrites.get(frame) ?? 0) + 1);
      spend(sourceBytes(row) + 1);
      return row;
    },
  );
  for (const [frame, manifest] of manifests) {
    const retained = frameWrites.get(frame) ?? 0;
    if (retained > manifest.writes || (status === 'captured' && retained !== manifest.writes))
      throw new TypeError('read prefixes: incomplete committed outputs');
  }
  const result: WriteReadPrefixes = Object.freeze({ version: 1, status, frames, writes, omitted });
  spend(sourceBytes({ version: 1, status, frames: [], writes: [], omitted }));
  return result;
}
