/**
 * Boundary — a key query costs what its answer costs, not a fold per key (F3 review, fix 1).
 *
 * The shape that broke it: commit i writes `cfg␟f{i}`, every 50th commit also merges `cfg`, and stage i reads
 * `cfg␟f{i-1}`; a causal walk from the last commit asks one nested key per stage. Folding the top-level key
 * once per KEY (and scanning the log for its rows) made that walk cubic in the log — N = 1000: 1.3 s,
 * 4000: 92 s. The read model (`memory/logModel.ts`) indexes the log once, folds each top-level key at most
 * once, and needs no verdict at all when no write around the key falls after its last write.
 *
 * The test runs the same shape at N and 4N and asserts the WORK ratio stays near linear: < 6× for 4× the log
 * (a quadratic walk is 16×, the old cubic one 64×). Work is counted, not timed (F4b): `keyPaths · queryWork`
 * sums every row indexed and scanned, every fold step, every around-verdict, every trie, ancestor and
 * binary-search step, and causalChain's own loops (queue, read keys, dedup scans) — the
 * same count on every machine, so the ratio cannot fail on load (the wall-clock version failed at 10.7× and
 * 11.1× on a busy runner while the shape was linear). A quadratic control proves the counter sees a shape
 * that is not.
 */
import { deepFreeze } from '../../../../src/lib/capture/freeze';
import { queryWork } from '../../../../src/lib/memory/keyPaths';
import type { CommitBundle } from '../../../../src/index';
import { causalChain, commitValueAt, findLastWriter } from '../../../../src/index';

const D = '\u001F';

function shape(n: number, frozen: boolean, width = Number.POSITIVE_INFINITY) {
  const log: CommitBundle[] = [];
  const reads = new Map<string, string[]>();
  const field = (i: number) => `f${Number.isFinite(width) ? i % width : i}`;
  for (let i = 0; i < n; i++) {
    const trace: CommitBundle['trace'] = [{ path: `cfg${D}${field(i)}`, verb: 'set' }];
    const updates: Record<string, unknown> = {};
    if (i % 50 === 0) {
      trace.push({ path: 'cfg', verb: 'merge' });
      updates.cfg = { g: i };
    }
    const rid = `s${i}#${i}`;
    log.push({
      idx: i,
      stage: 'S',
      stageId: `s${i}`,
      runtimeStageId: rid,
      trace,
      overwrite: { cfg: { [field(i)]: i } },
      updates,
      redactedPaths: [],
    });
    reads.set(rid, i > 0 ? [`cfg${D}${field(i - 1)}`] : []);
  }
  return { log: frozen ? deepFreeze(log, 'indices') : log, lookup: (id: string) => reads.get(id) ?? [] };
}

/** The read models' work for `work` on a fresh shape of size `n` — deterministic. */
function workOf(
  n: number,
  frozen: boolean,
  work: (s: ReturnType<typeof shape>) => unknown,
  width = Number.POSITIVE_INFINITY,
): number {
  const s = shape(n, frozen, width);
  const before = queryWork.units;
  work(s);
  return queryWork.units - before;
}

const ask = (s: ReturnType<typeof shape>) => {
  const len = s.log.length;
  for (let j = 0; j < 100; j++) findLastWriter(s.log, `cfg${D}f${(len - 2 - j) % 100}`, len - j);
  for (let j = 0; j < 100; j++) commitValueAt(s.log, len - 1 - j, `cfg${D}f${(len - 2 - j) % 100}`);
};

const quadratic = (s: ReturnType<typeof shape>) => {
  for (let i = 0; i < s.log.length; i += 10) commitValueAt(s.log, i, `cfg${D}f${i}`);
};

const walk = (s: ReturnType<typeof shape>) =>
  causalChain(s.log, s.log[s.log.length - 1].runtimeStageId, s.lookup, { maxDepth: 1e6, maxNodes: 1e6 });

describe('a causal walk over nested keys scales near-linearly in the log', () => {
  for (const frozen of [false, true]) {
    it(`${frozen ? 'a frozen (engine) log' : 'a hand-built log'}: N = 2000 vs 8000 does under 6× the work`, () => {
      // the walk is real: it reaches the first stage through every nested key
      const small = shape(200, frozen);
      expect(walk(small)).toBeDefined();
      const n = workOf(2000, frozen, walk);
      const n4 = workOf(8000, frozen, walk);
      expect(n).toBeGreaterThan(2000); // it counted the walk
      expect(n4 / n).toBeLessThan(6);
    });
  }

  // One model per frozen log: 200 single questions build it once and fold the top-level key at most once.
  it('200 single writer and value questions on a frozen log, at 4× the log, do under 6× the work', () => {
    const n = workOf(2000, true, ask, 100);
    const n4 = workOf(8000, true, ask, 100);
    expect(n).toBeGreaterThan(2000);
    expect(n4 / n).toBeLessThan(6);
  });

  // The control: the counter sees a shape that is NOT linear. One question per tenth commit on a log that is
  // not frozen builds a fresh model per question (O(N) each), so the work is quadratic: 16× at 4× the log.
  it('the control: a quadratic shape is caught by the same bound', () => {
    const n = workOf(500, false, quadratic);
    const n4 = workOf(2000, false, quadratic);
    expect(n4 / n).toBeGreaterThan(6);
  });
});

/**
 * A value built in steps (`memory/builtOn.ts`): one key that every commit ADDS to and one reader at the end.
 * The walk back now follows one link per write, back to the write that replaced the value, so its work has
 * to grow with the chain and not with its square. Each link is one writer lookup and one look at the rows of
 * one bundle.
 */
function chain(n: number, frozen: boolean) {
  const log: CommitBundle[] = [];
  for (let i = 0; i < n; i++) {
    log.push({
      idx: i,
      stage: 'S',
      stageId: `s${i}`,
      runtimeStageId: `s${i}#${i}`,
      trace: [{ path: 'list', verb: i === 0 ? 'set' : 'merge' }],
      overwrite: i === 0 ? { list: [0] } : {},
      updates: i === 0 ? {} : { list: [i] },
      redactedPaths: [],
    });
  }
  log.push({
    idx: n,
    stage: 'Use',
    stageId: 'use',
    runtimeStageId: `use#${n}`,
    trace: [{ path: 'out', verb: 'set' }],
    overwrite: { out: 1 },
    updates: {},
    redactedPaths: [],
  });
  const lookup = (id: string) => (id.startsWith('use#') ? ['list'] : []);
  return { log: frozen ? deepFreeze(log, 'indices') : log, lookup };
}

describe('a walk back through a value built in steps scales near-linearly in the chain', () => {
  const walkChain = (s: ReturnType<typeof chain>) =>
    causalChain(s.log, s.log[s.log.length - 1].runtimeStageId, s.lookup, { maxDepth: 1e6, maxNodes: 1e6 });
  const workOfChain = (n: number, frozen: boolean): number => {
    const s = chain(n, frozen);
    const before = queryWork.units;
    walkChain(s);
    return queryWork.units - before;
  };

  for (const frozen of [false, true]) {
    it(`${
      frozen ? 'a frozen (engine) log' : 'a hand-built log'
    }: a chain of 2000 vs 8000 writes does under 6× the work`, () => {
      // The walk is real: it reaches the write that replaced the value, through every write after it.
      const small = chain(300, frozen);
      const root = walkChain(small)!;
      let depth = 0;
      for (let node = root; node.parents.length > 0; node = node.parents[0]) depth++;
      expect(depth).toBe(300);
      const n = workOfChain(2000, frozen);
      const n4 = workOfChain(8000, frozen);
      expect(n).toBeGreaterThan(2000); // it counted the walk
      expect(n4 / n).toBeLessThan(6);
    });
  }
});
