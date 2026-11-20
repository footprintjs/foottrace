// Coordinator probe: how does the REAL engine record a list union ($update on a list, and on an object holding a list), in both encodings?
const { flowChart, FlowChartExecutor } = require('footprintjs');
const fs = require('node:fs');
const rows = [
  {
    kind: 'source-link',
    version: 1,
    linkBasis: 'reference',
    check: 'redeemed',
    consumer: 'consumer#2',
    output: { key: 'answer', checkedIn: 'written' },
    input: { key: 'tags', element: 2 },
  },
  {
    kind: 'source-link',
    version: 1,
    linkBasis: 'reference',
    check: 'redeemed',
    consumer: 'consumer#2',
    output: { key: 'answer', checkedIn: 'written' },
    input: { key: 'profile', pointer: '/tags/1' },
  },
  {
    kind: 'source-link',
    version: 1,
    linkBasis: 'reference',
    check: 'redeemed',
    consumer: 'consumer#2',
    output: { key: 'answer', checkedIn: 'written' },
    input: { key: 'profile', pointer: '/selected' },
  },
];
async function make(first, commitValues, how) {
  const chart = flowChart(
    'Load',
    (s) => {
      s.tags = [first];
      s.profile = { selected: 'gold', tags: [first] };
    },
    'load',
  )
    .addFunction(
      'Grow',
      (s) => {
        if (how === 'update') {
          s.$update('tags', ['b', 'c']);
          s.$update('profile', { tags: ['b', 'c'] });
        } else {
          s.tags = [...s.tags, 'b', 'c'];
          s.profile = { ...s.profile, tags: [...s.profile.tags, 'b', 'c'] };
        }
      },
      'grow',
    )
    .addFunction(
      'Consumer',
      (s) => {
        s.served = [
          ...(s.served ?? []),
          {
            kind: 'served',
            version: 1,
            consumer: 'consumer#2',
            served: [{ key: 'tags', elements: [[0, 3]] }, { key: 'profile' }],
          },
        ];
        s.draft = 'd';
      },
      'consumer',
    )
    .addFunction(
      'Door',
      (s) => {
        s.answer = 'a';
        s.evidence = [...(s.evidence ?? []), ...rows];
      },
      'door',
    )
    .build();
  const ex = new FlowChartExecutor(chart, { commitValues, writeProvenance: 'reads-prefix' });
  await ex.run({ input: {} });
  const snap = ex.getSnapshot();
  return JSON.parse(
    JSON.stringify({
      initialState: snap.initialState,
      commitLog: snap.commitLog,
      final: { tags: snap.sharedState.tags, profileTags: snap.sharedState.profile.tags },
    }),
  );
}
(async () => {
  const out = {};
  for (const how of ['update', 'assign'])
    for (const commitValues of ['full', 'delta'])
      for (const first of ['a', 'b']) {
        const r = await make(first, commitValues, how);
        out[`${how}/${commitValues}/${first}`] = r;
        if (first === 'a')
          console.log(
            how,
            commitValues,
            '| grow commit:',
            JSON.stringify(r.commitLog[1].trace.map((t) => t.verb + ' ' + t.path)),
            '| overwrite keys',
            Object.keys(r.commitLog[1].overwrite),
            '| updates',
            JSON.stringify(r.commitLog[1].updates).slice(0, 90),
            '| final',
            JSON.stringify(r.final),
          );
        else console.log('    with first entry "b": final', JSON.stringify(r.final));
      }
  fs.writeFileSync(process.argv[2], JSON.stringify(out));
})().catch((e) => {
  console.log('FAILED', String(e).slice(0, 300));
});
