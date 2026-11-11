/**
 * Property tests — the walk back names every step whose write is still IN a value, however the value
 * was built.
 *
 * THE JUDGE IS THE VALUE. Every key here holds an object, and every write adds one field whose NAME
 * says who wrote it (`s2:1` = step 2's second write; `init:a` = there before the run). A write
 * either replaces the object (`set`, `delete`) or adds to it (`merge`, or a `set` of a path inside
 * the key). A step that reads a key gets the object back, and its field names say, with no
 * reference to any index, verb or code under test, whose writes the value is made of. The walk back
 * is right when every one of those steps is reached from the reader through that key.
 *
 *   SOUND     for any number of steps with reads, writes of every kind and commits interleaved in
 *             any order on the REAL writer (`SharedMemory`, `EventLog`, `RecordFrame`): every step
 *             named by a field of a value a step read is on the walk back from that step through
 *             that key (the read's edge, then the edges of the key from each step on the way). A
 *             field from before the run ends the walk at a node that says so.
 *   EXACT     for a read with one certain source, where no step on the way also read the key: the
 *             steps on that walk are exactly the steps the value names. No step too many.
 *   FORWARD   the same judge, the other way: the reader is among the readers of the life of every
 *             write the value names.
 *   NEEDED    the property is not vacuous: with the `builtOn` edges ignored (the walk as it was)
 *             SOUND fails, and the counterexample is a step whose write is in the value read.
 *
 * The three clauses run under `commitValues: 'full'`, the default. NOT COVERED, and pinned as a
 * `KNOWN LIMIT` at the end of this file: a `set` row that the WRITER made out of writes that only
 * added to a value (the `'delta'` encoding does it for a step that merged into a key and also wrote
 * a path inside it). Such a row says `set`, and nothing in it says that the value was built on what
 * was there. A reader cannot follow what the record does not say; the writer has to say it.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { causalChain, forwardSliceForKey } from '../../../../src';
import type { CausalEdge, CausalNode, CommitBundle } from '../../../../src';
import { EventLog, RecordFrame, SharedMemory } from '../../../../src/write';

const KEYS = ['a', 'b'] as const;
/** `b` is absent before the run. */
const SEED = { a: { 'init:a': 1 } };
type Key = (typeof KEYS)[number];
type Kind = 'read' | 'set' | 'merge' | 'inside' | 'delete';
type Encoding = 'full' | 'delta';

interface Op {
  kind: Kind;
  key: Key;
}
interface Read {
  key: Key;
  /** The field names of the object the read returned: who the value is made of. */
  tokens: string[];
  /** Did the step write this key itself before this read? Then the value is partly its own. */
  afterOwnWrite: boolean;
}

const op = (kinds: readonly Kind[]) =>
  fc.record({ kind: fc.constantFrom(...kinds), key: fc.constantFrom(...KEYS, 'a' as const) });
const programOf = (kinds: readonly Kind[], encoding: Encoding = 'full') =>
  fc.record({
    steps: fc.array(fc.array(op(kinds), { maxLength: 5 }), { minLength: 2, maxLength: 6 }),
    /** Which step moves next. A step with no op left commits; a committed step is skipped. */
    schedule: fc.array(fc.nat({ max: 5 }), { maxLength: 50 }),
    encoding: fc.constant(encoding),
  });
/** Adding is the common act: a value built in steps is what is under test. */
const ALL: readonly Kind[] = ['read', 'read', 'merge', 'merge', 'inside', 'set', 'delete'];
const program = programOf(ALL);
/**
 * Without `delete`, for EXACT: the judge reads who a value is MADE OF from its fields, and a value
 * that is gone has none, though the step that removed it is rightly on the walk. Fewer reads, so
 * that more steps only add to a value (a step that also reads the key is left out of EXACT).
 */
const building = programOf(['read', 'merge', 'merge', 'merge', 'inside', 'inside', 'set']);

/** Run the program on the real writer. Returns the log and, per step, what each of its reads returned. */
function run({ steps, schedule, encoding }: { steps: Op[][]; schedule: number[]; encoding: Encoding }) {
  const state = new SharedMemory(undefined, structuredClone(SEED));
  const log = new EventLog(structuredClone(SEED));
  const name = (i: number) => `s${i}`;
  const frames = steps.map(() => {
    const frame = new RecordFrame(state, log);
    frame.useEncoding({ commitValues: encoding, writeProvenance: 'off' });
    return frame;
  });
  const next = steps.map(() => 0);
  const writes = steps.map(() => 0);
  const wrote = steps.map(() => new Set<Key>());
  const committed = steps.map(() => false);
  const observed: Read[][] = steps.map(() => []);

  const move = (i: number): void => {
    if (committed[i]) return;
    const act = steps[i][next[i]++];
    if (act === undefined) {
      frames[i].commit(() => ({ stage: name(i), stageId: name(i), runtimeStageId: `${name(i)}#0` }));
      frames[i].release();
      committed[i] = true;
      return;
    }
    const { kind, key } = act;
    if (kind === 'read') {
      const value = frames[i].read([], key);
      const tokens = value !== null && typeof value === 'object' ? Object.keys(value as object) : [];
      observed[i].push({ key, tokens, afterOwnWrite: wrote[i].has(key) });
      return;
    }
    const token = `${name(i)}:${writes[i]++}`;
    wrote[i].add(key);
    if (kind === 'set') frames[i].write([key], { [token]: 1 }, 'set');
    else if (kind === 'merge') frames[i].write([key], { [token]: 1 }, 'merge');
    else if (kind === 'inside') frames[i].write([key, token], 1, 'set');
    else frames[i].write([key], undefined, 'delete');
  };
  for (const pick of schedule) move(pick % steps.length);
  // Let every step finish, in order, so every read has a commit to be dated by.
  for (let i = 0; i < steps.length; i++) while (!committed[i]) move(i);
  return { log: log.list(), observed, state: state.getState() as Record<string, unknown> };
}

const readsOf = (observed: Read[][]) => (runtimeStageId: string) => {
  const i = Number(runtimeStageId.slice(1, runtimeStageId.indexOf('#')));
  return [...new Set((observed[i] ?? []).map((read) => read.key))];
};
const writerOf = (token: string) => `${token.slice(0, token.indexOf(':'))}#0`;
const fromBeforeTheRun = (token: string) => token.startsWith('init:');
const dataEdges = (node: CausalNode, key: string): CausalEdge[] =>
  node.parentEdges.filter((edge) => edge.kind === 'data' && edge.key === key);

/**
 * The walk back from `root` through `key`: the parents its read of the key names, then, from each
 * step on the way, that step's edges of the key. (A step that merged into the key and also read it
 * has ONE edge to the step before, the read's: `linkParent`.) `preRun`: the walk ends at the value
 * from before the run (a step on the way read it from there, or its write was folded onto it).
 * `builtOn` false: the walk as it was before, which had no edge from a write to the write under it.
 */
function through(root: CausalNode, key: string, builtOn = true): { steps: Set<string>; preRun: boolean } {
  const steps = new Set<string>();
  let preRun = root.preRunReads?.keys.includes(key) === true;
  const queue = dataEdges(root, key)
    .filter((edge) => edge.builtOn === undefined)
    .map((edge) => edge.parent);
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (steps.has(node.runtimeStageId)) continue;
    steps.add(node.runtimeStageId);
    if (node.preRunReads?.keys.includes(key) || (builtOn && node.preRunBase?.keys.includes(key))) preRun = true;
    for (const edge of dataEdges(node, key)) if (builtOn || edge.builtOn === undefined) queue.push(edge.parent);
  }
  return { steps, preRun };
}

/** The first read whose value names a step the walk does not reach, or undefined when all are reached. */
function firstUnexplained(log: CommitBundle[], observed: Read[][], builtOn = true): string | undefined {
  for (let i = 0; i < observed.length; i++) {
    const id = `s${i}#0`;
    const root = causalChain(log, id, readsOf(observed), { maxNodes: 1000, maxDepth: 1000 })!;
    for (const { key, tokens } of observed[i]) {
      const walked = through(root, key, builtOn);
      for (const token of tokens) {
        if (fromBeforeTheRun(token)) {
          if (!walked.preRun) return `${id} read ${key} holding ${token}: the walk does not end before the run`;
        } else if (writerOf(token) !== id && !walked.steps.has(writerOf(token))) {
          return `${id} read ${key} holding ${token}: ${writerOf(token)} is not on the walk through ${key}`;
        }
      }
    }
  }
  return undefined;
}

describe('the walk back and a value built in steps', () => {
  it('SOUND: every step whose write is in a value a step read is on the walk back through that key', () => {
    fc.assert(
      fc.property(program, (p) => {
        const { log, observed } = run(p);
        expect(firstUnexplained(log, observed)).toBeUndefined();
      }),
      { numRuns: 3000 },
    );
  });

  it('EXACT: for a certain read, with no reader of the key on the way, the walk holds exactly the steps the value names', () => {
    let builtInSteps = 0;
    const builtInStepsFloor = 100;
    fc.assert(
      fc.property(building, (p) => {
        const { log, observed } = run(p);
        const reads = readsOf(observed);
        for (let i = 0; i < observed.length; i++) {
          const id = `s${i}#0`;
          const root = causalChain(log, id, reads, { maxNodes: 1000, maxDepth: 1000 })!;
          for (const { key, tokens, afterOwnWrite } of observed[i]) {
            // Its own write is in the value then, and the walk is about the others.
            if (afterOwnWrite) continue;
            // One certain source: every look of this step at the key saw one value.
            if (dataEdges(root, key).some((edge) => edge.overlap !== undefined)) continue;
            const walked = through(root, key);
            // A step on the way that READ the key is, at the level of whole steps, a cause of
            // everything it wrote, whether or not its write kept the value: one step too many is
            // then the walk's stated blur, not this rule's.
            if ([...walked.steps].some((step) => reads(step).includes(key))) continue;
            const named = new Set(tokens.filter((token) => !fromBeforeTheRun(token)).map(writerOf));
            if (named.size > 1) builtInSteps++;
            expect([...walked.steps].sort(), `${id} ${key}`).toEqual([...named].sort());
          }
        }
      }),
      { numRuns: 3000, seed: 20261111 },
    );
    // The clause is about values built in steps: the runs must hold many (the seed is fixed: 155).
    expect(builtInSteps).toBeGreaterThan(builtInStepsFloor);
  });

  it('FORWARD: the reader is among the readers of the life of every write its value names', () => {
    fc.assert(
      fc.property(program, (p) => {
        const { log, observed } = run(p);
        const lookup = readsOf(observed);
        for (let i = 0; i < observed.length; i++) {
          for (const { key, tokens } of observed[i]) {
            for (const token of tokens) {
              if (fromBeforeTheRun(token) || writerOf(token) === `s${i}#0`) continue;
              const at = log.findIndex((bundle) => bundle.runtimeStageId === writerOf(token));
              const life = forwardSliceForKey(log, key, lookup, { before: at + 1, maxNodes: 1000 }).root;
              expect(life?.commitIdx, `${token} wrote ${key} at ${at}`).toBe(at);
              expect(
                life?.reads.some((read) => read.runtimeStageId === `s${i}#0`),
                `s${i}#0 read ${key} holding ${token}: not among the readers of that write's life`,
              ).toBe(true);
            }
          }
        }
      }),
      { numRuns: 1500 },
    );
  });

  it('NEEDED: with the builtOn edges ignored, a step whose write is in the value read is left out', () => {
    const failure = fc.check(
      fc.property(program, (p) => {
        const { log, observed } = run(p);
        return firstUnexplained(log, observed, false) === undefined;
      }),
      { numRuns: 2000, seed: 20261111 },
    );
    expect(failure.failed).toBe(true);
    const { log, observed } = run(failure.counterexample![0]);
    expect(firstUnexplained(log, observed, false)).toMatch(/is not on the walk through|does not end before the run/);
    // The same run, with the edges followed, is explained.
    expect(firstUnexplained(log, observed)).toBeUndefined();
  });
});

// A `set` row is read as a write that replaced the value, and for a `set` a step made that is what
// it is. The writer also makes `set` rows of its own, out of writes that only ADDED to a value:
//   - `'delta'`: a step that merged into a key AND wrote a path inside it. The two rows share
//     storage in the bundle, so both are written as a `set` of the whole value;
//   - either encoding: a family of rows that would not fold back to what the step read is written as
//     `set` rows of that read-back (`TransactionBuffer · emitReadBack`).
// Such a row holds what the key held when the step began, plus the step's own part, and no field of
// the row says so. The walk then stops at that step, and the steps whose writes are still in the
// value are left out, with no note. When the writer says it, these two tests ask for the right answer.
describe('KNOWN LIMIT: a set row the writer made out of writes that only added', () => {
  const merged: Op[][] = [
    [{ kind: 'merge', key: 'a' }],
    [
      { kind: 'merge', key: 'a' },
      { kind: 'inside', key: 'a' },
    ],
    [{ kind: 'read', key: 'a' }],
  ];

  it('under full the rows keep their verbs, and the walk holds every step', () => {
    const { log, observed } = run({ steps: merged, schedule: [], encoding: 'full' });
    expect(log[1].trace.map((row) => row.verb)).toEqual(['merge', 'set']);
    expect(log[1].trace[1].path).not.toBe('a'); // the `set` is of a path inside the key
    expect(observed[2][0].tokens).toEqual(['init:a', 's0:0', 's1:0', 's1:1']);
    expect(firstUnexplained(log, observed)).toBeUndefined();
  });

  it('under delta the same step is one set of the whole value, and the walk stops at it', () => {
    const { log, observed } = run({ steps: merged, schedule: [], encoding: 'delta' });
    // The value is the same: it still holds what s0 wrote and what was there before the run.
    expect(observed[2][0].tokens).toEqual(['init:a', 's0:0', 's1:0', 's1:1']);
    expect(log[1].trace.filter((row) => row.path === 'a').map((row) => row.verb)).toEqual(['set']);
    // The omission, pinned: s0 is not on the walk back from the reader.
    expect(firstUnexplained(log, observed)).toBe('s2#0 read a holding init:a: the walk does not end before the run');
    const root = causalChain(log, 's2#0', readsOf(observed))!;
    expect([...through(root, 'a').steps]).toEqual(['s1#0']);
  });
});
