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
 *   WIDER     SOUND and FORWARD again on a wider run: a nested key (`a.x`) read and written, writes
 *             around a key and two levels inside it, steps that commit more than once, logs past
 *             256 commits (where the writer lookup changes its method) and frozen logs. This
 *             generator is the second reader's, who used it to try to break the first version.
 *
 * THE WRITER'S OWN `set` ROWS. A `set` row is read as a write that replaced the value, and for a
 * `set` a step made that is what it is. The writer also makes `set` rows of its own, out of writes
 * that only ADDED to a value, under both encodings:
 *   - `'full'` (the default): rows that would not fold back to what the step read are written as
 *     `set` rows of that read-back. Ordinary writes reach it: a step that merges into `a.x`, deletes
 *     `a.x` and merges into `a`.
 *   - `'delta'`: also any step that merged into a key and wrote a path inside it.
 * Such a row holds what the key held in the step's view, and it now SAYS so (`TraceEntry.builtOnView`):
 * the step is followed as having read that path from its view. The WIDER clauses run under both
 * encodings and leave no run out. They also check the mark itself against the test's own books: a
 * `set` row carries it exactly when the step did not replace that path, or a path around it, itself.
 * The first four clauses cannot reach these rows (they write top-level keys and fresh paths one level
 * inside), so their passing said nothing about them; the three cases at the end of this file pin them.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { causalChain, forwardSliceForKey } from '../../../../src';
import type { CausalEdge, CausalNode, CommitBundle, ForwardNode, ForwardSlice } from '../../../../src';
import { deepFreeze, EventLog, RecordFrame, SharedMemory } from '../../../../src/write';

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
 * from before the run (a step on the way read it from there, or its write was folded onto it, or the
 * writer built its `set` row on a view that held it: `preRunReads`, `preRunBase`, `preRunView`).
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
    const underAWrite = node.preRunBase?.keys.includes(key) || node.preRunView?.keys.includes(key);
    if (node.preRunReads?.keys.includes(key) || (builtOn && underAWrite)) preRun = true;
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

// ── WIDER ────────────────────────────────────────────────────────────────────────────────────────
// The second reader's generator (review of this change, round 1), kept as a test. Three keys, one of
// them inside another. Writes on a key, one and two levels inside it, around it, and its removal. A
// step may commit in the middle (`cut`) and go on: its later commit is a continuation of the same
// step. Half the runs sit behind 300 other commits, half are frozen as an engine snapshot is.

const D = '\u001f';
type WideKey = 'a' | 'b' | 'a.x';
type WideKind = 'read' | 'set' | 'merge' | 'inside' | 'deep' | 'delete' | 'around' | 'cut';
interface WideOp {
  kind: WideKind;
  key: WideKey;
}
interface WideProgram {
  steps: WideOp[][];
  schedule: number[];
  pad: boolean;
  freeze: boolean;
  encoding: Encoding;
}
const WIDE_SEED = { a: { 'init:a': 1, x: { 'init:x': 1 } } };
const wideProgram: fc.Arbitrary<WideProgram> = fc.record({
  steps: fc.array(
    fc.array(
      fc.record({
        kind: fc.constantFrom<WideKind>(
          'read',
          'read',
          'set',
          'merge',
          'merge',
          'inside',
          'deep',
          'delete',
          'around',
          'cut',
        ),
        key: fc.constantFrom<WideKey>('a', 'b', 'a.x'),
      }),
      { maxLength: 6 },
    ),
    { minLength: 2, maxLength: 5 },
  ),
  schedule: fc.array(fc.nat({ max: 4 }), { maxLength: 40 }),
  pad: fc.boolean(),
  freeze: fc.boolean(),
  encoding: fc.constantFrom<Encoding>('full', 'delta'),
});

/** Every writer's name in a value, at any depth. */
function tokensIn(value: unknown, out: string[] = []): string[] {
  if (value === null || typeof value !== 'object') return out;
  for (const [name, child] of Object.entries(value as object)) {
    if (/^(s\d+:\d+|init:.*)$/.test(name)) out.push(name);
    tokensIn(child, out);
  }
  return out;
}

function runWide(program: WideProgram) {
  const state = new SharedMemory(undefined, structuredClone(WIDE_SEED));
  const events = new EventLog(structuredClone(WIDE_SEED));
  const frame = () => {
    const made = new RecordFrame(state, events);
    made.useEncoding({ commitValues: program.encoding, writeProvenance: 'off' });
    return made;
  };
  if (program.pad) {
    for (let i = 0; i < 300; i++) {
      const pad = frame();
      pad.write(['z'], i, 'set');
      pad.commit(() => ({ stage: 'pad', stageId: 'pad', runtimeStageId: `pad#${i}` }));
      pad.release();
    }
  }
  const count = program.steps.length;
  const idOf = (i: number) => `s${i}#${1000 + i}`;
  const frames = program.steps.map(frame);
  const next = program.steps.map(() => 0);
  const writes = program.steps.map(() => 0);
  const commits = program.steps.map(() => 0);
  const done = program.steps.map(() => false);
  const observed: { key: WideKey; tokens: string[] }[][] = program.steps.map(() => []);
  /** The paths a step replaced itself since its last commit: a `set` row anywhere else is the writer's. */
  const replaced = program.steps.map(() => new Set<string>());
  /** Tokens a step wrote since its last commit, and where each token was committed. */
  const pending = program.steps.map((): string[] => []);
  const committedAt = new Map<string, number>();
  let writerMadeSet = false;
  /** A `set` row whose mark disagrees with these books: the first one, as text. */
  let wrongMark: string | undefined;

  const commitStep = (i: number): void => {
    const at = events.list().length;
    const phase = commits[i]++ > 0 ? { phase: 'exit' as const } : {};
    frames[i].commit(() => ({ stage: `s${i}`, stageId: `s${i}`, runtimeStageId: idOf(i), ...phase }));
    frames[i].release();
    for (const token of pending[i].splice(0)) committedAt.set(token, at);
    for (const row of events.list()[at].trace) {
      const own = [...replaced[i]].some((path) => row.path === path || row.path.startsWith(path + D));
      if (row.verb === 'set' && !own) writerMadeSet = true;
      // The mark is on exactly the `set` rows the step did not make itself, and on no other verb.
      const marked = row.builtOnView === true;
      if (marked !== (row.verb === 'set' && !own)) {
        wrongMark ??= `s${i} commit ${at}: ${row.verb} ${row.path.split(D).join('.')} is ${marked ? '' : 'not '}marked`;
      }
    }
    replaced[i].clear();
  };
  const move = (i: number): void => {
    if (done[i]) return;
    const act = program.steps[i][next[i]++];
    if (act === undefined) {
      commitStep(i);
      done[i] = true;
      return;
    }
    const { kind, key } = act;
    const path = key.split('.');
    if (kind === 'cut') return commitStep(i);
    if (kind === 'read') {
      // A later commit of a step is not another run of its reads: a step reads before its first commit.
      if (commits[i] > 0) return;
      observed[i].push({ key, tokens: tokensIn(frames[i].read(path.slice(0, -1), path[path.length - 1])) });
      return;
    }
    const token = `s${i}:${writes[i]++}`;
    pending[i].push(token);
    if (kind === 'set' || kind === 'delete') replaced[i].add(path.join(D));
    if (kind === 'inside') replaced[i].add([...path, token].join(D));
    if (kind === 'deep') replaced[i].add([...path, 'd', token].join(D));
    if (kind === 'set') frames[i].write(path, { [token]: 1 }, 'set');
    else if (kind === 'merge') frames[i].write(path, { [token]: 1 }, 'merge');
    else if (kind === 'inside') frames[i].write([...path, token], 1, 'set');
    else if (kind === 'deep') frames[i].write([...path, 'd', token], 1, 'set');
    else if (kind === 'delete') frames[i].write(path, undefined, 'delete');
    else if (key === 'a.x') frames[i].write(['a'], { x: { [token]: 1 } }, 'merge');
    else frames[i].write(path, { [token]: { [token]: 1 } }, 'merge');
  };
  for (const pick of program.schedule) move(pick % count);
  for (let i = 0; i < count; i++) while (!done[i]) move(i);
  const log = program.freeze ? (deepFreeze(events.list(), 'indices') as CommitBundle[]) : events.list();
  const reads = (id: string): string[] => {
    const step = /^s(\d+)#/.exec(id);
    return step ? [...new Set((observed[Number(step[1])] ?? []).map((read) => read.key.replace('.', D)))] : [];
  };
  return { log, observed, idOf, reads, committedAt, writerMadeSet, wrongMark };
}

/**
 * Does the way forward from a write reach `reader` as a reader of `key`: in the life of that write, or
 * in the life of a later write of the key (or of a path inside or around it) that descends from it?
 * The second case is a `set` row the writer built on a view that held the write: that row ends the
 * first life, its step is a reader of it, and the value goes on in the row's own life.
 */
function reachesReader(slice: ForwardSlice, reader: string, key: string): boolean {
  const related = (other: string) => other === key || other.startsWith(key + D) || key.startsWith(other + D);
  const seen = new Set<ForwardNode>();
  const queue: ForwardNode[] = slice.root ? [slice.root] : [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (seen.has(node)) continue;
    seen.add(node);
    if (related(node.key) && node.reads.some((read) => read.runtimeStageId === reader)) return true;
    for (const edge of node.fedEdges) queue.push(edge.child);
  }
  return false;
}

describe('the walk back and a value built in steps, on a wider run', () => {
  it('SOUND, both encodings: nested keys, writes around and deep inside, steps that commit twice, long and frozen logs', () => {
    let runs = 0;
    let writerMade = 0;
    let continued = 0;
    fc.assert(
      fc.property(wideProgram, (program) => {
        const { log, observed, idOf, reads, writerMadeSet, wrongMark } = runWide(program);
        runs++;
        if (writerMadeSet) writerMade++;
        if (log.some((bundle) => bundle.phase === 'exit')) continued++;
        expect(wrongMark, 'the mark on a set row the writer made').toBeUndefined();
        for (let i = 0; i < observed.length; i++) {
          const root = causalChain(log, idOf(i), reads, { maxNodes: 100_000, maxDepth: 100_000 })!;
          for (const { key, tokens } of observed[i]) {
            const walked = through(root, key.replace('.', D));
            for (const token of tokens) {
              if (fromBeforeTheRun(token)) {
                expect(walked.preRun, `${idOf(i)} read ${key} holding ${token}: the walk ends before the run`).toBe(
                  true,
                );
                continue;
              }
              const writer = idOf(Number(token.slice(1, token.indexOf(':'))));
              if (writer === idOf(i)) continue;
              expect(
                walked.steps.has(writer),
                `${idOf(i)} read ${key} holding ${token}: ${writer} is on the walk`,
              ).toBe(true);
            }
          }
        }
      }),
      { numRuns: 4000 },
    );
    // No run is left out, and many of them hold what used to be the limit: a `set` row the writer made.
    expect(runs).toBe(4000);
    expect(writerMade).toBeGreaterThan(200);
    expect(continued).toBeGreaterThan(300);
  }, 180_000);

  it('FORWARD, both encodings: the reader is among the readers of the life of every write its value names', () => {
    fc.assert(
      fc.property(wideProgram, (program) => {
        const { log, observed, idOf, reads, committedAt } = runWide(program);
        for (let i = 0; i < observed.length; i++) {
          for (const { key, tokens } of observed[i]) {
            for (const token of tokens) {
              if (fromBeforeTheRun(token) || token.startsWith(`s${i}:`)) continue;
              const at = committedAt.get(token)!;
              const life = forwardSliceForKey(log, key.split('.'), reads, { before: at + 1, maxNodes: 100_000 });
              expect(life.root?.commitIdx, `${token} was written to ${key} at ${at}`).toBe(at);
              // The reader read the value while this write was in it: it is a reader of this life, or of
              // the life of a later write that the writer built on a view which held it.
              expect(
                reachesReader(life, idOf(i), key.replace('.', D)),
                `${idOf(i)} read ${key} holding ${token}: the way forward from that write reaches it`,
              ).toBe(true);
            }
          }
        }
      }),
      { numRuns: 2500 },
    );
  }, 180_000);
});

// A `set` row is read as a write that replaced the value, and for a `set` a step made that is what
// it is. The writer also makes `set` rows of its own, out of writes that only ADDED to a value. Such a
// row holds what the key held in the step's view, plus the step's own part. Until the writer marked
// it, nothing in the row said so: the walk stopped at that step, and the steps whose writes were
// still in the value were left out, with no note. These three were pinned as KNOWN LIMIT with the
// wrong answer; they now ask for the right one.
describe('CLOSED: a set row the writer made out of writes that only added says so, and is followed', () => {
  const merged: Op[][] = [
    [{ kind: 'merge', key: 'a' }],
    [
      { kind: 'merge', key: 'a' },
      { kind: 'inside', key: 'a' },
    ],
    [{ kind: 'read', key: 'a' }],
  ];

  it('full: a step that merges into a key and writes a path inside it keeps its verbs, and no row is marked', () => {
    const { log, observed } = run({ steps: merged, schedule: [], encoding: 'full' });
    expect(log[1].trace.map((row) => row.verb)).toEqual(['merge', 'set']);
    expect(log[1].trace[1].path).not.toBe('a'); // the `set` is of a path inside the key, and the step made it
    expect(log.flatMap((bundle) => bundle.trace).some((row) => row.builtOnView)).toBe(false);
    expect(observed[2][0].tokens).toEqual(['init:a', 's0:0', 's1:0', 's1:1']);
    expect(firstUnexplained(log, observed)).toBeUndefined();
  });

  it('delta: the same step is one set of the whole value, marked, and the walk goes on through it', () => {
    const { log, observed } = run({ steps: merged, schedule: [], encoding: 'delta' });
    expect(observed[2][0].tokens).toEqual(['init:a', 's0:0', 's1:0', 's1:1']);
    // `set a` holds the whole value and the step never set `a`: marked. The path inside it the step did set.
    expect(log[1].trace.map((row) => [row.verb, row.path === 'a' ? 'a' : 'a/…', row.builtOnView])).toEqual([
      ['set', 'a/…', undefined],
      ['set', 'a', true],
    ]);
    expect(firstUnexplained(log, observed)).toBeUndefined();
    const root = causalChain(log, 's2#0', readsOf(observed))!;
    expect([...through(root, 'a').steps].sort()).toEqual(['s0#0', 's1#0']);
    expect(through(root, 'a').preRun).toBe(true);
  });

  it('full, the default: merge into a.x, delete a.x, merge into a is two sets; the one of `a` is marked and followed', () => {
    // Found by the second reader of the reader rule. Nothing unusual is written here, and the encoding is
    // the default one. The rows would not fold back to what the step read, so the writer stored what it
    // read: `set a.x`, `set a`. The step deleted `a.x` itself; it never replaced `a`.
    const { log, observed, idOf, reads } = runWide({
      steps: [
        [{ kind: 'merge', key: 'a' }],
        [
          { kind: 'merge', key: 'a.x' },
          { kind: 'delete', key: 'a.x' },
          { kind: 'merge', key: 'a' },
        ],
        [{ kind: 'read', key: 'a' }],
      ],
      schedule: [],
      pad: false,
      freeze: false,
      encoding: 'full',
    });
    expect(
      log[1].trace.map(
        (row) => `${row.verb} ${row.path.split(D).join('.')}${row.builtOnView ? ' (built on view)' : ''}`,
      ),
    ).toEqual(['set a.x', 'set a (built on view)']);
    expect(observed[2][0].tokens).toEqual(expect.arrayContaining(['init:a', 's0:0', 's1:2']));
    const root = causalChain(log, idOf(2), reads)!;
    const walked = through(root, 'a');
    expect([...walked.steps].sort()).toEqual([idOf(0), idOf(1)].sort());
    expect(walked.preRun).toBe(true);
  });
});
