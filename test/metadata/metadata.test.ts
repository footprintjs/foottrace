import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isCommitBundle, findLastWriter, type CommitBundle } from '../../src/index.js';
import { normaliseStateKey } from '../../src/paths.js';
import {
  readTraceMetadata,
  traceMetadata,
  type TraceMetadataInput,
  type TraceMetadataEntry,
  type TraceMetadataScope,
} from '../../src/metadata.js';

const scope: TraceMetadataScope = { sourceId: 'saved', runId: 'run-1', invocationId: 'child#8' };
const pos = (commitIndex: number, traceIndex = 0) => ({ commitIndex, traceIndex });
function input(rows: TraceMetadataEntry[][]): TraceMetadataInput {
  return {
    scope,
    addressBasis: 'projection-local',
    commits: rows.map((trace, i) => ({ stage: 'same label', stageId: 'same', runtimeStageId: `stage#${i}`, trace })),
  };
}
function ask(raw: TraceMetadataInput, key = 'x', before = pos(raw.commits.length), extra = {}) {
  return traceMetadata(readTraceMetadata(raw), { scope: raw.scope, key, before, ...extra });
}
const code = (value: { code: string }) => value.code;

describe('public value-free metadata query', () => {
  it('accepts the immutable real projection without manufacturing verbs or reads', async () => {
    const fixture = JSON.parse(
      readFileSync(new URL('../fixtures/metadata/projected-nested-main.json', import.meta.url), 'utf8'),
    );
    const original = JSON.stringify(fixture);
    const raw = {
      scope: { ...scope, invocationId: 'pipeline/prepare#8' },
      commits: fixture.commitLog,
      addressBasis: 'projection-local' as const,
      readsAvailable: fixture.scope.readsAvailable,
      startKeys: fixture.scope.startKeys,
    };
    const handle = readTraceMetadata(raw);
    const result = await traceMetadata(handle, { scope: raw.scope, key: 'total', before: pos(4) });
    expect(result.latestExact?.address).toEqual({ basis: 'projection-local', commitIndex: 3, traceIndex: 0 });
    expect(result.latestExact?.runtimeStageId).toBe('pipeline/prepare/total#12');
    expect(result.latestExact?.verb).toBeUndefined();
    expect(result.edges).toEqual([]);
    expect(result.gaps.map(code)).toContain('reads-unknown');
    expect(result.gaps.map(code)).toContain('original-address-unknown');
    expect(result.complete).toBe(false);
    expect(result.stateEffect).toBe('unknown');
    expect(isCommitBundle(handle)).toBe(false);
    expect(fixture.commitLog.every((row: unknown) => !isCommitBundle(row))).toBe(true);
    expect(JSON.stringify(fixture)).toBe(original);
  });
  it.each([undefined, 'set', 'merge', 'append', 'delete'] as const)(
    'retains older exact and overlapping candidates with last verb %s',
    async (verb) => {
      const raw = input([
        [{ path: 'x' }],
        [{ path: normaliseStateKey(['x', 'a']) }],
        [{ path: 'x', ...(verb ? { verb } : {}) }],
        [{ path: 'result', reads: { keys: ['x'], before: pos(3), kind: 'per-write' } }],
      ]);
      const result = await ask(raw, 'result');
      expect(result.edges.map((edge) => edge.to.commitIndex)).toEqual([0, 1, 2]);
      expect(result.nodes.map((node) => node.address.commitIndex)).toEqual([3, 0, 1, 2]);
      expect(result.stateEffect).toBe('unknown');
      expect(result.gaps.map(code)).toContain('overlapping-operation');
    },
  );
  it('honors same-commit exclusive read anchors and ignores future writes', async () => {
    const raw = input([
      [{ path: 'x' }],
      [{ path: 'x' }, { path: 'result', reads: { keys: ['x'], before: pos(1, 1), kind: 'per-write' } }, { path: 'x' }],
    ]);
    const result = await ask(raw, 'result');
    expect(result.edges.map((e) => [e.to.commitIndex, e.to.traceIndex])).toEqual([
      [0, 0],
      [1, 0],
    ]);
    expect(result.edges.every((e) => e.before.commitIndex === 1 && e.before.traceIndex === 1)).toBe(true);
    const prefix = await ask(raw, 'x', pos(1, 1));
    const extended = await ask(
      { ...raw, commits: [...raw.commits, { ...raw.commits[0], trace: [{ path: 'x' }] }] },
      'x',
      pos(1, 1),
    );
    expect(extended.selection).toEqual(prefix.selection);
    expect(extended.edges).toEqual(prefix.edges);
  });
  it('keeps stage, absent, empty and globally withheld reads distinct', async () => {
    const raw = input([[{ path: 'x' }], [{ path: 'out', reads: { keys: ['x'], before: pos(1), kind: 'stage' } }]]);
    expect((await ask(raw, 'out')).gaps.map(code)).toContain('stage-read-conservative');
    expect((await ask({ ...raw, readsAvailable: false }, 'out')).edges).toEqual([]);
    expect((await ask({ ...raw, readsAvailable: false }, 'out')).gaps.map(code)).toContain('reads-unknown');
    const empty = await ask(input([[{ path: 'out', reads: { keys: [], before: pos(0), kind: 'per-write' } }]]), 'out');
    expect(empty.nodes[0].reads).toBe('captured-empty');
    expect(empty.gaps.map(code)).not.toContain('reads-unknown');
    const absent = await ask({ ...input([[{ path: 'out' }]]), readsAvailable: true }, 'out');
    expect(absent.nodes[0].reads).toBe('unknown');
    expect(absent.gaps.map(code)).toContain('reads-unknown');
  });
  it('preserves local addresses and maps only explicitly supplied original commits', async () => {
    const raw = { ...input([[{ path: 'x' }], [{ path: 'x' }]]), originalCommitIndices: [5, 8] };
    const result = await ask(raw);
    expect(result.latestExact?.address).toEqual({
      basis: 'projection-local',
      commitIndex: 1,
      traceIndex: 0,
      originalCommitIndex: 8,
    });
    expect(result.gaps.map(code)).toContain('original-address-unknown');
  });
  it('keeps continued executions and repeated labels separate', async () => {
    const raw = input([[{ path: 'x' }], [{ path: 'x' }]]);
    const changed = {
      ...raw,
      commits: [
        raw.commits[0],
        { ...raw.commits[1], runtimeStageId: raw.commits[0].runtimeStageId, phase: 'repeat' as const },
      ],
    };
    const result = await ask(changed);
    expect(result.selection.map((n) => n.address.commitIndex)).toEqual([0, 1]);
    expect(result.selection[1].phase).toBe('repeat');
  });
  it.each(['sourceId', 'runId', 'invocationId'] as const)(
    'refuses a changed %s rather than binding another source',
    async (field) => {
      const raw = input([[{ path: 'x' }]]);
      await expect(
        traceMetadata(readTraceMetadata(raw), { scope: { ...scope, [field]: 'another' }, key: 'x', before: pos(1) }),
      ).rejects.toMatchObject({ code: 'scope-mismatch' });
    },
  );
  it('uses the canonical segment codec including literal dots and empty keys', async () => {
    const paths = ['a', 'ab', 'a.b', normaliseStateKey(['a', 'b']), '', normaliseStateKey(['', 'x'])];
    const raw = input(paths.map((path) => [{ path }]));
    expect((await ask(raw, 'a')).selection.map((n) => n.path)).toEqual(['a', normaliseStateKey(['a', 'b'])]);
    expect((await ask(raw, 'a.b')).selection.map((n) => n.path)).toEqual(['a.b']);
    expect((await ask(raw, '')).selection.map((n) => n.path)).toEqual(['', normaliseStateKey(['', 'x'])]);
  });
  it('does not infer initial values or origin from start keys', async () => {
    const result = await ask({ ...input([]), startKeys: ['x'] });
    expect(result.startKeyObserved).toBe(true);
    expect(result.selection).toEqual([]);
    expect(result.gaps.map(code)).toContain('origin-unknown');
    expect(result.stateEffect).toBe('unknown');
  });
  it('matches the existing last writer only as an exact occurrence, never a value claim', async () => {
    const raw = input([[{ path: 'x', verb: 'set' }], [{ path: 'x', verb: 'set' }]]);
    const full: CommitBundle[] = raw.commits.map((row, idx) => ({
      ...row,
      trace: [{ path: 'x', verb: 'set' as const }],
      overwrite: { x: 1 },
      updates: {},
      redactedPaths: [],
      idx,
    }));
    expect(full.every(isCommitBundle)).toBe(true);
    const result = await ask(raw);
    expect(result.latestExact?.address.commitIndex).toBe(full.indexOf(findLastWriter(full, 'x')!));
    expect(result.stateEffect).toBe('unknown');
  });
  it('detaches admitted data and freezes the entire exposed result', async () => {
    const raw = input([[{ path: 'x' }]]),
      handle = readTraceMetadata(raw);
    (raw.commits[0].trace[0] as { path: string }).path = 'changed';
    const result = await traceMetadata(handle, { scope, key: 'x', before: pos(1) });
    expect(result.selection[0].path).toBe('x');
    const visit = (v: unknown): void => {
      if (v && typeof v === 'object') {
        expect(Object.isFrozen(v)).toBe(true);
        for (const x of Object.values(v)) visit(x);
      }
    };
    visit(result);
    expect(() => {
      (result.nodes[0].address as { commitIndex: number }).commitIndex = 99;
    }).toThrow();
    expect((await traceMetadata(handle, { scope, key: 'x', before: pos(1) })).nodes[0].address.commitIndex).toBe(0);
  });
});
