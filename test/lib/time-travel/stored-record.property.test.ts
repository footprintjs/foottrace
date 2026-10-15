/**
 * Property: reading a sink's entries back (1.1.0).
 *
 *   property  (1) a random interleaving of the entries of N logs regroups each log exactly as read alone —
 *             its bundles, notes, completeness and outcome, in its own order; (2) a log read back whole folds
 *             to the live log's state at every index, and keeps it through a JSON round trip; (3) a random
 *             loss of commit entries is a gap at exactly each lost index the log can account for (below the
 *             close's `commits`, or below the last kept commit when it never closed), never a shifted log —
 *             every kept bundle stays at its own index, and the fold before the first gap is the live fold
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { LogAddress, LogOutcome } from '../../../src/index.js';
import { readStoredRecord, stateAt } from '../../../src/index.js';
import type { RecordEntry } from '../../../src/write.js';
import { EventLog, memorySink } from '../../../src/write.js';

interface LogPlan {
  /** One step per entry: a commit setting `k` to the value, or a note. */
  readonly steps: readonly ({ readonly commit: number } | { readonly note: number })[];
  readonly outcome: LogOutcome | undefined;
}

const plan: fc.Arbitrary<LogPlan> = fc.record({
  steps: fc.array(fc.oneof(fc.record({ commit: fc.integer() }), fc.record({ note: fc.integer() })), { maxLength: 8 }),
  outcome: fc.constantFrom<LogOutcome | undefined>('ok', 'failed', 'paused', undefined),
});

/** Write one log through `EventLog` with its own memory sink; the live log and the entries it left. */
function write(address: LogAddress, { steps, outcome }: LogPlan) {
  const sink = memorySink();
  const log = new EventLog({ k: 0 }, { sink, address });
  let n = 0;
  for (const step of steps) {
    if ('note' in step) {
      log.note('tick', { value: step.note });
      continue;
    }
    log.record({
      stage: `s${n}`,
      stageId: `s${n}`,
      runtimeStageId: `s${n}#${n}`,
      trace: [{ path: 'k', verb: 'set' }],
      redactedPaths: [],
      overwrite: { k: step.commit },
      updates: {},
    });
    n++;
  }
  if (outcome !== undefined) log.close(outcome);
  return { log, entries: sink.entries };
}

/** What the reader says about one log — the parts a reader branches on. */
function readout(entries: readonly unknown[], address: LogAddress) {
  const log = readStoredRecord(entries).log(address)!;
  return {
    commitLog: log.commitLog,
    gaps: log.gaps,
    notes: log.notes.map((n) => n.data),
    complete: log.complete,
    outcome: log.outcome,
  };
}

/** Merge lists, keeping each list's own order, by a sequence of picks. */
function interleave<T>(lists: readonly (readonly T[])[], picks: readonly number[]): T[] {
  const cursors = lists.map(() => 0);
  const out: T[] = [];
  let p = 0;
  while (out.length < lists.reduce((sum, l) => sum + l.length, 0)) {
    const open = lists.map((l, i) => i).filter((i) => cursors[i] < lists[i].length);
    const i = open[(picks[p++ % Math.max(1, picks.length)] ?? 0) % open.length];
    out.push(lists[i][cursors[i]++]);
  }
  return out;
}

describe('Property: stored records', () => {
  it('a random interleaving of N logs regroups each log as it reads alone', () => {
    fc.assert(
      fc.property(
        fc.array(plan, { minLength: 1, maxLength: 4 }),
        fc.array(fc.nat(), { maxLength: 40 }),
        (plans, picks) => {
          const addresses: LogAddress[] = plans.map((_, i) =>
            i % 2 === 0 ? { logRunId: `run-${i}`, drillPath: [] } : { logRunId: 'run-0', drillPath: [`m${i}#${i}`] },
          );
          const written = plans.map((p, i) => write(addresses[i], p).entries);
          const mixed = interleave(written, picks);
          const stored = readStoredRecord(mixed);
          expect(stored.unread).toEqual([]);
          expect(stored.logs.size).toBe(plans.length);
          addresses.forEach((address, i) => {
            expect(readout(mixed, address)).toEqual(readout(written[i], address));
            expect(stored.log(address)!.entries).toEqual(written[i]);
          });
        },
      ),
    );
  });

  it('a log read back whole folds to the live state at every index — live and through JSON', () => {
    fc.assert(
      fc.property(plan, (p) => {
        const address: LogAddress = { logRunId: 'run', drillPath: [] };
        const { log, entries } = write(address, p);
        const live = { initialState: log.getInitialState(), commitLog: log.list() };
        for (const stored of [entries, JSON.parse(JSON.stringify(entries)) as unknown[]]) {
          const read = readStoredRecord(stored).log(address)!;
          expect(read.gaps).toEqual([]);
          expect(read.complete).toBe(p.outcome !== undefined);
          expect(read.outcome).toBe(p.outcome);
          for (let i = -1; i < log.length; i++) expect(stateAt(read.source(), i)).toEqual(stateAt(live, i));
        }
      }),
    );
  });

  it('a random loss of commit entries is a gap at each lost index the log accounts for — never a shift', () => {
    fc.assert(
      fc.property(plan, fc.array(fc.boolean(), { maxLength: 8 }), (p, drops) => {
        const address: LogAddress = { logRunId: 'run', drillPath: [] };
        const { log, entries } = write(address, p);
        const lost = new Set<number>();
        const kept = entries.filter((e: RecordEntry) => {
          if (e.kind !== 'commit' || !drops[e.bundle.idx!]) return true;
          lost.add(e.bundle.idx!);
          return false;
        });
        const read = readStoredRecord(kept).log(address)!;
        const keptIdx = kept.flatMap((e) => (e.kind === 'commit' ? [e.bundle.idx!] : []));
        // A close says how long the log was; without one, the last kept commit is as far as the store can see.
        const accountable = p.outcome !== undefined ? log.length : Math.max(-1, ...keptIdx) + 1;
        const expected = [...lost].filter((i) => i < accountable).sort((a, b) => a - b);
        expect(read.gaps.map((g) => g.index)).toEqual(expected);
        expect(read.commitLog).toHaveLength(accountable);
        for (const i of keptIdx) expect(read.commitLog[i]).toBe(log.recorded()[i]);
        const firstGap = expected.length > 0 ? expected[0] : accountable;
        const live = { initialState: log.getInitialState(), commitLog: log.list() };
        for (let i = -1; i < firstGap; i++) expect(stateAt(read.source(), i).state).toEqual(stateAt(live, i).state);
        if (expected.length > 0) expect(stateAt(read.source(), accountable - 1).skipped).toEqual(read.gaps);
      }),
    );
  });
});
