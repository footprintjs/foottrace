/**
 * The cause graph and a value built in steps.
 *
 * A node of the graph is one commit's write of one key. `fill` merged a field into the box that `start`
 * had set, without reading it, and `use` read the box. The graph had no edge from `fill`'s box to
 * `start`'s: the walk over reads saw no read, and neither did the exact read sources. A walk from
 * `use` reached `fill` and stopped. Both of the graph's ways of finding neighbours now ask the one rule
 * (`memory/builtOn.ts`, through `cause/recordBuiltOn.ts`), backward and forward.
 *
 * Test types: scenario (parents, children and gaps through both adapters, and with exact read
 * sources), boundary (a first write that is a merge, a write that replaces, two bundles of one step),
 * regression (a record whose writes all replace answers as before).
 */
import { describe, expect, it } from 'vitest';

import { createRecordGraph, createStoredRecordGraph, explain } from '../../src/cause.js';
import type { RecordScope } from '../../src/cause.js';
import type { CommitBundle } from '../../src/index.js';
import { EventLog, RecordFrame, SharedMemory } from '../../src/write.js';
import type { ReadSourceSnapshot } from '../../src/write.js';

const address = { logRunId: 'run', drillPath: [] };
const ctx = () => ({ signal: new AbortController().signal });
type Row = [path: string, verb: 'set' | 'merge' | 'append' | 'delete', readKeys?: string[]];
function commit(id: string, idx: number, rows: Row[], extra: object = {}): CommitBundle {
  return {
    idx,
    stage: id,
    stageId: id,
    runtimeStageId: `${id}#${idx}`,
    trace: rows.map(([path, verb, readKeys = []]) => ({ path, verb, readKeys })),
    redactedPaths: [],
    overwrite: Object.fromEntries(rows.filter(([, verb]) => verb === 'set').map(([path]) => [path, idx])),
    updates: Object.fromEntries(
      rows.filter(([, verb]) => verb !== 'set' && verb !== 'delete').map(([path]) => [path, { [`f${idx}`]: idx }]),
    ),
    ...extra,
  };
}
/** start sets the box; fill merges into it without reading it; use reads it and writes `final`. */
const builtInSteps = () => [
  commit('start', 0, [['box', 'set']]),
  commit('fill', 1, [['box', 'merge']]),
  commit('use', 2, [['final', 'set', ['box']]]),
];
const READS = { 'start#0': [], 'fill#1': [], 'use#2': ['box'] };
const scope = (commitLog: unknown[], reads: object = READS, attention: object = {}) => ({
  address,
  commitLog,
  reads,
  attention,
  controlDeps: {},
  complete: true,
});
const stored = (commitLog: unknown[], reads: object = READS, attention: object = {}) => ({
  entries: [
    { kind: 'opened', address, at: 0, initialState: {} },
    ...commitLog.map((bundle) => ({ kind: 'commit', address, at: 0, bundle })),
    { kind: 'closed', address, at: 0, outcome: 'ok', commits: commitLog.length },
  ],
  reads,
  attention,
  controlDeps: {},
});

const ADAPTERS = {
  'a record in memory': (commitLog: unknown[], reads?: object, attention?: object) =>
    createRecordGraph([scope(commitLog, reads, attention) as never]),
  'a stored record': (commitLog: unknown[], reads?: object, attention?: object) =>
    createStoredRecordGraph({ loadLog: async () => stored(commitLog, reads, attention) as never }),
};
const failure = { kind: 'error', reason: 'ERROR_RECORDED', evidence: ['test:failure'] } as const;

describe.each(Object.entries(ADAPTERS))('the cause graph over %s', (_name, graphOf) => {
  const ask = (commitLog: CommitBundle[], reads?: object) => {
    const g = graphOf(commitLog, reads);
    const node = (at: number, key: string) =>
      g.nodeId(address, { runtimeStageId: commitLog[at].runtimeStageId, commitIdx: at, key });
    // A node is named `step.key`; a key written through a path inside it is a node too (`box` for `box␟b`).
    const named = (id: string) => {
      for (let at = 0; at < commitLog.length; at++)
        for (const row of commitLog[at].trace) {
          const parts = row.path.split('\u001f');
          for (let depth = 1; depth <= parts.length; depth++) {
            const key = parts.slice(0, depth).join('\u001f');
            if (id === node(at, key)) return `${commitLog[at].stageId}.${parts.slice(0, depth).join('/')}`;
          }
        }
      return id;
    };
    const edges = (list: { edges: readonly { nodeId: string; attribution: string }[] }) =>
      list.edges.map((edge) => `${named(edge.nodeId)} (${edge.attribution})`);
    return {
      parents: async (at: number, key: string) => edges(await g.parents(node(at, key), ctx())),
      children: async (at: number, key: string) => edges(await g.children(node(at, key), ctx())),
      gaps: async (at: number, key: string) => (await g.gaps(node(at, key), ctx())).map((gap) => gap.code),
    };
  };

  it('the finding: the box Fill left has the box Start wrote as its parent, and the edge is exact', async () => {
    const answer = ask(builtInSteps());
    expect(await answer.parents(2, 'final')).toEqual(['fill.box (per-write)']);
    expect(await answer.parents(1, 'box')).toEqual(['start.box (recorded-write)']);
    expect(await answer.gaps(1, 'box')).toEqual([]);
    expect(await answer.parents(0, 'box')).toEqual([]);
  });

  it('forward is the inverse: what Start wrote went into what Fill left, and on to what Use wrote', async () => {
    const answer = ask(builtInSteps());
    // The life of Start's write does not end at Fill's merge, so Use is a reader of it too.
    expect(await answer.children(0, 'box')).toEqual(['use.final (per-write)', 'fill.box (recorded-write)']);
    expect(await answer.children(1, 'box')).toEqual(['use.final (per-write)']);
  });

  it('a chain: each partial write has the write before it as its parent, up to the one that replaced the value', async () => {
    const log = [
      commit('old', 0, [['k', 'set']]),
      commit('a', 1, [['k', 'set']]),
      commit('b', 2, [['k', 'merge']]),
      commit('c', 3, [['k', 'append']]),
    ];
    const answer = ask(log, { 'old#0': [], 'a#1': [], 'b#2': [], 'c#3': [] });
    expect(await answer.parents(3, 'k')).toEqual(['b.k (recorded-write)']);
    expect(await answer.parents(2, 'k')).toEqual(['a.k (recorded-write)']);
    expect(await answer.parents(1, 'k')).toEqual([]);
    expect(await answer.children(0, 'k')).toEqual([]);
    expect(await answer.children(1, 'k')).toEqual(['b.k (recorded-write)']);
    expect(await answer.children(2, 'k')).toEqual(['c.k (recorded-write)']);
  });

  it('a first write that is a merge was folded onto the value from before the run: no parent, and no new gap', async () => {
    // The node already said `conservative` for a value with no whole write in range, before this edge
    // existed. It still says exactly that: a first `$update` of a run is not an untracked input.
    const log = [commit('fill', 0, [['box', 'merge']]), commit('use', 1, [['final', 'set', ['box']]])];
    const answer = ask(log, { 'fill#0': [], 'use#1': ['box'] });
    expect(await answer.parents(0, 'box')).toEqual([]);
    expect(await answer.gaps(0, 'box')).toEqual(['conservative']);
  });

  it('explain: a failure in Start is now found as the root cause of what Use wrote, through Fill', async () => {
    // The answer a caller sees. Start is marked (its step failed, say). Use's value rests on Start's box
    // through Fill's merge. Without the edge the walk ended at Fill: no marked ancestor, no root cause.
    const log = builtInSteps();
    const g = graphOf(log, READS, { 'start#0': [failure] });
    const node = (at: number, key: string) =>
      g.nodeId(address, { runtimeStageId: log[at].runtimeStageId, commitIdx: at, key });
    const finding = await explain(g, node(2, 'final'), { includeBackward: true });
    expect(finding.gaps).toEqual([]);
    expect(finding.confidence).toBe('complete');
    expect(finding.rootCause).toBe(node(0, 'box'));
    expect(finding.path).toEqual([node(2, 'final'), node(1, 'box'), node(0, 'box')]);
    expect(finding.backward?.edges).toEqual([
      { from: node(2, 'final'), to: node(1, 'box'), kind: 'data', attribution: 'per-write', evidence: ['commit:1'] },
      { from: node(1, 'box'), to: node(0, 'box'), kind: 'data', attribution: 'recorded-write', evidence: ['commit:0'] },
    ]);
  });

  it('explain, forward: what Start wrote reaches both the box Fill left and what Use wrote', async () => {
    const log = builtInSteps();
    const g = graphOf(log);
    const node = (at: number, key: string) =>
      g.nodeId(address, { runtimeStageId: log[at].runtimeStageId, commitIdx: at, key });
    const finding = await explain(g, node(0, 'box'));
    expect([...finding.impact.nodes].sort()).toEqual([node(1, 'box'), node(2, 'final')].sort());
    expect(finding.impact.confidence).toBe('complete');
  });

  it('a row on a path inside the key is partial too: the node of the whole key leads to the write before it', async () => {
    const inside = 'box\u001fb';
    const log = [
      commit('start', 0, [['box', 'set']]),
      commit('fill', 1, [[inside, 'set']]),
      commit('use', 2, [['final', 'set', ['box']]]),
    ];
    const answer = ask(log);
    expect(await answer.parents(2, 'final')).toEqual(['fill.box (per-write)']);
    expect(await answer.parents(1, 'box')).toEqual(['start.box (recorded-write)']);
    // The inner path itself was replaced by Fill: nothing older is in it.
    expect(await answer.parents(1, inside)).toEqual([]);
    expect(await answer.children(0, 'box')).toContain('fill.box (recorded-write)');
  });

  it('the cap on edges counts the write folded onto a node, and a cut is said', async () => {
    // Start's box has two readers and one write folded onto it: three children, one more than a cap of two.
    const log = [
      commit('start', 0, [['box', 'set']]),
      commit('r1', 1, [['out1', 'set', ['box']]]),
      commit('r2', 2, [['out2', 'set', ['box']]]),
      commit('fill', 3, [['box', 'merge']]),
    ];
    const reads = { 'start#0': [], 'r1#1': ['box'], 'r2#2': ['box'], 'fill#3': [] };
    const roomy = createRecordGraph([scope(log, reads) as never]);
    const tight = createRecordGraph([scope(log, reads) as never], { maxEdges: 2 });
    const node = (g: typeof roomy) => g.nodeId(address, { runtimeStageId: 'start#0', commitIdx: 0, key: 'box' });
    const all = await roomy.children(node(roomy), ctx());
    expect(all.edges.map((edge) => edge.attribution)).toEqual(['per-write', 'per-write', 'recorded-write']);
    expect((await roomy.gaps(node(roomy), ctx())).map((gap) => gap.code)).toEqual([]);
    const cut = await tight.children(node(tight), ctx());
    expect(cut.edges).toHaveLength(2);
    expect(cut.complete).toBe(false);
    expect((await tight.gaps(node(tight), ctx())).map((gap) => gap.code)).toContain('edge-limit');
  });

  it('a step that committed twice: the way back goes through BOTH its commits, as the way forward does', async () => {
    // A mount commits and then commits its exit. Its later commit was folded onto its earlier one. The
    // box Use read holds what both wrote, so both are on the way back, and the way forward from the
    // earlier commit reaches Use. (Read off the step-level walk, the earlier commit was skipped going
    // back and reached going forward: the second reader of this change found it.)
    const log = [
      commit('start', 0, [['box', 'set']]),
      commit('mount', 1, [['box', 'merge']]),
      { ...commit('mount', 2, [['box', 'merge']]), runtimeStageId: 'mount#1', phase: 'exit' },
      commit('use', 3, [['final', 'set', ['box']]]),
    ];
    const answer = ask(log as CommitBundle[], { 'start#0': [], 'mount#1': [], 'use#3': ['box'] });
    expect(await answer.parents(3, 'final')).toEqual(['mount.box (per-write)']);
    expect(await answer.parents(2, 'box')).toEqual(['mount.box (recorded-write)']);
    expect(await answer.parents(1, 'box')).toEqual(['start.box (recorded-write)']);
    expect(await answer.children(0, 'box')).toEqual(['use.final (per-write)', 'mount.box (recorded-write)']);
    expect(await answer.children(1, 'box')).toEqual(['use.final (per-write)', 'mount.box (recorded-write)']);
    // By position, since both of the mount's nodes read `mount.box`:
    const g = graphOf(log, { 'start#0': [], 'mount#1': [], 'use#3': ['box'] });
    const node = (at: number, key: string) =>
      g.nodeId(address, { runtimeStageId: log[at].runtimeStageId, commitIdx: at, key });
    expect((await g.parents(node(2, 'box'), ctx())).edges.map((edge) => edge.nodeId)).toEqual([node(1, 'box')]);
    expect((await g.children(node(1, 'box'), ctx())).edges.map((edge) => edge.nodeId)).toEqual([
      node(3, 'final'),
      node(2, 'box'),
    ]);
  });

  it("a step that READ the key and then added to it keeps the edge it always had: one edge, the read's", async () => {
    // The common shape (`scope.box.b = 2` reads the box first). Its read already names Start's write, for
    // certain, so the answer for such a record does not move: same node, same attribution, no second edge.
    const log = [
      commit('start', 0, [['box', 'set']]),
      commit('fill', 1, [['box', 'merge', ['box']]]),
      commit('use', 2, [['final', 'set', ['box']]]),
    ];
    const answer = ask(log, { 'start#0': [], 'fill#1': ['box'], 'use#2': ['box'] });
    expect(await answer.parents(1, 'box')).toEqual(['start.box (per-write)']);
    expect(await answer.gaps(1, 'box')).toEqual([]);
    // Forward, Fill's box is listed once: fed by its read, and the fold onto Start is the same node.
    // Use is listed too, and that is new: Fill only added, so what Use read still holds Start's write.
    expect(await answer.children(0, 'box')).toEqual(['fill.box (per-write)', 'use.final (per-write)']);
  });

  it('a record whose writes all replace answers as before: no such edge anywhere', async () => {
    const log = [
      commit('start', 0, [['box', 'set']]),
      commit('again', 1, [['box', 'set']]),
      commit('use', 2, [['final', 'set', ['box']]]),
    ];
    const answer = ask(log, { 'start#0': [], 'again#1': [], 'use#2': ['box'] });
    expect(await answer.parents(1, 'box')).toEqual([]);
    expect(await answer.children(0, 'box')).toEqual([]);
    expect(await answer.parents(2, 'final')).toEqual(['again.box (per-write)']);
  });
});

describe('with exact read sources, which know of reads only', () => {
  const log = builtInSteps();
  const book: ReadSourceSnapshot = {
    version: 1,
    address,
    segment: 1,
    status: 'captured',
    occurrences: [
      {
        ordinal: 1,
        runtimeStageId: 'use#2',
        attemptId: 'use#2@1',
        attemptStatus: 'known',
        frame: 1,
        key: 'box',
        stateAddress: [],
        source: { kind: 'committed', commitIdx: 1 },
        disposition: 'released',
      },
    ],
    gaps: [],
    limits: { maxOccurrences: 32, maxPerExecution: 32, maxBytes: 16384, maxOrigins: 32, maxStaging: 32 },
  };
  const graph = () =>
    createRecordGraph([
      {
        ...scope(log),
        initialState: {},
        readSources: {
          record: book,
          executions: [
            { runtimeStageId: 'start#0', stateAddress: [], attemptIds: ['start#0@1'] },
            { runtimeStageId: 'fill#1', stateAddress: [], attemptIds: ['fill#1@1'] },
            { runtimeStageId: 'use#2', stateAddress: [], attemptIds: ['use#2@1'] },
          ],
        },
      } as unknown as RecordScope,
    ]);

  it('the exact source of the read is Fill, and the box Fill left still leads to the box Start wrote', async () => {
    const g = graph();
    const node = (at: number, key: string) =>
      g.nodeId(address, { runtimeStageId: log[at].runtimeStageId, commitIdx: at, key });
    const fromFill = await g.parents(node(1, 'box'), ctx());
    expect(fromFill.edges).toEqual([
      { nodeId: node(0, 'box'), kind: 'data', attribution: 'recorded-write', evidence: ['commit:0'] },
    ]);
    const fromStart = await g.children(node(0, 'box'), ctx());
    expect(fromStart.edges.map((edge) => [edge.nodeId, edge.attribution])).toEqual([
      [node(1, 'box'), 'recorded-write'],
    ]);
  });
});

describe('steps side by side, on the real writer', () => {
  it('what a step read and what its write was folded onto are two parents, each known for certain', async () => {
    // Fill pins its view (it reads the box Start wrote). Other replaces the box and commits. Fill merges
    // into the box and commits: the fold puts its field onto OTHER's value.
    const state = new SharedMemory(undefined, {});
    const events = new EventLog({});
    const step = (id: string, body: (frame: RecordFrame) => void) => {
      const frame = new RecordFrame(state, events);
      frame.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix' });
      return () => {
        body(frame);
        frame.commit(() => ({ stage: id, stageId: id, runtimeStageId: `${id}#0` }));
        frame.release();
      };
    };
    step('start', (frame) => frame.write(['box'], { a: 1 }, 'set'))();
    const fill = new RecordFrame(state, events);
    fill.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix' });
    fill.read([], 'box');
    fill.noteRead([], 'box');
    step('other', (frame) => frame.write(['box'], { o: 1 }, 'set'))();
    fill.write(['box'], { b: 2 }, 'merge');
    fill.commit(() => ({ stage: 'fill', stageId: 'fill', runtimeStageId: 'fill#0' }));
    fill.release();
    const log = events.list();
    expect(state.getState().box).toEqual({ o: 1, b: 2 });
    expect(log.map((bundle) => bundle.stageId)).toEqual(['start', 'other', 'fill']);

    const g = createRecordGraph([scope(log, { 'start#0': [], 'other#0': [], 'fill#0': ['box'] }) as never]);
    const node = (at: number) =>
      g.nodeId(address, { runtimeStageId: log[at].runtimeStageId, commitIdx: at, key: 'box' });
    const parents = await g.parents(node(2), ctx());
    expect(parents.edges.map((edge) => [edge.nodeId, edge.attribution]).sort()).toEqual(
      [
        [node(0), 'per-write'],
        [node(1), 'recorded-write'],
      ].sort(),
    );
    // And each parent names Fill's box among its children.
    expect((await g.children(node(0), ctx())).edges.map((edge) => edge.nodeId)).toContain(node(2));
    expect((await g.children(node(1), ctx())).edges.map((edge) => [edge.nodeId, edge.attribution])).toEqual([
      [node(2), 'recorded-write'],
    ]);
  });
});

describe('a read of one commit of a step, a fold onto another (the real writer)', () => {
  const frameOf = (state: SharedMemory, events: EventLog, address: string[] = []) => {
    const frame = new RecordFrame(state, events, address);
    frame.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix' });
    return frame;
  };
  const finish = (frame: RecordFrame, id: string, phase?: 'exit') => {
    frame.commit(() => ({ stage: id, stageId: id, runtimeStageId: `${id}#0`, ...(phase && { phase }) }));
    frame.release();
  };

  it('both commits are parents: the one the step read, and the one its write was folded onto', async () => {
    // P sets the box. C reads it. P commits again (its exit) and adds to the box. C adds to the box and
    // commits. C READ P's first commit, and C's write was FOLDED ONTO P's second. At the level of steps
    // that is one parent, P, and one edge. Here it is two nodes, and what P's second commit added is
    // in the box C left.
    const state = new SharedMemory(undefined, {});
    const events = new EventLog({});
    const p = frameOf(state, events);
    p.write(['box'], { p1: 1 }, 'set');
    finish(p, 'p');
    const c = frameOf(state, events);
    c.read([], 'box');
    c.noteRead([], 'box');
    const exit = frameOf(state, events);
    exit.write(['box'], { p2: 1 }, 'merge');
    finish(exit, 'p', 'exit');
    c.write(['box'], { c: 1 }, 'merge');
    finish(c, 'c');
    expect(state.getState().box).toEqual({ p1: 1, p2: 1, c: 1 });
    const log = events.list();
    expect(log.map((bundle) => `${bundle.runtimeStageId}${bundle.phase ? ` ${bundle.phase}` : ''}`)).toEqual([
      'p#0',
      'p#0 exit',
      'c#0',
    ]);

    const g = createRecordGraph([scope(log, { 'p#0': [], 'c#0': ['box'] }) as never]);
    const node = (at: number) =>
      g.nodeId(address, { runtimeStageId: log[at].runtimeStageId, commitIdx: at, key: 'box' });
    expect((await g.parents(node(2), ctx())).edges.map((edge) => [edge.nodeId, edge.attribution])).toEqual([
      [node(0), 'per-write'],
      [node(1), 'recorded-write'],
    ]);
    expect((await g.children(node(1), ctx())).edges.map((edge) => [edge.nodeId, edge.attribution])).toEqual([
      [node(2), 'recorded-write'],
    ]);
    expect((await g.parents(node(1), ctx())).edges.map((edge) => [edge.nodeId, edge.attribution])).toEqual([
      [node(0), 'recorded-write'],
    ]);

    // The cap on edges holds for this edge too: with room for one, the read's edge is there and the
    // node says that one was cut.
    const tight = createRecordGraph([scope(log, { 'p#0': [], 'c#0': ['box'] }) as never], { maxEdges: 1 });
    const cut = await tight.parents(tight.nodeId(address, { runtimeStageId: 'c#0', commitIdx: 2, key: 'box' }), ctx());
    expect(cut.edges.map((edge) => edge.attribution)).toEqual(['per-write']);
    expect(cut.complete).toBe(false);
    expect(
      (await tight.gaps(tight.nodeId(address, { runtimeStageId: 'c#0', commitIdx: 2, key: 'box' }), ctx())).map(
        (gap) => gap.code,
      ),
    ).toContain('edge-limit');
  });

  it('one edge per node: a read that only MAY have seen a write gives its place to the certain fold onto it', async () => {
    // C looks at the box, Q adds to it and commits, C looks at live state again and adds to the box.
    // Which value C read has two possible sources (P, Q). What C's write was folded onto is certain: Q.
    // Q is named once, and by the certain statement.
    const state = new SharedMemory(undefined, {});
    const events = new EventLog({});
    const p = frameOf(state, events);
    p.write(['box'], { p: 1 }, 'set');
    finish(p, 'p');
    const c = frameOf(state, events, ['runs', 'c']);
    c.read([], 'box');
    c.noteRead([], 'box');
    const q = frameOf(state, events);
    q.write(['box'], { q: 1 }, 'merge');
    finish(q, 'q');
    c.read([], 'box');
    c.write(['box'], { c: 1 }, 'merge');
    finish(c, 'c');
    const log = events.list();
    expect(log[2]).toMatchObject({ runtimeStageId: 'c#0', beganAt: 1, sawUntil: 2 });

    const g = createRecordGraph([scope(log, { 'p#0': [], 'q#0': [], 'c#0': ['box'] }) as never]);
    const node = (at: number) =>
      g.nodeId(address, { runtimeStageId: log[at].runtimeStageId, commitIdx: at, key: 'box' });
    const parents = await g.parents(node(2), ctx());
    expect(parents.edges.map((edge) => [edge.nodeId, edge.attribution])).toEqual([
      [node(0), 'per-write'],
      [node(1), 'recorded-write'],
    ]);
    // The read still has only possible sources, and the node says so.
    expect((await g.gaps(node(2), ctx())).map((gap) => gap.code)).toContain('conservative');
  });
});

describe('back and forward agree, commit by commit', () => {
  // Every log of up to four commits made of: a writer that may commit more than once (`w1`, `w2`), adding
  // to `k` or replacing it; and a reader, which reads `k` FIRST, then writes a key of its own and may also
  // add to `k` or replace it. For every node: each child has the node on its way back, and each parent
  // has the node on its way forward.
  //
  // The space is bounded on purpose, by two older facts of the graph that are not this change's:
  //   - a reader commits once: a later commit of a step is not another run of its reads;
  //   - no row here is on a path inside a key. The node of a path INSIDE a key lists the readers of the
  //     whole key among its children, and the way back from such a reader names the node of the whole
  //     key at that commit, not the node of the path (so that child has no way back to that node; the
  //     released version does the same). So this is a check of these logs, not a law of the graph. What
  //     IS a law, for the new edges alone, is in `built-on.property.test.ts` beside this file.
  type Step = { id: string; k?: 'merge' | 'set'; reads: boolean };
  const OPTIONS = (at: number): Step[] => [
    { id: 'w1', k: 'merge', reads: false },
    { id: 'w1', k: 'set', reads: false },
    { id: 'w2', k: 'merge', reads: false },
    { id: 'w2', k: 'set', reads: false },
    { id: `r${at}`, reads: true },
    { id: `r${at}`, k: 'merge', reads: true },
    { id: `r${at}`, k: 'set', reads: true },
  ];
  const bundleOf = (step: Step, at: number, first: boolean): CommitBundle => {
    const rows: Row[] = [];
    if (step.k) rows.push(['k', step.k, step.reads ? ['k'] : []]);
    if (step.reads) rows.push([`o${at}`, 'set', ['k']]);
    return {
      ...commit(step.id, at, rows),
      runtimeStageId: `${step.id}#0`,
      ...(first ? {} : { phase: 'repeat' as const }),
    };
  };

  async function disagreement(steps: Step[]): Promise<string | undefined> {
    const seen = new Set<string>();
    const log = steps.map((step, at) => {
      const first = !seen.has(step.id);
      seen.add(step.id);
      return bundleOf(step, at, first);
    });
    const reads = Object.fromEntries(steps.map((step) => [`${step.id}#0`, step.reads ? ['k'] : []]));
    const g = createRecordGraph([scope(log, reads) as never]);
    const nodes: string[] = [];
    const label = new Map<string, string>();
    log.forEach((bundle, at) => {
      for (const row of bundle.trace) {
        const id = g.nodeId(address, { runtimeStageId: bundle.runtimeStageId, commitIdx: at, key: row.path });
        nodes.push(id);
        label.set(id, `${bundle.stageId}@${at}.${row.path}`);
      }
    });
    const next = async (id: string, way: 'parents' | 'children') =>
      (await g[way](id, ctx())).edges.map((edge) => edge.nodeId);
    const closure = async (from: string, way: 'parents' | 'children') => {
      const reached = new Set<string>();
      const queue = [from];
      while (queue.length > 0) {
        for (const id of await next(queue.shift()!, way)) {
          if (reached.has(id)) continue;
          reached.add(id);
          queue.push(id);
        }
      }
      return reached;
    };
    const shape = steps.map((step) => `${step.id}:${step.k ?? '-'}${step.reads ? '+read' : ''}`).join(' ');
    for (const node of nodes) {
      for (const child of await next(node, 'children')) {
        if (!(await closure(child, 'parents')).has(node)) {
          return `[${shape}] ${label.get(child)} is a child of ${label.get(node)}, which is not on its way back`;
        }
      }
      for (const parent of await next(node, 'parents')) {
        if (!(await closure(parent, 'children')).has(node)) {
          return `[${shape}] ${label.get(parent)} is a parent of ${label.get(node)}, which is not on its way forward`;
        }
      }
    }
    return undefined;
  }

  it('for every log of up to four commits', async () => {
    let logs = 0;
    const grow = async (steps: Step[]): Promise<void> => {
      if (steps.length > 0) {
        logs++;
        expect(await disagreement(steps)).toBeUndefined();
      }
      if (steps.length === 4) return;
      for (const option of OPTIONS(steps.length)) await grow([...steps, option]);
    };
    await grow([]);
    expect(logs).toBe(7 + 7 ** 2 + 7 ** 3 + 7 ** 4);
  }, 120_000);
});
