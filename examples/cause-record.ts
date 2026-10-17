/** Synthetic saved-record investigation: zero engine reruns, providers or model calls. */
import type { CommitBundle } from 'foottrace';

/** The optional reader can be loaded lazily from an ESM or CommonJS host. */
export async function causeRecordExample() {
  const { createRecordGraph, createStoredRecordGraph, explain } = await import('foottrace/cause');
  const address = { logRunId: 'example-run', drillPath: [] };
  const commitLog: CommitBundle[] = [
    {
      idx: 0,
      stage: 'Price',
      stageId: 'price',
      runtimeStageId: 'price#0',
      trace: [{ path: 'price', verb: 'set', readKeys: [] }],
      redactedPaths: [],
      overwrite: { price: 100 },
      updates: {},
    },
    {
      idx: 1,
      stage: 'Total',
      stageId: 'total',
      runtimeStageId: 'total#1',
      trace: [{ path: 'total', verb: 'set', readKeys: ['price'] }],
      redactedPaths: [],
      overwrite: { total: 120 },
      updates: {},
    },
  ];
  // An application rule supplies a fixed reason + proof IDs, never a customer value or raw error message.
  const attention = {
    'price#0': [{ kind: 'error', reason: 'BUSINESS_RULE_MATCHED' as const, evidence: ['rule:price-check'] }],
  };
  const memory = createRecordGraph([{ address, commitLog, attention, controlDeps: {}, complete: true }]);
  const total = memory.nodeId(address, { runtimeStageId: 'total#1', commitIdx: 1, key: 'total' });
  const local = await explain(memory, total);

  // The host owns storage/auth. A real adapter fetches ONLY this requested address and honours its signal.
  const stored = createStoredRecordGraph({
    loadLog: (requested, { signal }) => {
      if (signal.aborted) throw new Error('cancelled');
      return {
        entries: [
          { kind: 'opened', address: requested, at: 0, initialState: {} },
          ...commitLog.map((bundle) => ({ kind: 'commit', address: requested, at: 1, bundle })),
          { kind: 'closed', address: requested, at: 2, outcome: 'ok', commits: commitLog.length },
        ],
        attention,
        controlDeps: {},
      };
    },
  });
  // Discovery rejects with a fixed gap code if unavailable; a successful empty list means the loaded log was empty.
  await stored.openScope(address, { signal: new AbortController().signal });
  return {
    local,
    stored: await explain(stored, stored.nodeId(address, { runtimeStageId: 'total#1', commitIdx: 1, key: 'total' })),
  };
}
