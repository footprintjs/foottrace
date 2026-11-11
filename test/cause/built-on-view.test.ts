/**
 * The cause graph and a `set` row the writer built on the step's view (`TraceEntry.builtOnView`).
 *
 * A node of the graph is one commit's write of one key. `fill` merged into the box `start` had set
 * and also wrote a path inside it; the writer stored that as one `set` of the whole box. The row
 * says `set`, and it still holds what `start` wrote. Read as a replacement, the way back from a
 * reader of the box ended at `fill`. The writer marks such a row now, and the graph asks the one
 * rule what the commit's view held (`memory/builtOn.ts · readFromView`, through
 * `cause/recordBuiltOn.ts`): backward for parents, forward for children.
 *
 * The records here are built by hand and pass the door a record from outside passes, so each case
 * says exactly which rows and stamps it has. The same rule on logs the real writer made is in
 * `test/cause/built-on.property.test.ts` (both encodings) and `test/lib/memory/built-on-view.test.ts`.
 *
 * Test types: scenario (both adapters, and with exact read sources), boundary (a view with a write
 * of the key in its window, a step that also read the key, the cap on edges), security (a mark that
 * cannot be one; the cost of one question on a record made to be expensive).
 */
import { describe, expect, it } from 'vitest';

import { createRecordGraph, createStoredRecordGraph, explain } from '../../src/cause.js';
import type { RecordScope } from '../../src/cause.js';
import { queryWork } from '../../src/lib/memory/keyPaths.js';
import type { ReadSourceSnapshot } from '../../src/write.js';

const address = { logRunId: 'run', drillPath: [] };
const ctx = () => ({ signal: new AbortController().signal });
interface Row {
  path: string;
  verb: 'set' | 'merge' | 'append' | 'delete';
  readKeys?: string[];
  builtOnView?: unknown;
}
const set = (path: string, readKeys: string[] = []): Row => ({ path, verb: 'set', readKeys });
/** A `set` row the writer built on the step's view. */
const viewed = (path: string, readKeys: string[] = []): Row => ({ ...set(path, readKeys), builtOnView: true });
function commit(id: string, idx: number, rows: Row[], extra: object = {}) {
  return {
    idx,
    stage: id,
    stageId: id,
    runtimeStageId: `${id}#${idx}`,
    trace: rows,
    redactedPaths: [],
    overwrite: Object.fromEntries(rows.filter((row) => row.verb === 'set').map((row) => [row.path, idx])),
    updates: {},
    ...extra,
  };
}
type Log = ReturnType<typeof commit>[];
/** A bundle that says no index: its place is known only from the bundles around it. */
const unplaced = (id: string, at: number, rows: Row[], extra: object = {}) => {
  const { idx: _said, ...bundle } = commit(id, at, rows, extra);
  return bundle as unknown as Log[number];
};
/**
 * A record that does not show where a view sits. `start` says index 10, `other` says none, `fill`
 * says 13 and that its view was pinned when the log held 12 commits. `other` sits at 11 or at 12:
 * inside that view, or not.
 */
const placeNotShown = (fillRows: Row[] = [viewed('box')], extra: object = {}): Log => [
  { ...commit('start', 0, [set('box')]), idx: 10 },
  unplaced('other', 1, [set('box')]),
  { ...commit('fill', 2, fillRows, { viewAt: 12, ...extra }), idx: 13 },
];
/** start sets the box; fill's `set` of the box was built on its view (it read nothing); use reads the box. */
const builtOnTheView = (): Log => [
  commit('start', 0, [set('box')]),
  commit('fill', 1, [viewed('box')]),
  commit('use', 2, [set('final', ['box'])]),
];
const readsOf = (log: Log) =>
  Object.fromEntries(
    log.map((bundle) => [bundle.runtimeStageId, [...new Set(bundle.trace.flatMap((row) => row.readKeys ?? []))]]),
  );
const scope = (commitLog: Log, attention: object = {}) => ({
  address,
  commitLog,
  reads: readsOf(commitLog),
  attention,
  controlDeps: {},
  complete: true,
});
const stored = (commitLog: Log, attention: object = {}) => ({
  entries: [
    { kind: 'opened', address, at: 0, initialState: {} },
    ...commitLog.map((bundle) => ({ kind: 'commit', address, at: 0, bundle })),
    { kind: 'closed', address, at: 0, outcome: 'ok', commits: commitLog.length },
  ],
  reads: readsOf(commitLog),
  attention,
  controlDeps: {},
});
const ADAPTERS = {
  'a record in memory': (commitLog: Log, attention?: object, options?: object) =>
    createRecordGraph([scope(commitLog, attention) as never], options),
  'a stored record': (commitLog: Log, attention?: object, options?: object) =>
    createStoredRecordGraph({ loadLog: async () => stored(commitLog, attention) as never }, options),
};
const failure = { kind: 'error', reason: 'ERROR_RECORDED', evidence: ['test:failure'] } as const;

/** Ask one graph about a record: parents, children and gaps, each node named `step.key`. */
const askOf = (graphOf: (typeof ADAPTERS)[keyof typeof ADAPTERS]) => (commitLog: Log, options?: object) => {
  const g = graphOf(commitLog, undefined, options);
  const node = (at: number, key: string) =>
    g.nodeId(address, { runtimeStageId: commitLog[at].runtimeStageId, commitIdx: at, key });
  const named = (id: string) => {
    for (let at = 0; at < commitLog.length; at++)
      for (const row of commitLog[at].trace)
        if (id === node(at, row.path)) return `${commitLog[at].stageId}.${row.path}`;
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

describe.each(Object.entries(ADAPTERS))('the cause graph over %s', (_name, graphOf) => {
  const ask = askOf(graphOf);

  it('the finding: the box Fill left has the box Start wrote as its parent, for certain', async () => {
    const answer = ask(builtOnTheView());
    expect(await answer.parents(2, 'final')).toEqual(['fill.box (per-write)']);
    expect(await answer.parents(1, 'box')).toEqual(['start.box (recorded-write)']);
    expect(await answer.gaps(1, 'box')).toEqual([]);
  });

  it('forward is the inverse: Start names Fill, and only Fill (the row replaced the box in the fold)', async () => {
    const answer = ask(builtOnTheView());
    expect(await answer.children(0, 'box')).toEqual(['fill.box (recorded-write)']);
    expect(await answer.children(1, 'box')).toEqual(['use.final (per-write)']);
  });

  it('the same row without the mark is a replacement: no parent, no child (what every reader said before)', async () => {
    const log = builtOnTheView();
    log[1] = commit('fill', 1, [set('box')]);
    const answer = ask(log);
    expect(await answer.parents(1, 'box')).toEqual([]);
    expect(await answer.children(0, 'box')).toEqual([]);
  });

  it('explain: a failure in Start is the root cause of what Use wrote, through the row Fill left', async () => {
    const log = builtOnTheView();
    const g = graphOf(log, { 'start#0': [failure] });
    const node = (at: number, key: string) =>
      g.nodeId(address, { runtimeStageId: log[at].runtimeStageId, commitIdx: at, key });
    const finding = await explain(g, node(2, 'final'), { includeBackward: true });
    expect(finding.gaps).toEqual([]);
    expect(finding.confidence).toBe('complete');
    expect(finding.rootCause).toBe(node(0, 'box'));
    expect(finding.path).toEqual([node(2, 'final'), node(1, 'box'), node(0, 'box')]);
  });

  it('a view from before a sibling committed: the write the VIEW held is the parent, not the sibling', async () => {
    // start sets the box, other replaces it, fill commits a row built on a view pinned before other
    // committed (`viewAt: 1`: the log held one commit). In the fold fill's row replaced what other
    // wrote, and nothing of other's is in the box.
    const log = [
      commit('start', 0, [set('box')]),
      commit('other', 1, [set('box')]),
      commit('fill', 2, [viewed('box')], { viewAt: 1 }),
    ];
    const answer = ask(log);
    expect(await answer.parents(2, 'box')).toEqual(['start.box (recorded-write)']);
    expect(await answer.gaps(2, 'box')).toEqual([]);
    expect(await answer.children(0, 'box')).toEqual(['fill.box (recorded-write)']);
    expect(await answer.children(1, 'box')).toEqual([]);
  });

  it("a step that also READ the key keeps the edge it always had: one edge, the read's", async () => {
    const log = [
      commit('start', 0, [set('box')]),
      commit('fill', 1, [viewed('box', ['box'])]),
      commit('use', 2, [set('final', ['box'])]),
    ];
    const answer = ask(log);
    expect(await answer.parents(1, 'box')).toEqual(['start.box (per-write)']);
    expect(await answer.gaps(1, 'box')).toEqual([]);
    expect(await answer.children(0, 'box')).toEqual(['fill.box (per-write)']);
  });

  it('a step whose read is only possible and whose view is certain: the certain edge takes the place of the possible read', async () => {
    // Fill read the box and looked at state again after other committed, so its READ names both writes
    // as possible. Its view was pinned before other committed, so its ROW holds what start wrote, for
    // certain. The certain edge stands for start; other stays a possible source of the read.
    const log = [
      commit('start', 0, [set('box')]),
      commit('other', 1, [set('box')]),
      commit('fill', 2, [viewed('box', ['box'])], { beganAt: 1, sawUntil: 2, viewAt: 1 }),
    ];
    const answer = ask(log);
    expect(await answer.parents(2, 'box')).toEqual(['start.box (recorded-write)', 'other.box (per-write)']);
    expect(await answer.gaps(2, 'box')).toEqual(['conservative']);
  });

  it('a row that also added to an earlier commit of its own step names both: the fold and the view', async () => {
    // A row built on the view beside a merge of the same key cannot come from the writer (it stores one
    // `set`), and a record from outside can say it. Both rules answer, and each write is named once.
    const log = [
      commit('start', 0, [set('box')]),
      commit('fill', 1, [viewed('box'), { path: 'box\u001fin', verb: 'merge', readKeys: [] }]),
    ];
    const answer = ask(log);
    expect(await answer.parents(1, 'box')).toEqual(['start.box (recorded-write)']);
  });

  it('the cap on edges counts these children, and a cut is said', async () => {
    // Forward: three later commits each hold w0's box in a view pinned right after it, with room for two.
    const fan = [
      commit('w0', 0, [set('box')]),
      commit('v1', 1, [viewed('box')]),
      ...[2, 3].map((at) => commit(`v${at}`, at, [viewed('box')], { viewAt: 1 })),
    ];
    const forward = ask(fan, { maxEdges: 2 });
    expect(await forward.children(0, 'box')).toEqual(['v1.box (recorded-write)', 'v2.box (recorded-write)']);
    expect(await forward.gaps(0, 'box')).toContain('edge-limit');
  });

  it('a row inside the key, held by three later commits, with room for five: every edge is there and nothing is called cut', async () => {
    // The row's path (`box.in`) is not the node's key (`box`). Counted once as the forward walk's own
    // edge and once as this rule's, three children looked like six and the node said `edge-limit`
    // although every edge was listed (found by the second reader of this change).
    const inside = 'box\u001fin';
    const log = [
      commit('start', 0, [set('box')]),
      commit('v1', 1, [viewed(inside)]),
      ...[2, 3].map((at) => commit(`v${at}`, at, [viewed(inside)], { viewAt: 1 })),
    ];
    const g = graphOf(log, undefined, { maxEdges: 5 });
    const start = g.nodeId(address, { runtimeStageId: 'start#0', commitIdx: 0, key: 'box' });
    const children = await g.children(start, ctx());
    expect(children.edges).toHaveLength(3);
    expect(children.complete).toBe(true);
    expect((await g.gaps(start, ctx())).map((gap) => gap.code)).toEqual([]);
  });

  it.each([
    ['a value that is not the mark', { builtOnView: 'yes' }],
    ['false', { builtOnView: false }],
    ['the mark on a row that is not a set', { builtOnView: true, verb: 'merge' }],
  ])('%s refuses the record: a mark is never dropped, and never guessed', async (_name, damage) => {
    const log = builtOnTheView();
    log[1] = commit('fill', 1, [{ ...set('box'), ...damage } as Row]);
    const answer = ask(log);
    expect(await answer.parents(1, 'box')).toEqual([]);
    expect(await answer.gaps(1, 'box')).toEqual(['invalid-data']);
  });

  it.each([
    ['a view stamp that is not a whole number', [viewed('box')], { viewAt: '1' }],
    ['a view stamp at the commit itself', [viewed('box')], { viewAt: 2 }],
    ['a view stamp past the commit', [viewed('box')], { viewAt: 7 }],
    ['a view stamp on a bundle with no row built on the view', [set('box')], { viewAt: 1 }],
  ])('%s refuses the record: a stamp is never dropped', async (_name, rows, stamp) => {
    const log = [
      commit('start', 0, [set('box')]),
      commit('other', 1, [set('box')]),
      commit('fill', 2, rows as Row[], stamp),
    ];
    const answer = ask(log);
    expect(await answer.parents(2, 'box')).toEqual([]);
    expect(await answer.gaps(2, 'box')).toEqual(['invalid-data']);
  });
});

describe('a record in memory that does not show where a view sits', () => {
  // A stored record says the index of every bundle (its reader refuses one that does not), so a view
  // always has one place there. A record handed over in memory may hold bundles that say none: a
  // slice, or rows taken out. Then the place of a view is a range, and a write inside that range is a
  // possible source: never the certain one, never left out.
  const ask = askOf(ADAPTERS['a record in memory']);

  it('a record that does not show where the view sits: each write it could have held is a possible parent', async () => {
    // The view is one moment, so in an unbroken record it has one source. Here a bundle says no index
    // and could sit on either side of that moment. Both writes are named, and the node says that
    // neither is certain.
    const answer = ask(placeNotShown());
    expect(await answer.parents(2, 'box')).toEqual(['start.box (recorded-write)', 'other.box (recorded-write)']);
    expect(await answer.gaps(2, 'box')).toEqual(['conservative']);
    expect(await answer.children(0, 'box')).toEqual(['fill.box (recorded-write)']);
    expect(await answer.children(1, 'box')).toEqual(['fill.box (recorded-write)']);
  });

  it('a step whose read and whose view are both only possible: the reads keep their edges', async () => {
    // The view names the same two writes as the read and nothing more certain, so nothing takes a place.
    const answer = ask(placeNotShown([viewed('box', ['box'])], { beganAt: 11, sawUntil: 13 }));
    expect(await answer.parents(2, 'box')).toEqual(['start.box (per-write)', 'other.box (per-write)']);
    expect(await answer.gaps(2, 'box')).toEqual(['conservative']);
  });

  it('the cap on edges counts these parents, and a cut is said', async () => {
    // Four bundles say no index and sit where fill's view may or may not reach (indices 10, four
    // unknown, 20; the view at 15): five possible parents, and room for two.
    const hidden = (between: Log): Log => [
      { ...commit('w0', 0, [set('box')]), idx: 10 },
      ...between,
      { ...commit('fill', 5, [viewed('box')], { viewAt: 15 }), idx: 20 },
    ];
    const answer = ask(hidden([1, 2, 3, 4].map((at) => unplaced(`w${at}`, at, [set('box')]))), { maxEdges: 2 });
    expect(await answer.parents(5, 'box')).toEqual(['w0.box (recorded-write)', 'w1.box (recorded-write)']);
    expect(await answer.gaps(5, 'box')).toContain('edge-limit');
    // The same with four commits of ONE step in that place. Counted in steps that is two parents, which
    // fits. The graph answers in commits: five, with room for two, and it says that it cut.
    const sameStep = hidden([
      unplaced('m', 1, [set('box')]),
      ...[2, 3, 4].map((at) => ({ ...unplaced('m', at, [set('box')]), runtimeStageId: 'm#1', phase: 'repeat' })),
    ]);
    const cut = ask(sameStep, { maxEdges: 2 });
    expect(await cut.parents(5, 'box')).toHaveLength(2);
    expect(await cut.gaps(5, 'box')).toContain('edge-limit');
  });
});

describe('with exact read sources, which know of reads only', () => {
  const log = builtOnTheView();
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

  it('a record that does not show where the view sits: both writes are parents, and the node says neither is certain', async () => {
    const hidden = placeNotShown();
    const g = createRecordGraph([
      {
        ...scope(hidden),
        initialState: {},
        readSources: {
          record: { ...book, occurrences: [] },
          executions: hidden.map((bundle) => ({
            runtimeStageId: bundle.runtimeStageId,
            stateAddress: [],
            attemptIds: [`${bundle.runtimeStageId}@1`],
          })),
        },
      } as unknown as RecordScope,
    ]);
    const node = (at: number) =>
      g.nodeId(address, { runtimeStageId: hidden[at].runtimeStageId, commitIdx: at, key: 'box' });
    expect((await g.parents(node(2), ctx())).edges.map((edge) => [edge.nodeId, edge.attribution])).toEqual([
      [node(0), 'recorded-write'],
      [node(1), 'recorded-write'],
    ]);
    expect((await g.gaps(node(2), ctx())).map((gap) => gap.code)).toContain('conservative');
  });

  it('no read occurrence names what Fill built its row on; the mark does, both ways', async () => {
    const g = graph();
    const node = (at: number, key: string) =>
      g.nodeId(address, { runtimeStageId: log[at].runtimeStageId, commitIdx: at, key });
    expect((await g.parents(node(1, 'box'), ctx())).edges).toEqual([
      { nodeId: node(0, 'box'), kind: 'data', attribution: 'recorded-write', evidence: ['commit:0'] },
    ]);
    expect((await g.children(node(0, 'box'), ctx())).edges.map((edge) => [edge.nodeId, edge.attribution])).toEqual([
      [node(1, 'box'), 'recorded-write'],
    ]);
  });
});

describe('the cost of one question on a record made to be expensive', () => {
  // The widest answer the rule can be asked for. Every commit after the first holds a row built on the
  // view, and none but the first and the last says its index: nobody can tell where any of those views
  // sits, so every earlier write is a possible source of every later row. One question must still cost
  // the size of the log, not its square. Counted, not timed.
  const expensive = (size: number): Log => [
    commit('w0', 0, [set('k')]),
    ...Array.from({ length: size - 2 }, (_, at) => unplaced(`w${at + 1}`, at + 1, [viewed('k')], { viewAt: at })),
    { ...commit(`w${size - 1}`, size - 1, [viewed('k')], { viewAt: size - 2 }), idx: 10 * size },
  ];
  const workOf = async (size: number, question: 'parents' | 'children') => {
    const log = expensive(size);
    const g = createRecordGraph([scope(log) as never], { maxCommits: 4096, maxFields: 1_000_000 });
    // The second commit is in every later view's reach; the last commit's view could hold all before it.
    const at = question === 'children' ? 1 : size - 1;
    const id = g.nodeId(address, { runtimeStageId: log[at].runtimeStageId, commitIdx: at, key: 'k' });
    // The first question loads the scope. Ask once to have that done, then count the second.
    await g[question](id, ctx());
    const before = queryWork.units;
    const answer = await g[question](id, ctx());
    return { units: queryWork.units - before, edges: answer.edges.length, complete: answer.complete };
  };

  it.each(['children', 'parents'] as const)('%s: twice the log costs about twice the work', async (question) => {
    const small = await workOf(400, question);
    const large = await workOf(800, question);
    // The answer is cut at the cap on edges either way, and says so.
    expect(small).toMatchObject({ edges: 64, complete: false });
    expect(large).toMatchObject({ edges: 64, complete: false });
    expect(large.units / small.units).toBeLessThan(2.6);
  });
});
