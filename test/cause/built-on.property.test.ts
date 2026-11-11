/**
 * Property tests: the cause graph and a value built in steps, on the REAL writer.
 *
 * The record graph without exact read sources, over runs made on `SharedMemory`, `EventLog` and
 * `RecordFrame`: steps side by side (so some carry a read window), steps that commit more than once
 * (`cut`: the later commit is a continuation), rows on the key and inside it, per-write read
 * provenance on.
 *
 *   INVERSE  every `'recorded-write'` edge is listed both ways: the child names the node among its
 *            parents, and the parent names it among its children. A law of these edges.
 *   VALUE    the judge is the value. Every write adds a field whose name says who wrote it, so the
 *            object a step read names the COMMITS it is made of. The node of each of those commits
 *            is on the way back from what the reader wrote.
 *
 * This generator and both clauses are the second reader's (review of the change that added these
 * edges, round 2). It failed on the first version of that change, which answered in steps where
 * the graph's nodes are commits, and it fails on the version before the change.
 *
 * Left out, as in the walk's own property test: a run in which the WRITER made a `set` row out of
 * writes that only added (`memory/builtOn.ts`, NOT COVERED). The test knows which paths each step
 * replaced itself, so a `set` row anywhere else is the writer's.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createRecordGraph } from '../../src/cause.js';
import { EventLog, RecordFrame, SharedMemory } from '../../src/write.js';

const address = { logRunId: 'run', drillPath: [] };
const ctx = () => ({ signal: new AbortController().signal });
const D = '\u001f';
type Kind = 'read' | 'set' | 'merge' | 'inside' | 'cut';
interface Program {
  steps: Kind[][];
  schedule: number[];
}
const program: fc.Arbitrary<Program> = fc.record({
  steps: fc.array(fc.array(fc.constantFrom<Kind>('read', 'set', 'merge', 'merge', 'inside', 'cut'), { maxLength: 5 }), {
    minLength: 2,
    maxLength: 4,
  }),
  schedule: fc.array(fc.nat({ max: 3 }), { maxLength: 30 }),
});

/** The first thing that is wrong in the graph of this run, as text; `undefined` when nothing is. */
async function firstFault(p: Program): Promise<string | undefined | 'left out'> {
  const state = new SharedMemory(undefined, {});
  const events = new EventLog({});
  const count = p.steps.length;
  const frame = () => {
    const made = new RecordFrame(state, events);
    made.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix' });
    return made;
  };
  const frames = p.steps.map(frame);
  const next = p.steps.map(() => 0);
  const commits = p.steps.map(() => 0);
  const done = p.steps.map(() => false);
  const writes = p.steps.map(() => 0);
  const observed: { step: number; tokens: string[] }[] = [];
  /** Where each token was committed, and what each step wrote since its last commit. */
  const committedAt = new Map<string, number>();
  const pending = p.steps.map((): string[] => []);
  const replaced = p.steps.map(() => new Set<string>());
  let writerMadeSet = false;

  const commitStep = (i: number): void => {
    // A reader writes a key of its own with its first commit: that write is the node the walk back starts at.
    if (commits[i] === 0 && p.steps[i].includes('read')) {
      frames[i].write([`o${i}`], 1, 'set');
      replaced[i].add(`o${i}`);
    }
    const at = events.list().length;
    const phase = commits[i]++ > 0 ? { phase: 'exit' as const } : {};
    frames[i].commit(() => ({ stage: `s${i}`, stageId: `s${i}`, runtimeStageId: `s${i}#0`, ...phase }));
    frames[i].release();
    for (const token of pending[i].splice(0)) committedAt.set(token, at);
    for (const row of events.list()[at].trace) {
      const own = [...replaced[i]].some((path) => row.path === path || row.path.startsWith(path + D));
      if (row.verb === 'set' && !own) writerMadeSet = true;
    }
    replaced[i].clear();
    frames[i] = frame();
  };
  const move = (i: number): void => {
    if (done[i]) return;
    const kind = p.steps[i][next[i]++];
    if (kind === undefined) {
      commitStep(i);
      done[i] = true;
      return;
    }
    if (kind === 'cut') return commitStep(i);
    if (kind === 'read') {
      if (commits[i] > 0) return; // a later commit of a step is not another run of its reads
      const value = frames[i].read([], 'k');
      frames[i].noteRead([], 'k');
      observed.push({ step: i, tokens: value && typeof value === 'object' ? Object.keys(value as object) : [] });
      return;
    }
    const token = `s${i}:${writes[i]++}`;
    pending[i].push(token);
    if (kind === 'set') {
      replaced[i].add('k');
      frames[i].write(['k'], { [token]: 1 }, 'set');
    } else if (kind === 'merge') frames[i].write(['k'], { [token]: 1 }, 'merge');
    else {
      replaced[i].add(['k', token].join(D));
      frames[i].write(['k', token], 1, 'set');
    }
  };
  for (const pick of p.schedule) move(pick % count);
  for (let i = 0; i < count; i++) while (!done[i]) move(i);
  if (writerMadeSet) return 'left out';

  const log = events.list();
  const reads = Object.fromEntries(p.steps.map((kinds, i) => [`s${i}#0`, kinds.includes('read') ? ['k'] : []]));
  const g = createRecordGraph([
    { address, commitLog: log, reads, attention: {}, controlDeps: {}, complete: true } as never,
  ]);
  const node = (step: string, at: number, key: string) =>
    g.nodeId(address, { runtimeStageId: step, commitIdx: at, key });
  const shown = log
    .map(
      (bundle, at) =>
        `${at}:${bundle.stageId}${bundle.phase ? '/' + bundle.phase : ''}[${bundle.trace
          .map((row) => `${row.verb} ${row.path.split(D).join('.')}`)
          .join(', ')}]`,
    )
    .join(' | ');

  // INVERSE: a recorded-write edge is listed both ways.
  for (let at = 0; at < log.length; at++) {
    if (!log[at].trace.some((row) => row.path === 'k' || row.path.startsWith('k' + D))) continue;
    const id = node(log[at].runtimeStageId, at, 'k');
    for (const child of (await g.children(id, ctx())).edges) {
      if (child.attribution !== 'recorded-write') continue;
      if (!(await g.parents(child.nodeId, ctx())).edges.some((edge) => edge.nodeId === id)) {
        return `commit ${at} names a write folded onto it that does not name it back :: ${shown}`;
      }
    }
    for (const parent of (await g.parents(id, ctx())).edges) {
      if (parent.attribution !== 'recorded-write') continue;
      if (!(await g.children(parent.nodeId, ctx())).edges.some((edge) => edge.nodeId === id)) {
        return `commit ${at} names the write under it, which does not name it forward :: ${shown}`;
      }
    }
  }

  // VALUE: the commit of every write in the value a reader read is on the way back from what it wrote.
  // A node of a path inside `k` counts as the node of `k` at that commit.
  const ofKey = (id: string): string => {
    const identity = JSON.parse(id.slice('record:'.length)) as {
      runtimeStageId: string;
      commitIdx: number;
      key?: string;
    };
    return identity.key === undefined
      ? id
      : node(identity.runtimeStageId, identity.commitIdx, identity.key.split(D)[0]);
  };
  for (const { step, tokens } of observed) {
    const at = log.findIndex(
      (bundle) => bundle.runtimeStageId === `s${step}#0` && bundle.trace.some((row) => row.path === `o${step}`),
    );
    if (at < 0) continue;
    const back = new Set<string>();
    const queue = [node(`s${step}#0`, at, `o${step}`)];
    while (queue.length > 0) {
      for (const edge of (await g.parents(queue.shift()!, ctx())).edges) {
        const id = ofKey(edge.nodeId);
        if (back.has(id)) continue;
        back.add(id);
        queue.push(id);
      }
    }
    for (const token of tokens) {
      const writer = Number(token.slice(1, token.indexOf(':')));
      const commit = committedAt.get(token);
      if (writer === step || commit === undefined) continue;
      if (!back.has(node(`s${writer}#0`, commit, 'k'))) {
        return `s${step} read k holding ${token}, written at commit ${commit}, which is not on its way back :: ${shown}`;
      }
    }
  }
  return undefined;
}

describe('the cause graph and a value built in steps, on the real writer', () => {
  it('INVERSE and VALUE: steps side by side, steps that commit more than once, rows inside the key', async () => {
    let judged = 0;
    let leftOut = 0;
    await fc.assert(
      fc.asyncProperty(program, async (p) => {
        const fault = await firstFault(p);
        if (fault === 'left out') return void leftOut++;
        judged++;
        expect(fault).toBeUndefined();
      }),
      { numRuns: 1500 },
    );
    expect(judged).toBeGreaterThan(leftOut * 10);
  }, 180_000);
});
