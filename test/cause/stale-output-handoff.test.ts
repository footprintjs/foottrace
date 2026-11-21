import { describe, expect, it } from 'vitest';
import { createRecordGraph } from '../../src/cause.js';
import type { RecordScope } from '../../src/cause.js';
import { DELIM } from '../../src/lib/record-paths/codec.js';
import { recordRun } from '../helpers/recordRun.js';

const parent = { logRunId: 'run', drillPath: [] as string[] };
const child = { logRunId: 'run', drillPath: ['mount#1'] };
const context = () => ({ signal: new AbortController().signal });
const cases = [
  { name: 'exact repeat', mapped: ['final'], later: ['final'], stale: true },
  { name: 'repeat writes a descendant', mapped: ['final'], later: ['final', 'part'], stale: true },
  { name: 'repeat writes an ancestor', mapped: ['final', 'part'], later: ['final'], stale: true },
  { name: 'repeat writes a different key', mapped: ['final'], later: ['other'], stale: false },
  { name: 'repeat writes a sibling', mapped: ['final', 'part'], later: ['final', 'sibling'], stale: false },
  { name: 'repeat writes a dotted literal', mapped: ['final', 'part'], later: ['final.part'], stale: false },
  { name: 'repeat rewrites the same dotted literal', mapped: ['final.part'], later: ['final.part'], stale: true },
  { name: 'different visit to the same stage', mapped: ['final'], later: ['final'], otherVisit: true, stale: false },
  { name: 'same execution exits', mapped: ['final'], later: ['final'], exit: true, stale: false },
  { name: 'one of two mapped paths is stale', mapped: ['final'], later: ['extra'], extra: true, stale: true },
];

function scopes(c: (typeof cases)[number], commitValues: 'full' | 'delta'): RecordScope[] {
  const run = recordRun({}, { commitValues, writeProvenance: 'reads-prefix' });
  run.step('origin', (s) => s.set('input', 1));
  run.step('mount', (s) => {
    const oldValue = s.read('input');
    s.set(c.mapped.at(-1)!, [oldValue], undefined, c.mapped.slice(0, -1));
    if (c.extra) s.set('extra', [oldValue]);
  });
  run.step(
    'mount',
    (s) => s.merge(c.later.at(-1)!, [2], undefined, c.later.slice(0, -1)),
    c.otherVisit ? {} : { phase: c.exit ? 'exit' : 'repeat' },
  );
  const row = run.snapshot().commitLog[2];
  expect(row.trace.map(({ path }) => path)).toEqual([c.later.join(DELIM)]);
  const childRun = recordRun({}, { commitValues });
  childRun.step('work', (s) => s.set('answer', [1]));
  const handoff = {
    version: 1,
    attribution: 'observed-read-prefix',
    status: 'captured',
    limitations: [],
    parent: { address: parent, runtimeStageId: 'mount#1', commitIdx: 1 },
    child: { address: child, beforeCommitIdx: 1 },
    writes: [c.mapped.join(DELIM), ...(c.extra ? ['extra'] : [])].map((path) => ({ path, reads: ['answer'] })),
  } as const;
  return [
    {
      ...run.snapshot(),
      address: parent,
      complete: true,
      subflows: {
        version: 1,
        status: 'captured',
        mounts: [{ runtimeStageId: 'mount#1', child, outputHandoff: handoff }],
        collections: [],
      },
    },
    {
      ...childRun.snapshot(),
      address: child,
      complete: true,
      subflows: { version: 1, status: 'partial', mounts: [], collections: [] },
    },
  ];
}

describe.each(['full', 'delta'] as const)('output handoff in a %s log', (encoding) => {
  it.each(cases)('$name, live and saved', async (c) => {
    const live = scopes(c, encoding);
    const saved = JSON.parse(JSON.stringify(live)) as RecordScope[];
    for (const projected of [live, saved]) {
      const graph = createRecordGraph(projected);
      const target = graph.nodeId(parent, { runtimeStageId: 'mount#1', commitIdx: 1, key: c.mapped.join(DELIM) });
      const source = graph.nodeId(child, { runtimeStageId: 'work#0', commitIdx: 0, key: 'answer' });
      const local = graph.nodeId(parent, { runtimeStageId: 'origin#0', commitIdx: 0, key: 'input' });
      const result = await graph.parents(target, context());
      expect(result.edges.map(({ nodeId }) => nodeId)).toContain(local);
      expect(result.edges.some(({ nodeId }) => nodeId === source)).toBe(!c.stale);
      const gaps = await graph.gaps(target, context());
      expect(gaps.some(({ code }) => code === 'invalid-data')).toBe(c.stale);
      if (c.stale) expect(result.complete).toBe(false);
    }
  });
});
