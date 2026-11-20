// Coordinator probe: a REAL engine record where the list is appended to BETWEEN the model-call stage and the check, in both encodings.
const { flowChart, FlowChartExecutor } = require('footprintjs');
const fs = require('node:fs');
async function make(commitValues) {
  const chart = flowChart(
    'Load',
    (s) => {
      s.history = ['tool result A', 'tool result B'];
      s.profile = { selected: 'gold', other: '' };
    },
    'load',
  )
    .addFunction(
      'Consumer',
      (s) => {
        const h = s.history;
        const p = s.profile;
        s.served = [
          ...(s.served ?? []),
          {
            kind: 'served',
            version: 1,
            consumer: 'consumer#1',
            served: [{ key: 'history', elements: [[0, h.length]] }, { key: 'profile' }],
          },
        ];
        s.draft = 'cites B and ' + p.selected;
      },
      'consumer',
    )
    .addFunction(
      'Append',
      (s) => {
        s.history = [...s.history, 'assistant proposal'];
      },
      'append',
    )
    .addFunction(
      'Sibling',
      (s) => {
        s.profile = { ...s.profile, other: 'changed later' };
      },
      'sibling',
    )
    .addFunction(
      'Door',
      (s) => {
        s.answer = 'the answer cites B';
        s.evidence = [
          ...(s.evidence ?? []),
          {
            kind: 'source-link',
            version: 1,
            linkBasis: 'reference',
            check: 'redeemed',
            consumer: 'consumer#1',
            output: { key: 'answer', checkedIn: 'written' },
            input: { key: 'history', element: 1 },
          },
          {
            kind: 'source-link',
            version: 1,
            linkBasis: 'reference',
            check: 'redeemed',
            consumer: 'consumer#1',
            output: { key: 'answer', checkedIn: 'written' },
            input: { key: 'profile', pointer: '/selected' },
          },
          {
            kind: 'source-link',
            version: 1,
            linkBasis: 'reference',
            check: 'redeemed',
            consumer: 'consumer#1',
            output: { key: 'answer', checkedIn: 'written' },
            input: { key: 'profile' },
          },
        ];
      },
      'door',
    )
    .build();
  const ex = new FlowChartExecutor(chart, { commitValues, writeProvenance: 'reads-prefix' });
  await ex.run({ input: {} });
  const snap = ex.getSnapshot();
  return JSON.parse(
    JSON.stringify({ commitValues: snap.commitValues, initialState: snap.initialState, commitLog: snap.commitLog }),
  );
}
(async () => {
  const out = { full: await make('full'), delta: await make('delta') };
  fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
  for (const [m, r] of Object.entries(out))
    console.log(
      m,
      r.commitLog.map((b) => b.runtimeStageId + ':' + b.trace.map((t) => t.verb + ' ' + t.path).join(',')).join(' | '),
    );
})();
