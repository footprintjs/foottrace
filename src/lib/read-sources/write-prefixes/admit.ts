import type { CommitBundle } from '../../memory/types.js';
import { relation } from '../../memory/keyPaths.js';
import { pathSegments } from '../../record-paths/codec.js';
import type { ReadSourceOccurrence, ReadSourceSnapshot } from '../types.js';
import type { WriteReadPrefix } from './types.js';

export interface PrefixRead {
  readonly occurrence: ReadSourceOccurrence;
  readonly path: string;
}
export interface PreparedWriteReadPrefixes<R extends PrefixRead> {
  readonly writes: ReadonlyMap<string, WriteReadPrefix>;
  readonly byFrame: ReadonlyMap<number, readonly R[]>;
  readonly byFrameWrites: ReadonlyMap<number, readonly WriteReadPrefix[]>;
  readonly partial: boolean;
}
export const writePrefixKey = (commitIdx: number, rowIdx: number): string => `${commitIdx}:${rowIdx}`;
const scalar = (value: unknown): boolean =>
  value === null ||
  typeof value === 'boolean' ||
  typeof value === 'string' ||
  (typeof value === 'number' && Number.isFinite(value));

/** One native-row admission for cause and PROV; the sidecar alone grants no authority. */
export function prepareWriteReadPrefixes<R extends PrefixRead>(
  record: ReadSourceSnapshot,
  log: readonly CommitBundle[],
  reads: readonly R[],
  bindings: ReadonlyMap<string, { attempts: ReadonlySet<string>; stateAddress: readonly string[] }>,
  spend: (work: number) => void,
): PreparedWriteReadPrefixes<R> | undefined {
  if (record.version !== 2 || !record.writeReadPrefixes) return undefined;
  const sidecar = record.writeReadPrefixes,
    writes = new Map<string, WriteReadPrefix>(),
    byFrame = new Map<number, R[]>(),
    byFrameWrites = new Map<number, WriteReadPrefix[]>();
  const partial = sidecar.status !== 'captured' || sidecar.omitted > 0;
  spend(log.length + reads.length + sidecar.writes.length + 1);
  for (const read of reads) {
    const frame = read.occurrence.frame;
    if (frame === undefined || read.occurrence.completed === undefined)
      throw new TypeError('read prefixes: missing completion');
    const rows = byFrame.get(frame) ?? [];
    rows.push(read);
    byFrame.set(frame, rows);
  }
  for (const rows of byFrame.values()) {
    spend(rows.length * Math.max(1, Math.ceil(Math.log2(rows.length + 1))));
    rows.sort((a, b) => a.occurrence.completed! - b.occurrence.completed!);
  }
  let nativeRows = 0;
  const privacyCosts: number[] = [];
  const rowCounts = log.map((bundle) => {
    spend(bundle.trace.length + 1);
    const counts = new Map<string, number>();
    for (const row of bundle.trace) {
      spend(row.path.length + 1);
      counts.set(row.path, (counts.get(row.path) ?? 0) + 1);
      nativeRows++;
    }
    let marks = 0;
    for (const mark of bundle.redactedPaths) {
      spend(mark.length + 1);
      marks += mark.length + 1;
    }
    privacyCosts.push(marks);
    return counts;
  });
  for (const prefix of sidecar.writes) {
    const bundle = log[prefix.commitIdx],
      row = bundle?.trace[prefix.rowIdx],
      binding = bindings.get(prefix.runtimeStageId);
    if (
      !bundle ||
      !row ||
      bundle.runtimeStageId !== prefix.runtimeStageId ||
      !prefix.attemptId ||
      !binding?.attempts.has(prefix.attemptId) ||
      binding.stateAddress.length
    )
      throw new TypeError('read prefixes: foreign output');
    const key = writePrefixKey(prefix.commitIdx, prefix.rowIdx);
    if (writes.has(key)) throw new TypeError('read prefixes: duplicate output');
    // Reserve repeated character work before relation() scans shared path prefixes.
    spend(privacyCosts[prefix.commitIdx] + row.path.length * Math.max(1, bundle.redactedPaths.length) + 1);
    if (
      prefix.status === 'observed' &&
      (row.verb !== 'set' ||
        pathSegments(row.path).length !== 1 ||
        rowCounts[prefix.commitIdx].get(row.path) !== 1 ||
        !scalar(bundle.overwrite[row.path]))
    )
      throw new TypeError('read prefixes: unsupported output');
    if (prefix.status === 'observed' && bundle.redactedPaths.some((mark) => relation(mark, row.path) !== undefined))
      throw new TypeError('read prefixes: hidden output');
    writes.set(key, prefix);
    const outputs = byFrameWrites.get(prefix.frame) ?? [];
    outputs.push(prefix);
    byFrameWrites.set(prefix.frame, outputs);
  }
  if (!partial && writes.size !== nativeRows) throw new TypeError('read prefixes: incomplete native outputs');
  for (const outputs of byFrameWrites.values()) {
    spend(outputs.length * Math.max(1, Math.ceil(Math.log2(outputs.length + 1))));
    outputs.sort((a, b) => a.through - b.through);
  }
  return { writes, byFrame, byFrameWrites, partial };
}

/** Query-bounded inverse of the same observed prefix; no every-write scan per source read. */
export function writePrefixesForRead<R extends PrefixRead>(
  prepared: PreparedWriteReadPrefixes<R>,
  read: R,
  maximum: number,
): { writes: readonly WriteReadPrefix[]; complete: boolean; truncated?: boolean } {
  const occurrence = read.occurrence;
  if (occurrence.frame === undefined || occurrence.completed === undefined || occurrence.disposition !== 'released')
    return { writes: [], complete: false };
  const rows = prepared.byFrameWrites.get(occurrence.frame) ?? [];
  let left = 0,
    right = rows.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (rows[middle].through < occurrence.completed) left = middle + 1;
    else right = middle;
  }
  const writes: WriteReadPrefix[] = [];
  let checked = 0,
    complete = !prepared.partial;
  for (let index = left; index < rows.length; index++) {
    if (++checked > maximum) return { writes, complete: false, truncated: true };
    const prefix = rows[index];
    if (
      prefix.status !== 'observed' ||
      prefix.runtimeStageId !== occurrence.runtimeStageId ||
      prefix.attemptId !== occurrence.attemptId
    ) {
      // Only a matching frame/frontier candidate limits this read's forward association.
      complete = false;
      continue;
    }
    writes.push(prefix);
  }
  return { writes, complete };
}

/** Binary rank first, then bounded expansion. No per-write preparation copy of its whole read prefix. */
export function writePrefixReads<R extends PrefixRead>(
  prepared: PreparedWriteReadPrefixes<R>,
  prefix: WriteReadPrefix,
  maximum: number,
): { reads: readonly R[]; complete: boolean } {
  const rows = prepared.byFrame.get(prefix.frame) ?? [];
  let left = 0,
    right = rows.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (rows[middle].occurrence.completed! <= prefix.through) left = middle + 1;
    else right = middle;
  }
  const end = Math.min(left, maximum);
  const reads = rows.slice(0, end);
  const owned = reads.every(
    (read) =>
      read.occurrence.runtimeStageId === prefix.runtimeStageId &&
      read.occurrence.attemptId === prefix.attemptId &&
      read.occurrence.disposition === 'released',
  );
  return {
    reads: owned ? reads : [],
    complete: owned && prefix.status === 'observed' && left === prefix.count && left <= maximum,
  };
}
