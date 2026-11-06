/**
 * `createStoredRecordGraph` over a file that holds its own evidence: `reads`, `controlDeps` and `attention` come from the
 * file when the host omits them, `about` passes the adapter's admission, and notes no longer spend the commit cap.
 */
import { describe, expect, it, vi } from 'vitest';

import { createStoredRecordGraph, explain } from '../../src/cause.js';
import type { LogAddress } from '../../src/index.js';
import { engineScenario, evidenceStore, writeScenario } from '../helpers/evidenceFixture';

const ROOT: LogAddress = { logRunId: 'r', drillPath: [] };
const ctx = () => ({ signal: new AbortController().signal });

function whole() {
  const s = evidenceStore();
  s.commit(['r'], 'seed#0', {}, { trace: [{ path: 'k', verb: 'set' }], overwrite: { k: 1 } });
  s.commit(['r'], 'd#1', { parent: 'seed#0', reads: ['k'] });
  s.note(['r'], 'run.decision', { id: 'd#1', by: 'plain', chosen: 'b' });
  s.commit(
    ['r'],
    'b#2',
    {
      parent: 'd#1',
      reads: ['k'],
      attention: [{ kind: 'retried', reason: 'RETRY_RECORDED', evidence: ['attempt:b#2@1'] }],
    },
    { trace: [{ path: 'out', verb: 'set' }], overwrite: { out: 2 } },
  );
  s.close(['r']);
  return s.entries();
}

const nodeOf = (g: ReturnType<typeof createStoredRecordGraph>, id: string, idx: number, key?: string) =>
  g.nodeId(ROOT, { runtimeStageId: id, commitIdx: idx, ...(key ? { key } : {}) });

describe('the graph fills what the host omits', () => {
  it('reads, control and attention all come from the file: nothing reads not-collected', async () => {
    const g = createStoredRecordGraph({ loadLog: () => ({ entries: whole() }) });
    const node = nodeOf(g, 'b#2', 2);
    // Stage-level reads are conservative by their nature; per-write reads stay the dial's.
    expect((await g.gaps(node, ctx())).map((gap) => gap.code)).toEqual(['conservative']);
    expect((await g.attention(node, ctx())).map((mark) => mark.reason)).toEqual(['RETRY_RECORDED']);
    const parents = await g.parents(node, ctx());
    expect(parents.edges.filter((edge) => edge.kind === 'control').map((edge) => edge.attribution)).toEqual([
      'recorded-control',
    ]);
    expect(parents.edges.some((edge) => edge.kind === 'data' && edge.attribution === 'stage')).toBe(true);
  });

  it('answers why from the file alone: the same answer a host’s own maps give', async () => {
    const fromFile = createStoredRecordGraph({ loadLog: () => ({ entries: whole() }) });
    const fromHost = createStoredRecordGraph({
      loadLog: () => ({
        entries: whole(),
        reads: { 'seed#0': [], 'd#1': ['k'], 'b#2': ['k'] },
        controlDeps: { 'b#2': { deciderId: 'd#1' } },
        attention: { 'b#2': [{ kind: 'retried', reason: 'RETRY_RECORDED', evidence: ['attempt:b#2@1'] }] },
      }),
    });
    const node = nodeOf(fromFile, 'b#2', 2);
    const decider = nodeOf(fromFile, 'd#1', 1);
    expect((await fromFile.parents(node, ctx())).edges.map((edge) => edge.nodeId)).toContain(decider);
    expect(await explain(fromFile, node)).toEqual(await explain(fromHost, node));
  });

  it('a host’s own map wins, field by field', async () => {
    const g = createStoredRecordGraph({
      loadLog: () => ({ entries: whole(), attention: { 'b#2': [] }, controlDeps: {} }),
    });
    const node = nodeOf(g, 'b#2', 2);
    expect(await g.attention(node, ctx())).toEqual([]);
    expect((await g.parents(node, ctx())).edges.filter((edge) => edge.kind === 'control')).toEqual([]);
    // reads were omitted, so they are the file's.
    expect((await g.parents(node, ctx())).edges.some((edge) => edge.kind === 'data')).toBe(true);
  });

  it('a 1.11.1 file gives the same answers as before: not-collected, and no map is invented', async () => {
    const old = whole().map((entry) => {
      const copy = { ...entry } as Record<string, unknown>;
      delete copy.collects;
      delete copy.about;
      delete copy.runNotes;
      return copy;
    });
    const g = createStoredRecordGraph({ loadLog: () => ({ entries: old }) });
    const node = nodeOf(g, 'b#2', 2);
    expect((await g.gaps(node, ctx())).map((gap) => gap.code)).toContain('not-collected');
    expect(await g.attention(node, ctx())).toEqual([]);
    expect((await g.parents(node, ctx())).edges.filter((edge) => edge.kind === 'control')).toEqual([]);
  });

  it('a mount’s log says its chain leaves this scope: never ungoverned by accident', async () => {
    const s = evidenceStore();
    const address: LogAddress = { logRunId: 'r', drillPath: ['m#1'] };
    s.commit(['r', 'm#1'], 'm/in#2', { parent: 'm#1' });
    s.close(['r', 'm#1']);
    const g = createStoredRecordGraph({ loadLog: () => ({ entries: s.entries() }) });
    const gaps = await g.gaps(g.nodeId(address, { runtimeStageId: 'm/in#2', commitIdx: 0 }), ctx());
    expect(gaps.map((gap) => gap.code)).toContain('scope-boundary');
  });

  it('a stage whose reads were cut says so', async () => {
    const s = evidenceStore();
    s.commit(['r'], 'seed#0', { reads: ['a'], readsOmitted: 2 });
    s.close(['r']);
    const g = createStoredRecordGraph({ loadLog: () => ({ entries: s.entries() }) });
    expect((await g.gaps(nodeOf(g, 'seed#0', 0), ctx())).map((gap) => gap.code)).toContain('truncated');
  });

  it('a read list at the writer’s bound fits the graph’s admission', async () => {
    const s = evidenceStore();
    s.commit(['r'], 'seed#0', { reads: Array.from({ length: 256 }, (_, i) => `k${i}`) });
    s.close(['r']);
    const g = createStoredRecordGraph({ loadLog: () => ({ entries: s.entries() }) });
    await expect(g.openScope(ROOT, ctx())).resolves.toHaveLength(1);
  });

  it('a real run opens with its control filled: every governed execution is a child of its decider', async () => {
    const scenario = engineScenario('branches');
    const address: LogAddress = { logRunId: 'run-1', drillPath: [] };
    const entries = writeScenario(scenario).filter((entry) => entry.address.drillPath.length === 0);
    const g = createStoredRecordGraph({ loadLog: () => ({ entries }) });
    const commitIdx = entries
      .filter((entry) => entry.kind === 'commit')
      .findIndex((entry) => entry.kind === 'commit' && entry.bundle.runtimeStageId === 'income#8');
    const parents = await g.parents(g.nodeId(address, { runtimeStageId: 'income#8', commitIdx }), ctx());
    const control = parents.edges.filter((edge) => edge.kind === 'control');
    expect(control).toHaveLength(1);
    expect(control[0].nodeId).toContain('choose-checks#7');
  });
});

describe('admission', () => {
  const hostile = (about: unknown) => [
    { kind: 'opened', address: ROOT, at: 1, initialState: {}, collects: { v: 1, reads: 'keys' } },
    {
      kind: 'commit',
      address: ROOT,
      at: 1,
      about,
      bundle: {
        idx: 0,
        stage: 's',
        stageId: 's',
        runtimeStageId: 's#0',
        trace: [],
        redactedPaths: [],
        overwrite: {},
        updates: {},
      },
    },
    { kind: 'closed', address: ROOT, at: 1, outcome: 'ok', commits: 1, runNotes: 0 },
  ];

  it('an accessor on about never runs, and the row is refused while the commit stands', async () => {
    const get = vi.fn();
    const g = createStoredRecordGraph({
      loadLog: () => ({ entries: hostile(Object.defineProperty({}, 'reads', { get, enumerable: true })) }),
    });
    const gaps = await g.gaps(nodeOf(g, 's#0', 0), ctx());
    expect(get).not.toHaveBeenCalled();
    expect(gaps.map((gap) => gap.code)).toContain('invalid-data');
  });

  it('a row past a cap reads truncated, and a forged parent reads invalid-data, not a refused scope', async () => {
    for (const [about, code] of [
      [{ reads: Array.from({ length: 257 }, (_, i) => `k${i}`) }, 'truncated'],
      [{ parent: 's#9' }, 'invalid-data'],
    ] as const) {
      const g = createStoredRecordGraph({ loadLog: () => ({ entries: hostile(about) }) });
      expect((await g.gaps(nodeOf(g, 's#0', 0), ctx())).map((gap) => gap.code)).toContain(code);
    }
  });

  it('one field budget: evidence past it costs the evidence, and the commits still read', async () => {
    const s = evidenceStore();
    s.commit(['r'], 'seed#0', {});
    for (let i = 1; i <= 50; i++) s.note(['r'], 'run.stage', { id: `s#${i}`, parent: 'seed#0' });
    s.close(['r']);
    const g = createStoredRecordGraph({ loadLog: () => ({ entries: s.entries() }) }, { maxFields: 60 });
    const gaps = (await g.gaps(nodeOf(g, 'seed#0', 0), ctx())).map((gap) => gap.code);
    expect(gaps).toContain('truncated');
    await expect(g.openScope(ROOT, ctx())).resolves.toHaveLength(1);
  });
});

describe('the entry cap counts commits', () => {
  it('a log with many more notes than commits opens: notes are not commits', async () => {
    const s = evidenceStore();
    s.commit(['r'], 'seed#0', {});
    for (let i = 0; i < 2000; i++) s.logAt(['r']).note('attempt', { i });
    s.close(['r']);
    const g = createStoredRecordGraph({ loadLog: () => ({ entries: s.entries() }) });
    await expect(g.openScope(ROOT, ctx())).resolves.toHaveLength(1);
  });

  it('the commits themselves are still capped, redeliveries included', async () => {
    const s = evidenceStore();
    s.commit(['r'], 'seed#0', {});
    const [opened, commit] = s.entries();
    const entries = [opened, ...Array(16 * 4 + 17).fill(commit)];
    const g = createStoredRecordGraph({ loadLog: () => ({ entries }) }, { maxCommits: 16 });
    await expect(g.openScope(ROOT, ctx())).rejects.toMatchObject({ code: 'node-limit' });
  });

  it('every row still spends the field budget, so the row count stays bounded', async () => {
    const s = evidenceStore();
    s.commit(['r'], 'seed#0', {});
    for (let i = 0; i < 100; i++) s.logAt(['r']).note('attempt', { i });
    s.close(['r']);
    const g = createStoredRecordGraph({ loadLog: () => ({ entries: s.entries() }) }, { maxFields: 50 });
    await expect(g.openScope(ROOT, ctx())).rejects.toMatchObject({ code: 'node-limit' });
  });
});
