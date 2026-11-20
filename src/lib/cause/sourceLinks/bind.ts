import { placedAt } from '../../memory/readWindow.js';
import type { CommitBundle } from '../../memory/types.js';
import { bundleOf, dataCopy, mapOf, names, recordList, recordOwn } from '../recordValidation.js';
import { rowLocation } from './admission.js';
import { sourceLinkReplay, type SourceLinkReplay } from './replay.js';
import { readSourceLinkRow } from './rows.js';
import type { SourceLinkRow, SourceLinkRowLocation, SourceLinkWrite } from './types.js';

export function committedRow(replay: SourceLinkReplay, location: SourceLinkRowLocation): SourceLinkRow | undefined {
  const commit = replay.log[location.commitIdx];
  if (commit?.runtimeStageId !== location.runtimeStageId || replay.redacted(location, location.commitIdx))
    return undefined;
  if (replay.unionTouchesPosition(location, location.commitIdx)) return undefined;
  const start = replay.appended(location.key, location.commitIdx);
  if (start === undefined || location.element < start) return undefined;
  const entry = replay.list(location.key, location.commitIdx)?.element(location.element);
  return entry?.present ? readSourceLinkRow(entry.value) : undefined;
}

export function boundWrite(
  replay: SourceLinkReplay,
  row: SourceLinkRow,
  witness: SourceLinkRowLocation,
): SourceLinkWrite | undefined {
  const first = replay.first(row.consumer);
  if (first === undefined || witness.commitIdx < first) return undefined;
  const output = row.output;
  let index: number | undefined;
  if (output.checkedIn === 'written') {
    if (replay.selectedWrite(output, witness.commitIdx)) index = witness.commitIdx;
  } else {
    const firstDoor = replay.first(witness.runtimeStageId);
    if (firstDoor === undefined || !replay.read(witness.runtimeStageId, output.key)) return undefined;
    const view = replay.window(firstDoor);
    if (replay.hasWindowWrite(output.key, view.start, view.end)) return undefined;
    index = replay.writer(output, view.start);
  }
  if (index === undefined || index < first || replay.redacted(output, index) || !replay.resolves(output, index))
    return undefined;
  return { commitIdx: index, runtimeStageId: replay.log[index].runtimeStageId };
}

/**
 * Names the write a committed source-link row checked. Give it the same scope
 * base, log and optional tracked reads the record will carry to the verifier.
 * Unaccounted history, a missing row or an ambiguous read leaves no binding.
 */
export function bindSourceLinkWrite(
  scope: {
    readonly commitLog: readonly unknown[];
    readonly initialState?: Record<string, unknown>;
    readonly reads?: Readonly<Record<string, readonly string[]>>;
  },
  locator: SourceLinkRowLocation,
): SourceLinkWrite | undefined {
  try {
    const where = rowLocation(locator);
    const budget = { left: 1000000 };
    const source = recordList(recordOwn(scope, 'commitLog'), 4096);
    let prior = -1;
    const log: CommitBundle[] = source.map((entry) => {
      const bundle = bundleOf(entry, prior, budget);
      prior = placedAt(bundle, prior);
      return bundle;
    });
    const initial = recordOwn(scope, 'initialState');
    if (initial === null || typeof initial !== 'object' || Array.isArray(initial)) return undefined;
    const base = dataCopy(initial, budget) as Record<string, unknown>;
    const reads = mapOf(recordOwn(scope, 'reads'), log.length, (value) => names(value, 128, true), budget);
    const replay = sourceLinkReplay({ log, base, reads }, budget);
    const row = committedRow(replay, where);
    if (row === undefined || replay.unionTouchesPosition(row.output, where.commitIdx)) return undefined;
    return boundWrite(replay, row, where);
  } catch {
    return undefined;
  }
}
