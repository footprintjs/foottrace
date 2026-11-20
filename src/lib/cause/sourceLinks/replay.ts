import { deepEqual } from '../../memory/equality.js';
import { lastBefore, relation, rootOf } from '../../memory/keyPaths.js';
import { isDeniedSegment, nativeGet, ownChild } from '../../memory/pathOps.js';
import type { CommitBundle } from '../../memory/types.js';
import { windowsOf } from '../../memory/windowPlacement.js';
import { normalisePath, pathSegments } from '../../record-paths/codec.js';
import { spend } from '../recordValidation.js';
import { accountedCount, appendedStart, keyHistory, type KeyHistory } from './history.js';
import { chargeShape } from './foldBudget.js';
import { historyValue, type HistoryValue } from './historyValue.js';
import { pointerParts } from './selectors.js';
import type { SourceLinkOutput, SourceLinkSelection } from './types.js';

export interface ReplayRecord {
  readonly log: readonly CommitBundle[];
  readonly base?: Record<string, unknown>;
  readonly reads?: ReadonlyMap<string, readonly string[]>;
}

function selectedParts(place: SourceLinkSelection): string[] | undefined {
  const parts = place.element === undefined ? [] : [String(place.element)];
  const tail = place.pointer === undefined ? [] : pointerParts(place.pointer);
  if (tail.some((part) => isDeniedSegment(part) || pathSegments(part).length !== 1)) return undefined;
  return [...parts, ...tail];
}

const arrayIndex = /^(0|[1-9][0-9]*)$/u;

/** RFC 6901 list tokens use canonical indices, independently of own array properties. */
function selected(value: HistoryValue, path: readonly string[]): HistoryValue {
  let current = value;
  for (const part of path) {
    if (current.list) {
      if (!arrayIndex.test(part)) return historyValue(false, undefined);
      current = current.list.element(Number(part));
    } else {
      const parent = current.value;
      if (typeof parent !== 'object' || parent === null || !Object.hasOwn(parent, part))
        return historyValue(false, undefined);
      current = historyValue(true, nativeGet(parent, [part]));
    }
  }
  return current;
}

function resolves(at: HistoryValue, place: SourceLinkSelection & Pick<SourceLinkOutput, 'span'>): boolean {
  const parts = selectedParts(place);
  if (!parts || (place.element !== undefined && !at.list)) return false;
  const result = selected(at, parts);
  return (
    result.present &&
    (place.span === undefined || (typeof result.value === 'string' && place.span[1] <= result.value.length))
  );
}

/** Index one admitted log and reuse its based folds across every link in this projection. */
export function sourceLinkReplay(record: ReplayRecord, budget: { left: number }) {
  const { log, base } = record;
  const accounted = accountedCount(log, base);
  const window = windowsOf(log);
  const firstByOwner = new Map<string, number>();
  const reads = new Map<string, Set<string>>();
  const histories = new Map<string, KeyHistory>();
  const writers = new Map<string, readonly number[]>();
  const scopedRedactions = new Map<string, number>();
  const suffixes = new Map<string, Map<number, number | undefined>>();
  spend(budget, log.length);
  const costPerTraceRow = 4;
  let indexCost = 1;
  const rootCosts = new Map<string, number>();
  const mergesByRoot = new Map<string, { index: number; path: string }[]>();
  log.forEach((bundle, index) => {
    if (!firstByOwner.has(bundle.runtimeStageId)) firstByOwner.set(bundle.runtimeStageId, index);
    spend(budget, bundle.trace.length);
    const known = reads.get(bundle.runtimeStageId) ?? new Set(record.reads?.get(bundle.runtimeStageId));
    for (const row of bundle.trace) {
      indexCost += costPerTraceRow;
      const root = rootOf(row.path);
      rootCosts.set(root, (rootCosts.get(root) ?? 0) + costPerTraceRow);
      if (row.verb === 'merge') {
        const merges = mergesByRoot.get(root);
        const merge = { index, path: row.path };
        if (merges) merges.push(merge);
        else mergesByRoot.set(root, [merge]);
      }
      for (const key of row.readKeys ?? []) known.add(key);
    }
    reads.set(bundle.runtimeStageId, known);
  });

  spend(budget, indexCost);

  function history(key: string): KeyHistory | undefined {
    if (!base) return undefined;
    let value = histories.get(key);
    if (value === undefined) {
      spend(budget, 1 + (rootCosts.get(rootOf(key)) ?? 0));
      value = keyHistory(log, base, key, accounted - 1, budget);
      histories.set(key, value);
    }
    return value;
  }

  function appended(key: string, index: number): number | undefined {
    if (index < 0 || index >= accounted) return undefined;
    const atKey = suffixes.get(key) ?? new Map();
    if (!atKey.has(index)) {
      const transition = history(key)?.transition(index);
      spend(budget, log[index].trace.length);
      atKey.set(index, appendedStart(log[index], key, transition));
      suffixes.set(key, atKey);
    }
    return atKey.get(index);
  }

  function selectedWrite(place: SourceLinkSelection, index: number): boolean {
    return writer(place, index + 1) === index;
  }

  function writePositions(place: SourceLinkSelection): readonly number[] {
    const identity = JSON.stringify([place.key, place.element, place.pointer]);
    const existing = writers.get(identity);
    if (existing) return existing;
    const parts = selectedParts(place);
    const path = parts && normalisePath([...pathSegments(place.key), ...parts]);
    const timeline = path === undefined ? undefined : history(place.key);
    const visits: number[] = [];
    if (parts && path !== undefined && timeline) {
      for (const index of timeline.commits) {
        const rows = log[index].trace;
        spend(budget, rows.length + 1);
        const direct = rows.some((row) => {
          const relative = relation(row.path, path);
          return relative === 'exact' || relative === 'inside';
        });
        if (direct) {
          visits.push(index);
          continue;
        }
        const change = timeline.transition(index)!;
        const before = selected(change.before, parts);
        const after = selected(change.after, parts);
        if (before.present && after.present && before.value !== after.value) {
          chargeShape(budget, before.value);
          chargeShape(budget, after.value);
        }
        if (before.present !== after.present || !deepEqual(before.value, after.value, 'copies')) visits.push(index);
      }
    }
    writers.set(identity, visits);
    return visits;
  }

  function writer(place: SourceLinkSelection, before: number): number | undefined {
    if (before > accounted) return undefined;
    const index = lastBefore(writePositions(place), before);
    return index < 0 ? undefined : index;
  }

  /** An array union can shift a position based on members outside that position's grant. */
  function unionTouchesPosition(place: SourceLinkSelection, through: number): boolean {
    const merges = mergesByRoot.get(rootOf(place.key));
    const selectors = selectedParts(place);
    if (!merges || !selectors) return false;
    const parts = [...pathSegments(place.key), ...selectors];
    if (!parts.slice(1).some((part) => arrayIndex.test(part))) return false;
    const path = normalisePath(parts);
    for (const merge of merges) {
      if (merge.index > through || merge.index >= accounted) break;
      spend(budget, 1);
      if (relation(merge.path, path) !== 'around') continue;
      const rowParts = pathSegments(merge.path);
      spend(budget, parts.length);
      let operand: unknown = nativeGet(log[merge.index].updates, rowParts);
      for (const part of parts.slice(rowParts.length)) {
        // Stop at the first array. Its shape settles the question without reading any entry.
        if (Array.isArray(operand)) {
          if (arrayIndex.test(part)) return true;
          break;
        }
        operand = ownChild(operand, part);
      }
    }
    return false;
  }

  function redacted(place: SourceLinkSelection, through: number): boolean {
    const parts = selectedParts(place);
    if (!parts) return true;
    const path = normalisePath([...pathSegments(place.key), ...parts]);
    let first = scopedRedactions.get(path);
    if (first === undefined) {
      first = Number.POSITIVE_INFINITY;
      for (let index = 0; index < log.length; index++) {
        spend(budget, 1 + log[index].redactedPaths.length);
        if (log[index].redactedPaths.some((mark) => relation(mark, path))) {
          first = index;
          break;
        }
      }
      scopedRedactions.set(path, first);
    }
    return first <= through;
  }

  return {
    accounted,
    log,
    window,
    first: (owner: string) => firstByOwner.get(owner),
    read: (owner: string, key: string) => reads.get(owner)?.has(key) === true,
    resolves(place: SourceLinkSelection & Pick<SourceLinkOutput, 'span'>, index: number): boolean {
      const at = history(place.key)?.at(index);
      return at !== undefined && resolves(at, place);
    },
    list: (key: string, index: number) => history(key)?.at(index).list,
    appended,
    unionTouchesPosition,
    selectedWrite,
    writtenBetween(place: SourceLinkSelection, start: number, end: number): boolean {
      return (writer(place, end) ?? -1) >= start;
    },
    spend: (amount: number) => spend(budget, amount),
    writer,
    redacted,
  };
}

export type SourceLinkReplay = ReturnType<typeof sourceLinkReplay>;
