/** New PROV-only fixtures; these never rewrite the established record/cause byte pins. */
export const recordContractSource = {
  initialState: { count: 0, items: [] },
  commitLog: [
    { runtimeStageId: 'seed#0', trace: [{ path: 'count', verb: 'set' }], overwrite: { count: 1 } },
    {
      runtimeStageId: 'grow#1',
      trace: [{ path: 'items', verb: 'append' }],
      overwrite: { items: [10] },
      tags: ['milestone:step'],
    },
    { runtimeStageId: 'forget#2', trace: [{ path: 'count', verb: 'delete' }], overwrite: { count: undefined } },
  ],
};

/** Engine-shaped evidence, not a claim that a real provider or engine was called. */
export const nativeCompoundSource = {
  address: { logRunId: 'fixture-run', drillPath: [] },
  initialState: { input: 5 },
  commitLog: [
    {
      stage: 'Choose route',
      stageId: 'decide',
      runtimeStageId: 'decide#0',
      trace: [{ path: 'choice', verb: 'set', readKeys: [] }],
      overwrite: { choice: 'GO_PRIVATE_PAYLOAD' },
    },
    {
      stage: 'Count',
      stageId: 'loop',
      runtimeStageId: 'loop#1',
      trace: [
        { path: 'count', verb: 'set', readKeys: ['choice'] },
        { path: 'count', verb: 'set', readKeys: ['choice'] },
      ],
      overwrite: { count: 2 },
    },
    {
      stage: 'Count',
      stageId: 'loop',
      runtimeStageId: 'loop#2',
      trace: [{ path: 'count', verb: 'set', readKeys: ['count'] }],
      overwrite: { count: 3 },
      untrackedSources: ['env'],
    },
    { stage: 'Mounted work', stageId: 'mount', runtimeStageId: 'mount#3', trace: [] },
    {
      stage: 'Mounted work',
      stageId: 'mount',
      runtimeStageId: 'mount#3',
      phase: 'exit',
      trace: [{ path: 'result', verb: 'set', readKeys: ['count'] }],
      overwrite: { result: 'EXTERNAL_RESULT_PRIVATE_PAYLOAD' },
    },
    {
      stage: 'Protect contact',
      stageId: 'protect',
      runtimeStageId: 'protect#4',
      trace: [{ path: 'private-contact\u001femail', verb: 'set', readKeys: ['result'] }],
      redactedPaths: ['private-contact'],
      overwrite: { 'private-contact': { email: 'SECRET_CUSTOMER_EMAIL' } },
    },
  ],
  controlDeps: { 'loop#1': { deciderId: 'decide#0' } },
  attention: { 'loop#2': [{ kind: 'retry', reason: 'RETRY_RECORDED', evidence: ['commit:2'] }] },
  subflowResults: {
    'mount#3': {
      address: { logRunId: 'fixture-run', drillPath: ['mount#3'] },
      commitLog: [{ runtimeStageId: 'mount#3/child#0', trace: [{ path: 'child-secret', verb: 'set' }] }],
    },
  },
};
