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

describe.each(Object.entries(ADAPTERS))('the cause graph over %s', (_name, graphOf) => {
  const ask = (commitLog: Log, options?: object) => {
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
    // committed (`beganAt: 1`: the log held one commit). In the fold fill's row replaced what other
    // wrote, and nothing of other's is in the box.
    const log = [
      commit('start', 0, [set('box')]),
      commit('other', 1, [set('box')]),
      commit('fill', 2, [viewed('box')], { beganAt: 1 }),
    ];
    const answer = ask(log);
    expect(await answer.parents(2, 'box')).toEqual(['start.box (recorded-write)']);
    expect(await answer.gaps(2, 'box')).toEqual([]);
    expect(await answer.children(0, 'box')).toEqual(['fill.box (recorded-write)']);
    expect(await answer.children(1, 'box')).toEqual([]);
  });

  it('a view with a write of the key in its window: each write it could have held is a possible parent', async () => {
    // The same run, and fill's step looked at state again after other committed (`sawUntil: 2`). The
    // record does not say which look the row was built on, so both writes are named and the node says
    // that neither is certain.
    const log = [
      commit('start', 0, [set('box')]),
      commit('other', 1, [set('box')]),
      commit('fill', 2, [viewed('box')], { beganAt: 1, sawUntil: 2 }),
    ];
    const answer = ask(log);
    expect(await answer.parents(2, 'box')).toEqual(['start.box (recorded-write)', 'other.box (recorded-write)']);
    expect(await answer.gaps(2, 'box')).toEqual(['conservative']);
    expect(await answer.children(0, 'box')).toEqual(['fill.box (recorded-write)']);
    expect(await answer.children(1, 'box')).toEqual(['fill.box (recorded-write)']);
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

  it('a step that also read the key, with a write of it in its window: the possible reads keep their edges', async () => {
    // Fill read the box, and looked at state again after other committed. Its read already names both
    // writes as possible sources. The view names the same two and nothing more certain, so the read's
    // edges stay as they are.
    const log = [
      commit('start', 0, [set('box')]),
      commit('other', 1, [set('box')]),
      commit('fill', 2, [viewed('box', ['box'])], { beganAt: 1, sawUntil: 2 }),
    ];
    const answer = ask(log);
    expect(await answer.parents(2, 'box')).toEqual(['start.box (per-write)', 'other.box (per-write)']);
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

  it('the cap on edges counts these parents and children, and a cut is said', async () => {
    // Five writes of the box sit in fill's window: six possible parents, and room for two.
    const log = [
      ...[0, 1, 2, 3, 4, 5].map((at) => commit(`w${at}`, at, [set('box')])),
      commit('fill', 6, [viewed('box')], { beganAt: 1, sawUntil: 6 }),
    ];
    const answer = ask(log, { maxEdges: 2 });
    expect(await answer.parents(6, 'box')).toEqual(['w0.box (recorded-write)', 'w1.box (recorded-write)']);
    expect(await answer.gaps(6, 'box')).toContain('edge-limit');
    // Four of the possible parents are commits of ONE step. Counted in steps that is two parents, which
    // fits. The graph answers in commits: five, with room for two, and it says that it cut.
    const sameStep = [
      commit('w0', 0, [set('box')]),
      commit('m', 1, [set('box')]),
      ...[2, 3, 4].map((at) => ({ ...commit('m', at, [set('box')]), runtimeStageId: 'm#1', phase: 'repeat' })),
      commit('fill', 5, [viewed('box')], { beganAt: 1, sawUntil: 5 }),
    ];
    const cut = ask(sameStep, { maxEdges: 2 });
    expect(await cut.parents(5, 'box')).toHaveLength(2);
    expect(await cut.gaps(5, 'box')).toContain('edge-limit');
    // Forward: three later commits each hold w0's box in a view pinned right after it, with room for two.
    const fan = [
      commit('w0', 0, [set('box')]),
      commit('v1', 1, [viewed('box')]),
      ...[2, 3].map((at) => commit(`v${at}`, at, [viewed('box')], { beganAt: 1 })),
    ];
    const forward = ask(fan, { maxEdges: 2 });
    expect(await forward.children(0, 'box')).toEqual(['v1.box (recorded-write)', 'v2.box (recorded-write)']);
    expect(await forward.gaps(0, 'box')).toContain('edge-limit');
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

  it('a view with a write of the key in its window: both writes are parents, and the node says neither is certain', async () => {
    const windowed = [
      commit('start', 0, [set('box')]),
      commit('other', 1, [set('box')]),
      commit('fill', 2, [viewed('box')], { beganAt: 1, sawUntil: 2 }),
    ];
    const g = createRecordGraph([
      {
        ...scope(windowed),
        initialState: {},
        readSources: {
          record: { ...book, occurrences: [] },
          executions: windowed.map((bundle) => ({
            runtimeStageId: bundle.runtimeStageId,
            stateAddress: [],
            attemptIds: [`${bundle.runtimeStageId}@1`],
          })),
        },
      } as unknown as RecordScope,
    ]);
    const node = (at: number) =>
      g.nodeId(address, { runtimeStageId: windowed[at].runtimeStageId, commitIdx: at, key: 'box' });
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
  // Every commit after the first carries a marked row on one key and a window over the whole log. That
  // is the widest answer the rule can be asked for: every earlier write is a possible source of every
  // later row. One question must still cost the size of the log, not its square. Counted, not timed.
  const expensive = (size: number): Log => [
    commit('w0', 0, [set('k')]),
    ...Array.from({ length: size - 1 }, (_, at) =>
      commit(`w${at + 1}`, at + 1, [viewed('k')], { beganAt: 0, sawUntil: at + 1 }),
    ),
  ];
  const workOf = async (size: number, question: 'parents' | 'children') => {
    const log = expensive(size);
    const g = createRecordGraph([scope(log) as never], { maxCommits: 4096, maxFields: 1_000_000 });
    const at = question === 'children' ? 0 : size - 1;
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
