/**
 * Property tests — the walk back names the real source of every read, however steps interleave.
 *
 * THE JUDGE IS THE VALUE. Every write in these runs stores a token that names its writer
 * (`s2:1` = step 2's second write; `init:a` = there before the run). A step that reads a key gets a
 * token back, and that token says, with no reference to any index or to the code under test, whose
 * write it read. The walk back is right when that writer is among the parents it lists for the key.
 *
 *   SOUND     for any number of steps, at the root address or in their own namespace, with reads
 *             (through every read door of the frame), writes and commits interleaved in any order on
 *             the REAL writer (`SharedMemory`, `EventLog`, `RecordFrame`): for every read, the writer
 *             the value names is a parent through that key, or the key is listed as read from before
 *             the run when the value was there before any write (or absent).
 *   EXACT     a step that never looked at state again after another step committed (its bundle
 *             carries no `sawUntil`) has, for each key, exactly the real writer as parent and no
 *             mark, however many steps committed before it did. Steps one after another lose
 *             nothing, and neither do steps side by side that only read what they saw when they began.
 *   BOUNDED   a mark says what it means: a parent marked `written-while-running` committed inside
 *             the reader's window; one marked `replaced-while-running` committed before it and shares
 *             its key with a parent written inside it; an unmarked parent's key was not written there.
 *   FORWARD   the same judge, the other way: the step that read a value is listed among the readers of
 *             the write the value names (or of the value from before the run).
 *   NEEDED    the property is not vacuous, three times: with both stamps ignored (the walk as it was
 *             before) SOUND fails, and it fails with either one ignored alone. Each counterexample is a
 *             read whose real writer the walk would leave out.
 *   HANDED OVER  the same judge on what a reader is really given: the log with any of its bundles
 *             taken out, and any of the rest not saying its index. For every read whose real writer
 *             is still in the array, that writer is among the parents listed for the key, and a
 *             parent with no mark is the only one its key has. So a hole never turns a writer the
 *             step did not see into its one certain source. ONE CONDITION, said in
 *             `windowPlacement.ts` (NOT COVERED): the last bundle of the array says its index, so
 *             every hole among silent bundles is shown by a said index after it.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { causalChain, forwardSliceForKey } from '../../../../src';
import type { CausalNode, CommitBundle } from '../../../../src';
import { EventLog, RecordFrame, SharedMemory } from '../../../../src/write';

const KEYS = ['a', 'b', 'c'] as const;
/** `c` is absent before the run, so a read of it can come back undefined. */
const SEED = { a: 'init:a', b: 'init:b' };
/** The frame's read doors: its own view (live for a key the view cannot answer), and the two live doors. */
const READS = ['read', 'readLive', 'readGlobal'] as const;

interface Op {
  kind: (typeof READS)[number] | 'write';
  key: (typeof KEYS)[number];
}
interface Step {
  namespaced: boolean;
  ops: Op[];
}
interface Read {
  key: string;
  /** The token the read returned: `sN:M`, `init:key`, or undefined for an absent key. */
  token: string | undefined;
}

const step = fc.record({
  namespaced: fc.boolean(),
  ops: fc.array(
    fc.record({
      // `read` and `write` are the common acts; the two live doors are rarer.
      kind: fc.constantFrom('read' as const, 'read' as const, 'write' as const, 'write' as const, ...READS),
      key: fc.constantFrom(...KEYS),
    }),
    { maxLength: 6 },
  ),
});
const program = fc.record({
  steps: fc.array(step, { minLength: 2, maxLength: 6 }),
  /** Which step moves next. A step with no op left commits; a committed step is skipped. */
  schedule: fc.array(fc.nat({ max: 5 }), { maxLength: 60 }),
});

/** Run the program on the real writer. Returns the log and, per step, what each of its reads returned. */
function run({ steps, schedule }: { steps: Step[]; schedule: number[] }) {
  const state = new SharedMemory(undefined, { ...SEED });
  const log = new EventLog({ ...SEED });
  const frames = steps.map((s, i) => new RecordFrame(state, log, s.namespaced ? ['runs', `s${i}`] : []));
  const next = steps.map(() => 0);
  const writes = steps.map(() => 0);
  const committed = steps.map(() => false);
  const observed: Read[][] = steps.map(() => []);

  const move = (i: number): void => {
    if (committed[i]) return;
    const op = steps[i].ops[next[i]++];
    if (op === undefined) {
      frames[i].commit(() => ({ stage: `s${i}`, stageId: `s${i}`, runtimeStageId: `s${i}#0` }));
      frames[i].release();
      committed[i] = true;
      return;
    }
    if (op.kind === 'write') {
      // A ROOT key from any frame, as a subflow's output mapping writes: siblings see it once committed.
      frames[i].write([op.key], `s${i}:${writes[i]++}`, 'set');
      return;
    }
    const value = op.kind === 'read' ? frames[i].read([], op.key) : frames[i][op.kind](op.key);
    observed[i].push({ key: op.key, token: value as string | undefined });
  };
  for (const pick of schedule) move(pick % steps.length);
  // Let every step finish, in order, so every read has a commit to be dated by.
  for (let i = 0; i < steps.length; i++) while (!committed[i]) move(i);
  return { log: log.list(), observed };
}

const readsOf = (observed: Read[][]) => (runtimeStageId: string) => {
  const i = Number(runtimeStageId.slice(1, runtimeStageId.indexOf('#')));
  return [...new Set((observed[i] ?? []).map((read) => read.key))];
};
const writerOf = (token: string) => `${token.slice(0, token.indexOf(':'))}#0`;
const fromBeforeTheRun = (token: string | undefined) => token === undefined || token.startsWith('init:');
const parentsVia = (node: CausalNode, key: string) =>
  node.parentEdges.filter((edge) => edge.kind === 'data' && edge.key === key);
const without = (log: CommitBundle[], ...stamps: ('beganAt' | 'sawUntil')[]) =>
  log.map((bundle) => {
    const copy = { ...bundle };
    for (const stamp of stamps) delete copy[stamp];
    return copy;
  });

/** The first read whose real writer the walk does not name, or undefined when every read is accounted for. */
function firstUnexplained(log: CommitBundle[], observed: Read[][]): string | undefined {
  for (let i = 0; i < observed.length; i++) {
    const id = `s${i}#0`;
    const node = causalChain(log, id, readsOf(observed))!;
    for (const { key, token } of observed[i]) {
      if (fromBeforeTheRun(token)) {
        if (!node.preRunReads?.keys.includes(key))
          return `${id} read ${key} = ${token}: not listed as from before the run`;
      } else if (writerOf(token!) !== id) {
        if (!parentsVia(node, key).some((edge) => edge.parent.runtimeStageId === writerOf(token!)))
          return `${id} read ${key} = ${token}: ${writerOf(token!)} is not a parent through ${key}`;
      }
    }
  }
  return undefined;
}

/**
 * More steps on fewer keys than `program`: HANDED OVER needs a step that read a key, a sibling that
 * wrote the same key while it ran, and other commits around them to take out.
 */
const crowded = fc.record({
  steps: fc.array(
    fc.record({
      namespaced: fc.boolean(),
      ops: fc.array(
        fc.record({
          kind: fc.constantFrom('read' as const, 'read' as const, 'write' as const, 'write' as const, ...READS),
          key: fc.constantFrom('a' as const, 'a' as const, 'a' as const, 'b' as const),
        }),
        { maxLength: 3 },
      ),
    }),
    { minLength: 4, maxLength: 7 },
  ),
  schedule: fc.array(fc.nat({ max: 6 }), { maxLength: 40 }),
});

/**
 * What a reader is handed: `log` without the bundles `drop` picks, and with `idx` taken off the ones
 * `mute` picks. The last bundle left keeps its index (the one condition of HANDED OVER).
 */
function handedOver(log: CommitBundle[], drop: boolean[], mute: boolean[]): CommitBundle[] {
  const kept = log.filter((_, at) => !drop[at % drop.length]);
  return kept.map((bundle, at) => {
    if (at === kept.length - 1 || !mute[at % mute.length]) return bundle;
    const { idx: _idx, ...silent } = bundle;
    return silent as CommitBundle;
  });
}

describe('the walk back and interleaved steps', () => {
  it('SOUND: the writer a read value names is always among the parents listed for that key', () => {
    fc.assert(
      fc.property(program, (p) => {
        const { log, observed } = run(p);
        expect(firstUnexplained(log, observed)).toBeUndefined();
      }),
      { numRuns: 3000 },
    );
  });

  it('EXACT: a step that never looked again has exactly the real writer as parent, unmarked', () => {
    let sideBySide = 0;
    fc.assert(
      fc.property(program, (p) => {
        const { log, observed } = run(p);
        for (let i = 0; i < observed.length; i++) {
          const id = `s${i}#0`;
          const bundle = log.find((b) => b.runtimeStageId === id)!;
          if (bundle.sawUntil !== undefined) continue;
          if (bundle.beganAt !== undefined) sideBySide++;
          const node = causalChain(log, id, readsOf(observed))!;
          for (const key of new Set(observed[i].map((read) => read.key))) {
            // Every look was at the same moment, so every read of the key that was not of the step's own
            // write saw one value.
            const tokens = new Set(
              observed[i]
                .filter((read) => read.key === key && read.token?.startsWith(`s${i}:`) !== true)
                .map((read) => read.token),
            );
            if (tokens.size === 0) continue; // it only ever read its own write of this key
            expect(tokens.size, `${id} ${key}`).toBe(1);
            const [token] = tokens;
            const edges = parentsVia(node, key);
            expect(edges.every((edge) => edge.overlap === undefined)).toBe(true);
            if (fromBeforeTheRun(token)) expect(edges).toEqual([]);
            else expect(edges.map((edge) => edge.parent.runtimeStageId)).toEqual([writerOf(token!)]);
          }
        }
      }),
      { numRuns: 2000, seed: 20261111 },
    );
    // The case this property exists for was generated: steps side by side that still answer exactly.
    expect(sideBySide).toBeGreaterThan(100);
  });

  it('BOUNDED: a mark says what it means, and an unmarked parent is the only one its key has', () => {
    let marked = 0;
    fc.assert(
      fc.property(program, (p) => {
        const { log, observed } = run(p);
        const at = new Map(log.map((bundle, i) => [bundle.runtimeStageId, i]));
        for (let i = 0; i < observed.length; i++) {
          const id = `s${i}#0`;
          const own = log[at.get(id)!];
          const node = causalChain(log, id, readsOf(observed))!;
          const from = own.beganAt ?? own.idx!;
          const until = own.sawUntil ?? from;
          for (const edge of node.parentEdges) {
            const parent = at.get(edge.parent.runtimeStageId)!;
            const sameKey = parentsVia(node, edge.key!);
            if (edge.overlap === 'written-while-running') {
              marked++;
              expect(parent).toBeGreaterThanOrEqual(from);
              expect(parent).toBeLessThan(until);
            } else if (edge.overlap === 'replaced-while-running') {
              expect(parent).toBeLessThan(from);
              expect(sameKey.some((other) => other.overlap === 'written-while-running')).toBe(true);
            } else {
              expect(parent).toBeLessThan(from);
              expect(sameKey).toHaveLength(1);
            }
          }
        }
      }),
      { numRuns: 1500, seed: 20261111 },
    );
    expect(marked).toBeGreaterThan(50);
  });

  it('FORWARD: a step that read a value is listed as a reader of the write that value names', () => {
    fc.assert(
      fc.property(program, (p) => {
        const { log, observed } = run(p);
        const at = new Map(log.map((bundle, i) => [bundle.runtimeStageId, i]));
        for (let i = 0; i < observed.length; i++) {
          const id = `s${i}#0`;
          for (const { key, token } of observed[i]) {
            if (token?.startsWith(`s${i}:`)) continue; // its own write, read back
            // Anchor at the write the value names: the life that starts there (or before the run).
            const before = fromBeforeTheRun(token) ? 0 : at.get(writerOf(token!))! + 1;
            const slice = forwardSliceForKey(log, key, readsOf(observed), { before });
            expect(
              slice.root?.reads.some((read) => read.runtimeStageId === id),
              `${id} read ${key} = ${token}`,
            ).toBe(true);
          }
        }
      }),
      { numRuns: 1500 },
    );
  });

  it('HANDED OVER: with bundles taken out and indices not said, the real writer is named and never outvoted by a certain one', () => {
    let judged = 0;
    let openedByAHole = 0;
    fc.assert(
      fc.property(
        crowded,
        fc.array(fc.boolean(), { minLength: 1, maxLength: 7 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 7 }),
        (p, drop, mute) => {
          const { log, observed } = run(p);
          const handed = handedOver(log, drop, mute);
          const present = new Set(handed.map((bundle) => bundle.runtimeStageId));
          for (let i = 0; i < observed.length; i++) {
            const id = `s${i}#0`;
            if (!present.has(id)) continue;
            const own = handed.find((bundle) => bundle.runtimeStageId === id)!;
            const node = causalChain(handed, id, readsOf(observed))!;
            for (const { key, token } of observed[i]) {
              const edges = parentsVia(node, key);
              // A parent with no mark is certain: then it is the only one.
              if (edges.some((edge) => edge.overlap === undefined)) expect(edges, `${id} ${key}`).toHaveLength(1);
              if (own.sawUntil === undefined && edges.some((edge) => edge.overlap !== undefined)) openedByAHole++;
              if (fromBeforeTheRun(token) || writerOf(token!) === id) continue;
              if (!present.has(writerOf(token!))) continue; // its bundle was taken out: nobody can name it
              judged++;
              expect(
                edges.some((edge) => edge.parent.runtimeStageId === writerOf(token!)),
                `${id} read ${key} = ${token}: ${writerOf(token!)} is not a parent through ${key}`,
              ).toBe(true);
            }
          }
        },
      ),
      { numRuns: 4000, seed: 20261111 },
    );
    expect(judged).toBeGreaterThan(1000);
    // The case this property exists for was generated: a step that never looked again, whose answer is
    // "possible" only because a bundle that says no index could sit on either side of where it began.
    // (With a silent bundle read as ONE number, next to its neighbour, this property fails: at this seed
    // after 1,549 programs, on a read whose real writer was left out for a sibling the step never saw.)
    expect(openedByAHole).toBeGreaterThan(10);
  });

  it.each([
    ['both stamps', ['beganAt', 'sawUntil'] as const],
    ['sawUntil alone', ['sawUntil'] as const],
    ['beganAt alone', ['beganAt'] as const],
  ])('NEEDED: with %s ignored, a read is found whose real writer the walk does not name', (_name, stamps) => {
    let found: string | undefined;
    fc.assert(
      fc.property(program, (p) => {
        const { log, observed } = run(p);
        found ??= firstUnexplained(without(log, ...stamps), observed);
      }),
      { numRuns: 1500, seed: 20261111 },
    );
    expect(found).toMatch(/is not a parent through|not listed as from before the run/);
  });
});
