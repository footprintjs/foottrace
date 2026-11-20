// Coordinator probe: REAL engine records for the selected-path rule. Each variant, both encodings.
const { flowChart, FlowChartExecutor } = require('footprintjs');
const fs = require('node:fs');
const serve = (s, h) => {
  s.served = [
    ...(s.served ?? []),
    {
      kind: 'served',
      version: 1,
      consumer: 'consumer#1',
      served: [{ key: 'history', elements: [[0, h.length]] }, { key: 'profile' }],
    },
  ];
};
const rows = [
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
const variants = {
  'between: entry 1 replaced, cited field changed': {
    between: (s) => {
      const h = s.history;
      s.history = [h[0], 'tool result B, edited', ...h.slice(2)];
      s.profile = { ...s.profile, selected: 'silver' };
    },
  },
  'between: same values written again': {
    between: (s) => {
      s.history = [...s.history];
      s.profile = { ...s.profile };
    },
  },
  'call commit: appends its own message (the agent shape)': {
    consumer: (s) => {
      s.history = [...s.history, 'assistant message'];
    },
  },
  'call commit: rewrites entry 1 after serving it': {
    consumer: (s) => {
      const h = s.history;
      s.history = [h[0], 'rewritten by the call', ...h.slice(2)];
    },
  },
  'check commit: rewrites entry 1 itself': {
    door: (s) => {
      const h = s.history;
      s.history = [h[0], 'rewritten by the door', ...h.slice(2)];
    },
  },
  'check commit: appends only': {
    door: (s) => {
      s.history = [...s.history, 'the final answer'];
    },
  },
  'between: entry 1 deleted (list shortened to one)': {
    between: (s) => {
      s.history = [s.history[0]];
    },
  },
  'between: an entry inserted BEFORE entry 1': {
    between: (s) => {
      const h = s.history;
      s.history = ['inserted', ...h];
    },
  },
};
async function make(v, commitValues) {
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
        serve(s, h);
        s.draft = 'cites B';
        if (v.consumer) v.consumer(s);
      },
      'consumer',
    )
    .addFunction(
      'Between',
      (s) => {
        s.note = 'between';
        if (v.between) v.between(s);
      },
      'between',
    )
    .addFunction(
      'Door',
      (s) => {
        s.answer = 'the answer cites B';
        if (v.door) v.door(s);
        s.evidence = [...(s.evidence ?? []), ...rows];
      },
      'door',
    )
    .build();
  const ex = new FlowChartExecutor(chart, { commitValues, writeProvenance: 'reads-prefix' });
  await ex.run({ input: {} });
  const snap = ex.getSnapshot();
  return JSON.parse(JSON.stringify({ initialState: snap.initialState, commitLog: snap.commitLog }));
}
(async () => {
  const out = {};
  for (const [name, v] of Object.entries(variants)) {
    out[name] = { full: await make(v, 'full'), delta: await make(v, 'delta') };
    console.log(
      name,
      '| delta:',
      out[name].delta.commitLog.map((b) => b.trace.map((t) => t.verb + ' ' + t.path).join(',')).join(' | '),
    );
  }
  fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
})();
