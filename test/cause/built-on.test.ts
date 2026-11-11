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

  it('a first write that is a merge was folded onto the value from before the run: the node says a part has no source', async () => {
    const log = [commit('fill', 0, [['box', 'merge']]), commit('use', 1, [['final', 'set', ['box']]])];
    const answer = ask(log, { 'fill#0': [], 'use#1': ['box'] });
    expect(await answer.parents(0, 'box')).toEqual([]);
    expect(await answer.gaps(0, 'box')).toContain('untracked-input');
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

  it('the cap on edges counts the writes folded onto a node, and a cut is said', async () => {
    // Start's box is read by nobody; three bundles of ONE later step were folded onto it (a mount commits
    // its merge-back and then its exit; here three, to pass a cap of two).
    const log = [
      commit('start', 0, [['box', 'set']]),
      commit('mount', 1, [['box', 'merge']]),
      { ...commit('mount', 2, [['box', 'merge']]), runtimeStageId: 'mount#1', phase: 'exit' },
      { ...commit('mount', 3, [['box', 'merge']]), runtimeStageId: 'mount#1', phase: 'repeat' },
    ];
    const reads = { 'start#0': [], 'mount#1': [] };
    const roomy = createRecordGraph([scope(log, reads) as never]);
    const tight = createRecordGraph([scope(log, reads) as never], { maxEdges: 2 });
    const node = (g: typeof roomy) => g.nodeId(address, { runtimeStageId: 'start#0', commitIdx: 0, key: 'box' });
    expect((await roomy.children(node(roomy), ctx())).edges).toHaveLength(3);
    expect((await roomy.gaps(node(roomy), ctx())).map((gap) => gap.code)).toEqual([]);
    const cut = await tight.children(node(tight), ctx());
    expect(cut.edges).toHaveLength(2);
    expect(cut.complete).toBe(false);
    expect((await tight.gaps(node(tight), ctx())).map((gap) => gap.code)).toContain('edge-limit');
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
