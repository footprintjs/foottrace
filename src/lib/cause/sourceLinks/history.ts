import { rowsUnderRoot } from '../../memory/commitLogUtils.js';
import { nativeGet, nativeHas } from '../../memory/pathOps.js';
import type { CommitBundle } from '../../memory/types.js';
import { foldKey, isTotal, recordsTail } from '../../memory/verbs.js';
import { pathSegments } from '../../record-paths/codec.js';
import { copyRecordValue, spend } from '../recordValidation.js';
import { chargeRow, chargeShape } from './foldBudget.js';
import { historyLookup, historyValue, type Transition } from './historyValue.js';
import { directHistory } from './listHistory.js';

/**
 * Count the contiguous prefix whose state can be replayed from the admitted base.
 * A bundle without an index cannot establish where an externally supplied slice starts.
 */
export function accountedCount(log: readonly CommitBundle[], base: object | undefined): number {
  if (base === undefined) return 0;
  let count = 0;
  while (log[count]?.idx === count) count++;
  return count;
}

export function keyHistory(
  log: readonly CommitBundle[],
  base: Record<string, unknown>,
  key: string,
  stop: number,
  budget: { left: number },
) {
  const segments = pathSegments(key);
  const root = segments[0];
  const start = nativeGet(base, [root]);
  const initial = historyValue(nativeHas(base, segments), nativeGet(base, segments));
  const touches = rowsUnderRoot(log, key, stop);
  spend(budget, touches.length);
  chargeShape(budget, start);
  if (touches.every((touch) => touch.path === key && (isTotal(touch.verb) || recordsTail(touch.verb)))) {
    return directHistory(touches, segments, initial, budget);
  }

  let beforePresent = false;
  const states = new Map<number, Transition>();
  const commits: number[] = [];
  foldKey(touches, segments, {
    copyValue: copyRecordValue,
    start,
    startPresent: nativeHas(base, [root]),
    beforeRow: (touch, state) => chargeRow(budget, touch, state, root),
    generations: {
      at(_, state) {
        beforePresent = nativeHas(state, segments);
        return true;
      },
      keep(index, before, after, state) {
        spend(budget, 3);
        commits.push(index);
        states.set(index, {
          before: historyValue(beforePresent, before),
          after: historyValue(nativeHas(state, segments), after),
        });
      },
    },
  });
  return historyLookup(commits, states, initial);
}

export type KeyHistory = ReturnType<typeof keyHistory>;

/**
 * A row belongs to this commit when the commit wrote its key and the
 * accounted list ended before its position. Compare lengths; no earlier
 * element is part of the row's proof.
 */
export function appendedStart(bundle: CommitBundle, key: string, change: Transition | undefined): number | undefined {
  if (!change?.after.list || !bundle.trace.some((row) => row.path === key)) return undefined;
  if (!change.before.present) return 0;
  if (!change.before.list || change.before.list.length >= change.after.list.length) return undefined;
  return change.before.list.length;
}
