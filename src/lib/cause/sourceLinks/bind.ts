import { placedAt } from '../../memory/readWindow.js';
import type { CommitBundle } from '../../memory/types.js';
import { bundleOf, dataCopy, mapOf, names, recordList, recordOwn, recordRefusalCode } from '../recordValidation.js';
import { maximumSourceLinks, rowLocation } from './admission.js';
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

interface BindingScope {
  readonly commitLog: readonly unknown[];
  readonly initialState?: Record<string, unknown>;
  readonly reads?: Readonly<Record<string, readonly string[]>>;
}

interface BatchBinding {
  readonly writes: readonly (SourceLinkWrite | undefined)[];
  readonly complete: boolean;
}

function locatorOf(value: unknown): SourceLinkRowLocation | undefined {
  try {
    if (value === null || typeof value !== 'object') return undefined;
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) return undefined;
    return rowLocation(value);
  } catch {
    return undefined;
  }
}

function replayForBinding(scope: BindingScope): SourceLinkReplay | undefined {
  const budget = { left: 1_000_000 };
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
  return sourceLinkReplay({ log, base, reads }, budget);
}

function exhausted(error: unknown): boolean {
  const code = recordRefusalCode(error);
  return code === 'node-limit' || code === 'truncated';
}

/**
 * Names the writes checked by the requested committed rows of one scope. The scope is admitted
 * once and the replay is shared. Answers keep locator order and include one slot for each of
 * the first 256 locators. A missing or refused locator has no binding.
 *
 * An unreadable locator list produces no answers and is incomplete. If the locator cap or a
 * replay allowance is reached, the result is incomplete and unfilled slots are unknown.
 */
export function bindSourceLinkWrites(scope: BindingScope, locators: readonly SourceLinkRowLocation[]): BatchBinding {
  let requested: (SourceLinkRowLocation | undefined)[];
  let complete: boolean;
  try {
    if (!Array.isArray(locators)) return { writes: [], complete: false };
    const size = recordOwn(locators, 'length');
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return { writes: [], complete: false };
    const count = Math.min(size, maximumSourceLinks);
    requested = Array.from({ length: count }, (_, index) => locatorOf(recordOwn(locators, String(index))));
    complete = size === count;
  } catch {
    return { writes: [], complete: false };
  }

  const writes = Array<SourceLinkWrite | undefined>(requested.length).fill(undefined);
  if (!requested.some((where) => where !== undefined)) return { writes, complete };

  let replay: SourceLinkReplay | undefined;
  try {
    replay = replayForBinding(scope);
  } catch (error) {
    return { writes, complete: complete && !exhausted(error) };
  }
  if (!replay) return { writes, complete };

  for (const [index, where] of requested.entries()) {
    if (where === undefined) continue;
    try {
      const row = committedRow(replay, where);
      if (row !== undefined && !replay.unionTouchesPosition(row.output, where.commitIdx))
        writes[index] = boundWrite(replay, row, where);
    } catch (error) {
      if (exhausted(error)) return { writes, complete: false };
    }
  }
  return { writes, complete };
}

/**
 * Names the write a committed source-link row checked. Give it the same scope
 * base, log and optional tracked reads the record will carry to the verifier.
 * Unaccounted history, a missing row or an ambiguous read leaves no binding.
 */
export function bindSourceLinkWrite(scope: BindingScope, locator: SourceLinkRowLocation): SourceLinkWrite | undefined {
  return bindSourceLinkWrites(scope, [locator]).writes[0];
}
