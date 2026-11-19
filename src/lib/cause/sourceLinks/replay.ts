import { deepEqual } from '../../memory/equality.js';
import { relation } from '../../memory/keyPaths.js';
import { isDeniedSegment, nativeGet } from '../../memory/pathOps.js';
import type { CommitBundle } from '../../memory/types.js';
import { windowsOf } from '../../memory/windowPlacement.js';
import { normalisePath, pathSegments } from '../../record-paths/codec.js';
import { spend } from '../recordValidation.js';
import { accountedCount, appendedStart, keyHistory, type KeyHistory } from './history.js';
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

interface SelectedValue {
  readonly found: boolean;
  readonly value: unknown;
}
const absent: SelectedValue = { found: false, value: undefined };

/** RFC 6901 list tokens use canonical indices, independently of own array properties. */
function selected(value: unknown, path: readonly string[]): SelectedValue {
  let current = value;
  for (const part of path) {
    if (typeof current !== 'object' || current === null) return absent;
    if (Array.isArray(current) && !/^(0|[1-9][0-9]*)$/u.test(part)) return absent;
    if (!Object.hasOwn(current, part)) return absent;
    current = nativeGet(current, [part]);
  }
  return { found: true, value: current };
}

export function resolves(value: unknown, place: SourceLinkSelection & Pick<SourceLinkOutput, 'span'>): boolean {
  const parts = selectedParts(place);
  if (!parts || (place.element !== undefined && !Array.isArray(value))) return false;
  const result = selected(value, parts);
  return (
    result.found &&
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
  let foldCost = 1;
  log.forEach((bundle, index) => {
    if (!firstByOwner.has(bundle.runtimeStageId)) firstByOwner.set(bundle.runtimeStageId, index);
    spend(budget, bundle.trace.length);
    const known = reads.get(bundle.runtimeStageId) ?? new Set(record.reads?.get(bundle.runtimeStageId));
    for (const row of bundle.trace) {
      foldCost += row.path.length + 1;
      for (const key of row.readKeys ?? []) known.add(key);
    }
    reads.set(bundle.runtimeStageId, known);
  });

  function history(key: string): KeyHistory | undefined {
    if (!base) return undefined;
    let value = histories.get(key);
    if (value === undefined) {
      spend(budget, foldCost);
      value = keyHistory(log, base, key, accounted - 1);
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
        const change = timeline.transition(index)!;
        const before = parts.length
          ? selected(change.before, parts)
          : { found: change.beforePresent, value: change.before };
        const after = parts.length
          ? selected(change.after, parts)
          : { found: change.afterPresent, value: change.after };
        if (direct || before.found !== after.found || !deepEqual(before.value, after.value, 'copies'))
          visits.push(index);
      }
    }
    writers.set(identity, visits);
    return visits;
  }

  function writer(place: SourceLinkSelection, before: number): number | undefined {
    if (before > accounted) return undefined;
    const positions = writePositions(place);
    let low = 0;
    let high = positions.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (positions[middle] < before) low = middle + 1;
      else high = middle;
    }
    return positions[low - 1];
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
    value: (key: string, index: number) => history(key)?.at(index).value,
    exists: (key: string, index: number) => history(key)?.at(index).present === true,
    appended,
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
