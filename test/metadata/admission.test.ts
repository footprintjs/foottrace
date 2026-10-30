import { describe, expect, it } from 'vitest';
import { readTraceMetadata, traceMetadata } from '../../src/metadata.js';

const scope = { sourceId: 's', runId: 'r', invocationId: null };
const row = () => ({ stage: 'stage', stageId: 's', runtimeStageId: 's#0', trace: [{ path: 'x' }] });
const input = () => ({ scope, addressBasis: 'projection-local', commits: [row()] });
const query = { scope, key: 'x', before: { commitIndex: 1, traceIndex: 0 } };
const fail = (value: unknown) => expect(() => readTraceMetadata(value)).toThrowError();

describe('metadata admission and query boundaries', () => {
  it.each([
    ['unknown row field', () => ({ ...input(), commits: [{ ...row(), overwrite: { x: 1 } }] })],
    ['unknown verb', () => ({ ...input(), commits: [{ ...row(), trace: [{ path: 'x', verb: 'replace' }] }] })],
    ['sparse commit array', () => ({ ...input(), commits: new Array(1) })],
    ['inherited fields', () => Object.create(input())],
    ['bad mapping length', () => ({ ...input(), originalCommitIndices: [] })],
    ['negative original index', () => ({ ...input(), originalCommitIndices: [-1] })],
    ['fractional original index', () => ({ ...input(), originalCommitIndices: [0.1] })],
    ['repeated original indices', () => ({ ...input(), commits: [row(), row()], originalCommitIndices: [1, 1] })],
    [
      'wrong invocation chain',
      () => ({ ...input(), scope: { ...scope, invocationId: 'child#1', invocationPath: ['other#1'] } }),
    ],
    [
      'future read anchor',
      () => ({
        ...input(),
        commits: [
          {
            ...row(),
            trace: [{ path: 'x', reads: { keys: [], kind: 'per-write', before: { commitIndex: 1, traceIndex: 0 } } }],
          },
        ],
      }),
    ],
    [
      'missing read anchor',
      () => ({ ...input(), commits: [{ ...row(), trace: [{ path: 'x', reads: { keys: [], kind: 'per-write' } }] }] }),
    ],
    [
      'unknown capture kind',
      () => ({
        ...input(),
        commits: [
          {
            ...row(),
            trace: [{ path: 'x', reads: { keys: [], kind: 'complete', before: { commitIndex: 0, traceIndex: 0 } } }],
          },
        ],
      }),
    ],
    ['overlong name', () => ({ ...input(), scope: { ...scope, sourceId: 'a'.repeat(1025) } })],
    [
      'too many path segments',
      () => ({ ...input(), commits: [{ ...row(), trace: [{ path: new Array(65).fill('a').join('\u001f') }] }] }),
    ],
    ['too many commits', () => ({ ...input(), commits: new Array(10001).fill(row()) })],
    ['too many trace rows', () => ({ ...input(), commits: [{ ...row(), trace: new Array(129).fill({ path: 'x' }) }] })],
    ['malformed suffix', () => ({ ...input(), commits: [row(), { ...row(), trace: [{ path: 1 }] }] })],
    ['nonboolean read override', () => ({ ...input(), readsAvailable: 'true' })],
  ] as const)('refuses %s atomically', (_, make) => fail(make()));

  it('never invokes an ordinary stored accessor, iterator, or toJSON', () => {
    let calls = 0;
    const first = input();
    Object.defineProperty(first.commits[0].trace[0], 'path', {
      get() {
        calls++;
        return 'x';
      },
    });
    fail(first);
    const second = input();
    Object.defineProperty(second.commits, Symbol.iterator, {
      value() {
        calls++;
        return [][Symbol.iterator]();
      },
    });
    fail(second);
    const third = input();
    Object.defineProperty(third, 'toJSON', {
      value() {
        calls++;
        return input();
      },
    });
    fail(third);
    expect(calls).toBe(0);
  });
  it('normalizes reflection failures without claiming to prevent Proxy traps', () => {
    let traps = 0;
    const proxy = new Proxy(input(), {
      ownKeys() {
        traps++;
        throw new Error('private text');
      },
    });
    expect(() => readTraceMetadata(proxy)).toThrow('TRACE_METADATA_UNAVAILABLE');
    expect(traps).toBe(1);
  });
  it('refuses forged handles and malformed query cutoffs', async () => {
    // @ts-expect-error an ordinary lookalike is not an admitted opaque handle
    await expect(traceMetadata({ kind: 'trace-metadata' }, query)).rejects.toMatchObject({ code: 'invalid-handle' });
    const handle = readTraceMetadata(input());
    for (const before of [
      { commitIndex: -1, traceIndex: 0 },
      { commitIndex: 2, traceIndex: 0 },
      { commitIndex: 1, traceIndex: 1 },
      { commitIndex: 0, traceIndex: 2 },
    ]) {
      await expect(traceMetadata(handle, { ...query, before })).rejects.toMatchObject({ code: 'invalid-data' });
    }
  });
  it('uses fixed named node, edge and work refusals rather than empty results', async () => {
    const two = { ...input(), commits: [row(), row()] };
    await expect(
      traceMetadata(readTraceMetadata(two), { ...query, before: { commitIndex: 2, traceIndex: 0 }, maxNodes: 1 }),
    ).rejects.toMatchObject({ code: 'node-limit' });
    await expect(traceMetadata(readTraceMetadata(input()), { ...query, maxWork: 1 })).rejects.toMatchObject({
      code: 'work-limit',
    });
    const reads = {
      ...input(),
      commits: [
        row(),
        row(),
        {
          ...row(),
          trace: [
            { path: 'out', reads: { keys: ['x'], kind: 'per-write', before: { commitIndex: 2, traceIndex: 0 } } },
          ],
        },
      ],
    };
    await expect(
      traceMetadata(readTraceMetadata(reads), {
        ...query,
        key: 'out',
        before: { commitIndex: 3, traceIndex: 0 },
        maxEdges: 1,
      }),
    ).rejects.toMatchObject({ code: 'edge-limit' });
  });
  it('names an existing traversal depth gap', async () => {
    const raw = {
      ...input(),
      commits: [
        row(),
        {
          ...row(),
          trace: [
            { path: 'out', reads: { keys: ['x'], kind: 'per-write', before: { commitIndex: 1, traceIndex: 0 } } },
          ],
        },
      ],
    };
    const result = await traceMetadata(readTraceMetadata(raw), {
      ...query,
      key: 'out',
      before: { commitIndex: 2, traceIndex: 0 },
      maxDepth: 0,
    });
    expect(result.gaps).toContainEqual({
      code: 'walk-incomplete',
      reason: 'depth-limit',
      at: { basis: 'projection-local', commitIndex: 1, traceIndex: 0 },
    });
  });
  it('a large valid suffix can refuse work but never become an earlier writer', async () => {
    const small = await traceMetadata(readTraceMetadata(input()), query);
    expect(small.selection).toHaveLength(1);
    const large = {
      ...input(),
      commits: [row(), ...new Array(1000).fill({ ...row(), trace: [{ path: 'unrelated' }] })],
    };
    await expect(traceMetadata(readTraceMetadata(large), { ...query, maxWork: 10 })).rejects.toMatchObject({
      code: 'work-limit',
    });
  });
  it('pins the smallest successful logical work boundary including result assembly', async () => {
    const empty = { scope, addressBasis: 'source-local', commits: [] };
    await expect(
      traceMetadata(readTraceMetadata(empty), { ...query, before: { commitIndex: 0, traceIndex: 0 }, maxWork: 5 }),
    ).rejects.toMatchObject({ code: 'work-limit' });
    const result = await traceMetadata(readTraceMetadata(empty), {
      ...query,
      before: { commitIndex: 0, traceIndex: 0 },
      maxWork: 6,
    });
    expect(result.selection).toEqual([]);
    expect(result.gaps.map((g) => g.code)).toEqual(['state-effect-unknown', 'origin-unknown']);
  });
  it('refuses unknown, accessor and over-limit query settings without running callbacks', async () => {
    let calls = 0;
    const bad = { ...query };
    Object.defineProperty(bad, 'key', {
      get() {
        calls++;
        return 'x';
      },
    });
    await expect(traceMetadata(readTraceMetadata(input()), bad)).rejects.toMatchObject({ code: 'invalid-data' });
    expect(calls).toBe(0);
    for (const extra of [
      { maxWork: 1000001 },
      { maxNodes: 10001 },
      { maxEdges: 100001 },
      { maxDepth: 1001 },
      { maxDepth: -1 },
      { maxNodes: 0 },
    ]) {
      await expect(traceMetadata(readTraceMetadata(input()), { ...query, ...extra })).rejects.toMatchObject({
        code: 'invalid-data',
      });
    }
  });
  it('keeps long public IDs/read keys outside the private graph protocol', async () => {
    const long = 'x'.repeat(1024),
      longScope = { sourceId: long, runId: long, invocationId: long, invocationPath: [long] };
    const raw = {
      scope: longScope,
      addressBasis: 'projection-local',
      commits: [
        { stage: long, stageId: long, runtimeStageId: long, trace: [{ path: long }] },
        {
          stage: long,
          stageId: long,
          runtimeStageId: long,
          trace: [
            { path: 'out', reads: { keys: [long], before: { commitIndex: 1, traceIndex: 0 }, kind: 'per-write' } },
          ],
        },
      ],
    };
    const result = await traceMetadata(readTraceMetadata(raw), {
      scope: longScope,
      key: 'out',
      before: { commitIndex: 2, traceIndex: 0 },
    });
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].key).toBe(long);
    expect(result.scope).toEqual(longScope);
    expect(result.gaps.some((g) => g.reason === 'invalid-data')).toBe(false);
  });
  it('retains empty commits instead of shifting occurrence addresses', async () => {
    const raw = { ...input(), commits: [{ ...row(), trace: [] }, row()] };
    const result = await traceMetadata(readTraceMetadata(raw), { ...query, before: { commitIndex: 2, traceIndex: 0 } });
    expect(result.selection[0].address.commitIndex).toBe(1);
  });
  it('applies the edge cap across all read keys, not once per key', async () => {
    const raw = {
      ...input(),
      commits: [
        { ...row(), trace: [{ path: 'x' }, { path: 'y' }] },
        {
          ...row(),
          trace: [
            { path: 'out', reads: { keys: ['x', 'y'], kind: 'per-write', before: { commitIndex: 1, traceIndex: 0 } } },
          ],
        },
      ],
    };
    await expect(
      traceMetadata(readTraceMetadata(raw), {
        ...query,
        key: 'out',
        before: { commitIndex: 2, traceIndex: 0 },
        maxEdges: 1,
      }),
    ).rejects.toMatchObject({ code: 'edge-limit' });
  });
  it('rejects cumulative string and path-segment overflow, not only individual rows', () => {
    fail({
      ...input(),
      commits: new Array(20).fill({ ...row(), trace: new Array(128).fill({ path: 'x'.repeat(1024) }) }),
    });
    fail({
      ...input(),
      commits: new Array(31).fill({
        ...row(),
        trace: new Array(128).fill({ path: new Array(64).fill('').join('\u001f') }),
      }),
    });
  });
});
