// Coordinator probe, step 1: a REAL engine record (footprintjs 14.0.0) with served rows and witness rows, in both encodings.
// Run where `footprintjs` 14 is installed:  node make-real-engine-record.cjs out.json
const { flowChart, FlowChartExecutor } = require('footprintjs');
const fs = require('node:fs');
async function make(commitValues) {
  const served = (consumer, ranges) => ({
    kind: 'served',
    version: 1,
    consumer,
    served: [{ key: 'history', elements: ranges }],
  });
  const link = (consumer, outKey, checkedIn, element) => ({
    kind: 'source-link',
    version: 1,
    linkBasis: 'reference',
    check: 'redeemed',
    consumer,
    output: { key: outKey, checkedIn },
    input: { key: 'history', element },
  });
  const chart = flowChart(
    'Load',
    (s) => {
      s.history = ['tool result A', 'tool result B'];
    },
    'load',
  )
    .addFunction(
      'Consumer',
      (s) => {
        const h = s.history;
        s.served = [...(s.served ?? []), served('consumer#1', [[0, h.length]])];
        s.draft = 'cites B';
      },
      'consumer',
    )
    .addFunction(
      'Door',
      (s) => {
        s.answer = 'the answer cites B';
        s.evidence = [...(s.evidence ?? []), link('consumer#1', 'answer', 'written', 1)];
      },
      'door',
    )
    .addFunction(
      'More',
      (s) => {
        s.history = [...s.history, 'tool result C'];
      },
      'more',
    )
    .addFunction(
      'Consumer2',
      (s) => {
        const h = s.history;
        s.served = [...(s.served ?? []), served('consumer2#4', [[0, h.length]])];
        s.answer2 = 'second answer cites C';
      },
      'consumer2',
    )
    .addFunction(
      'Audit',
      (s) => {
        const a = s.answer2;
        s.evidence = [...(s.evidence ?? []), link('consumer2#4', 'answer2', 'read', 2)];
        s.audited = a.length;
      },
      'audit',
    )
    .build();
  const ex = new FlowChartExecutor(chart, { commitValues, writeProvenance: 'reads-prefix' });
  await ex.run({ input: {} });
  const snap = ex.getSnapshot();
  const reads = {};
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (n.runtimeStageId && n.stageReads) reads[n.runtimeStageId] = Object.keys(n.stageReads);
    for (const k of ['next', 'children']) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else walk(v);
    }
  })(snap.executionTree);
  return JSON.parse(
    JSON.stringify({
      commitValues: snap.commitValues,
      initialState: snap.initialState,
      commitLog: snap.commitLog,
      reads,
    }),
  );
}
(async () => {
  fs.writeFileSync(process.argv[2], JSON.stringify({ full: await make('full'), delta: await make('delta') }, null, 1));
})();
