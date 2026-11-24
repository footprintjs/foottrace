import { readerLimits } from '../../evidence/readerLimits.js';
import { placedAt } from '../../memory/readWindow.js';
import type { CommitBundle } from '../../memory/types.js';
import {
  bundleOf,
  dataCopy,
  mapOf,
  names,
  recordList,
  recordOwn,
  recordRefusalCode,
  type RecordBudget,
} from '../recordValidation.js';
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

interface BindingScope {
  readonly commitLog: readonly unknown[];
  readonly initialState?: Record<string, unknown>;
  readonly reads?: Readonly<Record<string, readonly string[]>>;
}

interface BatchBinding {
  readonly writes: readonly (SourceLinkWrite | undefined)[];
  readonly complete: boolean;
  /** Present when a named read limit prevented the batch from completing. */
  readonly reason?: 'node-limit' | 'truncated';
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

function replayForBinding(scope: BindingScope, budget: RecordBudget): SourceLinkReplay | undefined {
  const source = recordList(recordOwn(scope, 'commitLog'), readerLimits.causeCommits.maximum);
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

function bindingRefusal(error: unknown, budget: { left: number }): BatchBinding['reason'] {
  const code = recordRefusalCode(error);
  if (code === 'truncated' || (code === 'node-limit' && budget.left < 0)) {
    return readerLimits.binderWork.reason;
  }
  return code === 'node-limit' ? code : undefined;
}

function batchResult(writes: BatchBinding['writes'], reason?: BatchBinding['reason']): BatchBinding {
  return { writes, complete: reason === undefined, ...(reason === undefined ? {} : { reason }) };
}

/**
 * Names the writes checked by the requested committed rows of one scope. The scope is admitted
 * once and the replay is shared. Answers keep locator order and include one slot for each of
 * the first 256 locators. A missing or refused locator has no binding.
 *
 * An unreadable locator list produces no answers and is incomplete. A count cap reports
 * `node-limit`; exhausted record work reports `truncated`. Unfilled slots are still unknown.
 */
export function bindSourceLinkWrites(scope: BindingScope, locators: readonly SourceLinkRowLocation[]): BatchBinding {
  let requested: (SourceLinkRowLocation | undefined)[];
  let reason: BatchBinding['reason'];
  try {
    if (!Array.isArray(locators)) return { writes: [], complete: false };
    const size = recordOwn(locators, 'length');
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return { writes: [], complete: false };
    const count = Math.min(size, readerLimits.binderLocators.maximum);
    requested = Array.from({ length: count }, (_, index) => locatorOf(recordOwn(locators, String(index))));
    if (size > count) reason = readerLimits.binderLocators.reason;
  } catch {
    return { writes: [], complete: false };
  }

  const writes = Array<SourceLinkWrite | undefined>(requested.length).fill(undefined);
  if (!requested.some((where) => where !== undefined)) return batchResult(writes, reason);

  const budget = { left: readerLimits.binderWork.maximum, workExhaustion: readerLimits.binderWork.reason };
  let replay: SourceLinkReplay | undefined;
  try {
    replay = replayForBinding(scope, budget);
  } catch (error) {
    return batchResult(writes, bindingRefusal(error, budget) ?? reason);
  }
  if (!replay) return batchResult(writes, reason);

  for (const [index, where] of requested.entries()) {
    if (where === undefined) continue;
    try {
      const row = committedRow(replay, where);
      if (row !== undefined && !replay.unionTouchesPosition(row.output, where.commitIdx))
        writes[index] = boundWrite(replay, row, where);
    } catch (error) {
      const refusal = bindingRefusal(error, budget);
      if (refusal !== undefined) return batchResult(writes, refusal);
    }
  }
  return batchResult(writes, reason);
}

/**
 * Names the write a committed source-link row checked. Give it the same scope
 * base, log and optional tracked reads the record will carry to the verifier.
 * Unaccounted history, a missing row or an ambiguous read leaves no binding.
 */
export function bindSourceLinkWrite(scope: BindingScope, locator: SourceLinkRowLocation): SourceLinkWrite | undefined {
  return bindSourceLinkWrites(scope, [locator]).writes[0];
}
