import { expect, it, vi } from 'vitest';
import { createRecordGraph, explain, type RecordScope } from '../../../cause.js';
import { gaps as admitGaps } from '../validation.js';

const address = { logRunId: 'fanout-evidence', drillPath: [] as string[] };
const runtimeStageId = 'fanout#0';
function fanout(count: number, collections = 1): RecordScope {
  const paths = Array.from({ length: collections }, (_, index) => (collections === 1 ? 'results' : 'results' + index));
  return {
    address,
    complete: true,
    reads: { [runtimeStageId]: [] },
    controlDeps: {},
    attention: { [runtimeStageId]: [{ kind: 'error', reason: 'ERROR_RECORDED', evidence: ['proof:fanout'] }] },
    commitLog: [
      {
        idx: 0,
        runtimeStageId,
        stageId: runtimeStageId,
        stage: runtimeStageId,
        trace: paths.map((path) => ({ path, verb: 'set' as const, readKeys: [] })),
        overwrite: Object.fromEntries(paths.map((path) => [path, Array.from({ length: count }, (_, index) => index)])),
        updates: {},
        redactedPaths: [],
      },
    ],
    subflows: {
      version: 1,
      status: 'captured',
      mounts: [],
      collections: paths.map((path) => ({
        version: 1,
        attribution: 'observed-scope-collection',
        parent: { address, runtimeStageId, commitIdx: 0, path },
        totalItems: count,
        branchCount: count,
        slots: Array.from({ length: count }, (_, index) => ({
          index,
          child: { address: { logRunId: address.logRunId, drillPath: [`branch#${index}`] }, beforeCommitIdx: 0 },
          observation: 'scope-snapshot' as const,
        })),
        status: 'captured',
        limitations: [],
      })),
    },
  };
}
function reader(scope: RecordScope, key?: string, widerScope = false) {
  const graph = createRecordGraph([scope], widerScope ? { maxScopes: 256, maxFields: 1000000 } : {});
  const selected = graph.nodeId(address, { runtimeStageId, commitIdx: 0, ...(key === undefined ? {} : { key }) });
  return { graph, selected };
}

for (const count of [14, 15, 16, 30, 31, 128]) {
  it(`a valid ${count}-slot fanout keeps admitted boundary reasons through public explain`, async () => {
    const { graph, selected } = reader(fanout(count), 'results', count > 32);
    const raw = await graph.gaps(selected, { signal: new AbortController().signal });
    expect(raw.some((gap) => gap.code === 'scope-boundary')).toBe(true);
    const result = await explain(graph, selected, { includeBackward: true });
    expect(result.gaps.some((gap) => gap.code === 'invalid-data')).toBe(false);
    const expected = [
      'subflow:collection:0',
      'commit:0',
      ...Array.from({ length: count }, (_, index) => `slot:${index}`),
    ];
    for (const channel of [raw, result.gaps, result.backward!.gaps]) {
      const references = channel.filter((gap) => gap.code === 'scope-boundary').flatMap((gap) => gap.evidence);
      expect([...new Set(references)]).toEqual(expected);
      expect(channel.length).toBeLessThanOrEqual(32);
      expect(channel.every((gap) => gap.evidence.length <= 16)).toBe(true);
      expect(channel.some((gap) => gap.code === 'truncated')).toBe(false);
    }
    expect(result.backward!.confidence).toBe('incomplete');
    expect(result.rootCause).toBeUndefined();
  });
}

it.each([false, true])(
  'keeps the native 32-row frontier honest when local coverage adds a gap (missing=%s)',
  async (missing) => {
    // Row admission is independent of elapsed CPU time under coverage; deadline behavior has separate tests.
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    try {
      // 384 boundary refs +128 conservative refs exactly fill32 admitted rows. Local unknown coverage needs a33rd.
      const scope = fanout(256, 127);
      if (missing) Reflect.deleteProperty(scope, 'attention');
      const { graph, selected } = reader(scope, undefined, true);
      const raw = await graph.gaps(selected, { signal: new AbortController().signal });
      expect(raw).toHaveLength(32);
      expect(admitGaps(raw)).toEqual(raw);
      expect(raw.some((gap) => gap.code === 'invalid-data')).toBe(false);
      expect(raw.some((gap) => gap.code === 'truncated')).toBe(missing);
      if (!missing) expect(raw.flatMap((gap) => gap.evidence)).toHaveLength(512);
      const result = await explain(graph, selected, { includeBackward: true });
      expect(result.gaps.some((gap) => gap.code === 'invalid-data')).toBe(false);
      expect(result.backward!.gaps.some((gap) => gap.code === 'truncated')).toBe(missing);
      expect(result.backward!.confidence).toBe('incomplete');
      expect(result.rootCause).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  },
);
