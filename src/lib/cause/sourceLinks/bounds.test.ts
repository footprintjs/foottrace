import { describe, expect, it } from 'vitest';
import { createRecordGraph } from '../../../cause.js';
import type { CommitBundle } from '../../memory/types.js';
import type { RecordScope } from '../recordTypes.js';
import type { RecordSourceLink, ServedRow, SourceLinkRow } from './types.js';
import { RecordRefusal, recordRefusalCode } from '../recordValidation.js';
import { sourceLinkReplay } from './replay.js';
import { resolveLink } from './resolve.js';

const address = { logRunId: 'counted-source-links', drillPath: [] };
const context = () => ({ signal: new AbortController().signal });

function bundle(idx: number, stage: string, overwrite: Record<string, unknown>, tail = false): CommitBundle {
  return {
    idx,
    runtimeStageId: stage,
    stageId: stage,
    stage,
    overwrite,
    updates: {},
    redactedPaths: [],
    trace: Object.keys(overwrite).map((path) => ({ path, verb: tail ? 'append' : 'set' })),
  };
}

function growing(appends: number, batch: number) {
  const input = { key: 'history', element: appends * batch - 1 };
  const output = { key: 'answer', checkedIn: 'written' } as const;
  const served: ServedRow = {
    kind: 'served',
    version: 1,
    consumer: 'consumer',
    served: [{ key: input.key, elements: [[0, input.element + 1]] }],
  };
  const witness: SourceLinkRow = {
    kind: 'source-link',
    version: 1,
    linkBasis: 'reference',
    check: 'redeemed',
    consumer: 'consumer',
    output,
    input,
  };
  const log = Array.from({ length: appends }, (_, index) =>
    bundle(index, 'append', { history: Array.from({ length: batch }, (_, element) => index * batch + element) }, true),
  );
  log.push(bundle(appends, 'consumer', { served: [served] }));
  log.push(bundle(appends + 1, 'door', { answer: 'answer', evidence: [witness] }));
  const link: RecordSourceLink = {
    linkBasis: 'reference',
    check: 'redeemed',
    consumer: { runtimeStageId: 'consumer' },
    input,
    output: { ...output, runtimeStageId: 'door', commitIdx: appends + 1 },
    served: { key: 'served' },
    witness: { runtimeStageId: 'door', commitIdx: appends + 1, key: 'evidence', element: 0 },
  };
  const scope: RecordScope = {
    address,
    commitLog: log,
    initialState: {},
    reads: {},
    controlDeps: {},
    attention: {},
    complete: true,
    sourceLinks: { version: 1, status: 'captured', limitations: [], links: [link] },
  };
  return { log, link, scope };
}

const maximum = 1000000;

async function parents(scope: RecordScope, output: RecordSourceLink['output']) {
  const graph = createRecordGraph([scope], {
    maxCommits: 4096,
    maxFields: maximum,
    sourceLinkPolicy: () => true,
  });
  return graph.parents(graph.nodeId(address, output), context());
}

describe('source-link replay work remains bounded', () => {
  it('truncates the admitted 300,000-entry shape without changing recorded adjacency', async () => {
    const { scope, link } = growing(1500, 200);
    const baseline = await parents({ ...scope, sourceLinks: undefined }, link.output);
    const { sourceLinks, sourceLinkGaps, ...recorded } = await parents(scope, link.output);
    expect(recorded).toEqual(baseline);
    expect(sourceLinks).toBeUndefined();
    expect(sourceLinkGaps).toEqual([{ code: 'truncated' }]);
  });

  it('fits a 4,096-commit run of small appends and counts the used allowance', async () => {
    const { scope, log, link } = growing(4094, 2);
    expect((await parents(scope, link.output)).sourceLinks?.[0].standing).toBe('witnessed');
    const budget = { left: maximum };
    const result = resolveLink(
      link,
      address,
      context(),
      () => true,
      (write) => write.key,
      () => sourceLinkReplay({ base: {}, log }, budget),
    );
    expect(result.link?.standing).toBe('witnessed');
    expect(maximum - budget.left).toBeLessThan(350000);
    console.log('Source-link replay units for 4096 commits:', maximum - budget.left);
  });

  it('refuses oversized copy-on-write generations before doing the copy', () => {
    const budget = { left: 20000 };
    const base = { history: Array.from({ length: 50 }, () => ({ note: 'x'.repeat(100) })) };
    const log = [bundle(0, 'nested', { history: [{ note: 'new' }] })];
    log[0].trace = [{ path: 'history\u001f0\u001fnote', verb: 'set' }];
    const replay = sourceLinkReplay({ log, base }, budget);
    try {
      replay.resolves({ key: 'history', element: 0, pointer: '/note' }, 0);
      throw new Error('expected the replay budget to refuse the copy');
    } catch (error) {
      expect(recordRefusalCode(error)).toBe('node-limit');
      expect(error).toBeInstanceOf(RecordRefusal);
    }
  });
});
