import { buildRuntimeStageId, executionIndexOf, stageIdOf } from '../../ids/runtimeStageId.js';
import { rowsUnderRoot } from '../../memory/commitLogUtils.js';
import { equalWithTextWork } from '../../memory/equality.js';
import { relation, rootOf } from '../../memory/keyPaths.js';
import { isDeniedSegment, nativeGet, nativeHas } from '../../memory/pathOps.js';
import { LOG_PLACEHOLDER } from '../../memory/placeholders.js';
import { foldKey } from '../../memory/verbs.js';
import { pathSegments } from '../../record-paths/codec.js';
import type { StoredLog } from '../../time-travel/storedRecord.js';
import { dataCopy, recordName, recordOwn, RecordRefusal, recordRefusalCode, spend } from '../recordValidation.js';
import { chargeRow, chargeShape } from '../sourceLinks/foldBudget.js';
import type { SkippedWork } from './types.js';

type HistoryReason = 'not-collected' | 'redacted' | 'truncated' | 'conservative' | 'invalid-data';
type KeyHistory =
  | { readonly status: 'ready'; readonly lastChangeIdx?: number; readonly observed: ReadonlySet<string> }
  | { readonly status: 'unknown'; readonly reason: HistoryReason };

function copyValue<T>(value: T, budget: SkippedWork): T {
  try {
    return dataCopy(value, budget) as T;
  } catch (error) {
    if (recordRefusalCode(error) === 'invalid-data') throw new RecordRefusal('conservative');
    throw error;
  }
}

function rootPatch(value: unknown, root: string, budget: SkippedWork): Record<string, unknown> {
  if (value === undefined || !nativeHas(value, [root])) return {};
  return { [root]: copyValue(recordOwn(value, root), budget) };
}

/** A served base has no per-path marks for the placeholder. An exact match at the key is ambiguous. */
function mayHideInitialValue(base: Record<string, unknown>, parts: string[], budget: SkippedWork): boolean {
  let value: unknown = base;
  for (const part of parts) {
    value = nativeGet(value, [part]);
    if (value === LOG_PLACEHOLDER) return true;
  }
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    spend(budget, 1);
    if (item === LOG_PLACEHOLDER) return true;
    if (typeof item !== 'object' || item === null) continue;
    for (const name in item) {
      if (Object.hasOwn(item, name)) pending.push(recordOwn(item, name));
    }
  }
  return false;
}

/** Last net state change and admitted write attempts in one log, before an exclusive commit index. */
export function readSkippedKeyHistory(
  log: StoredLog,
  key: string,
  beforeIdx: number,
  budget: SkippedWork,
  fromIdx = 0,
): KeyHistory {
  try {
    const parts = pathSegments(recordName(key, true));
    if (parts.some(isDeniedSegment) || !Number.isSafeInteger(beforeIdx) || beforeIdx < 0)
      return { status: 'unknown', reason: 'invalid-data' };
    const base = log.initialState;
    if (base === undefined || beforeIdx > log.commitLog.length || (log.gaps[0]?.index ?? beforeIdx) < beforeIdx)
      return { status: 'unknown', reason: 'not-collected' };
    const root = parts[0];
    spend(budget, beforeIdx);
    const prefix = log.commitLog.slice(0, beforeIdx);
    for (const [index, bundle] of prefix.entries()) {
      if (bundle.idx !== index) return { status: 'unknown', reason: 'not-collected' };
      const marks = recordOwn(bundle, 'redactedPaths');
      if (marks !== undefined && !Array.isArray(marks)) return { status: 'unknown', reason: 'invalid-data' };
      for (let row = 0; row < (marks?.length ?? 0); row++) {
        const mark = recordName(recordOwn(marks, String(row)), true);
        spend(budget, 1 + mark.length);
        if (relation(mark, key) !== undefined) return { status: 'unknown', reason: 'redacted' };
      }
      for (const row of bundle.trace) {
        const path = recordName(recordOwn(row, 'path'), true);
        spend(budget, path.length + 1);
        if (rootOf(path) === root && pathSegments(path).some(isDeniedSegment))
          return { status: 'unknown', reason: 'invalid-data' };
      }
    }

    const start = rootPatch(base, root, budget);
    if (mayHideInitialValue(start, parts, budget)) return { status: 'unknown', reason: 'conservative' };
    const direct = new Set<number>();
    const bundles = new Map<number, StoredLog['commitLog'][number]>();
    const touches = rowsUnderRoot(prefix, key, beforeIdx - 1).map((touch) => {
      spend(budget, 1);
      const { bundle, commitIdx } = touch;
      if (touch.relation === 'exact' || touch.relation === 'inside') direct.add(commitIdx);
      if (!bundles.has(commitIdx)) {
        bundles.set(commitIdx, {
          ...bundle,
          overwrite: rootPatch(bundle.overwrite, root, budget),
          updates: rootPatch(bundle.updates, root, budget),
        });
      }
      return { ...touch, bundle: bundles.get(commitIdx)! };
    });

    const observed = new Set<string>();
    const seed = log.address.drillPath.at(-1);
    let beforePresent = false;
    let lastChangeIdx: number | undefined;
    foldKey(touches, parts, {
      start: nativeGet(start, [root]),
      startPresent: nativeHas(start, [root]),
      copyValue: (value) => copyValue(value, budget),
      beforeRow: (touch, state) => chargeRow(budget, touch, state, root),
      generations: {
        at(_, state) {
          spend(budget, 1);
          beforePresent = nativeHas(state, parts);
          return true;
        },
        keep(index, before, after, state) {
          spend(budget, 1);
          let changed = beforePresent !== nativeHas(state, parts);
          if (!changed && before !== after) {
            chargeShape(budget, before);
            chargeShape(budget, after);
            changed = !equalWithTextWork(before, after, (units) => spend(budget, units));
          }
          if (changed) lastChangeIdx = index;
          if (index < fromIdx || (!changed && !direct.has(index))) return;
          const runtimeStageId = recordName(recordOwn(prefix[index], 'runtimeStageId'));
          if (runtimeStageId === seed) return;
          const stageId = recordName(recordOwn(prefix[index], 'stageId'));
          const execution = executionIndexOf(runtimeStageId);
          if (
            stageIdOf(runtimeStageId) !== stageId ||
            !Number.isSafeInteger(execution) ||
            execution < 0 ||
            buildRuntimeStageId(stageId, execution) !== runtimeStageId
          )
            throw new RecordRefusal('conservative');
          observed.add(stageId);
        },
      },
    });
    return { status: 'ready', ...(lastChangeIdx !== undefined && { lastChangeIdx }), observed };
  } catch (error) {
    const code = recordRefusalCode(error);
    const reason =
      code === 'node-limit' || code === 'truncated'
        ? 'truncated'
        : code === 'conservative' || error instanceof RangeError
        ? 'conservative'
        : 'invalid-data';
    return { status: 'unknown', reason };
  }
}
