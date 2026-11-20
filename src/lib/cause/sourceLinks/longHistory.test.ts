import { expect, it } from 'vitest';
import {
  bundle,
  exactPolicy,
  linkFor,
  parents,
  scopeFor,
  servedWrite,
  witness,
} from '../../../../test/fixtures/source-links/recordHarness.js';
import type { Encoding } from '../../../../test/fixtures/source-links/recordHarness.js';
import type { CommitBundle } from '../../memory/types.js';

const entries = {
  small: (i: number) => ({ role: 'tool', id: `c${i}`, content: `r${i}` }),
  message: (i: number) => ({
    role: 'assistant',
    id: `m${i}`,
    model: 'x',
    stop: 'end',
    usage: { in: 1, out: 2 },
    content: [
      { type: 'text', text: `t${i}`, cite: null },
      { type: 'tool_use', id: `c${i}`, name: 'f' },
    ],
    meta: null,
    at: i,
  }),
  toolResult: (i: number) => ({
    role: 'tool',
    id: `c${i}`,
    rows: Array.from({ length: 20 }, (_, j) => ({ a: j, b: i, c: 'x', d: null, e: true })),
  }),
};
type Shape = keyof typeof entries;
type Case = readonly [number, Shape, Encoding, 'witnessed' | 'no-channel'];

// The 26 coordinator rows, captured on revision 3 and confirmed again on revisions 6 and 8.
// Each row checks index 1 and the final entry. Full snapshots with no admitted channel cannot invent a link.
const cases: readonly Case[] = [
  [50, 'small', 'delta', 'witnessed'],
  [50, 'small', 'full', 'witnessed'],
  [50, 'message', 'delta', 'witnessed'],
  [50, 'message', 'full', 'no-channel'],
  [50, 'toolResult', 'delta', 'witnessed'],
  [50, 'toolResult', 'full', 'no-channel'],
  [100, 'small', 'delta', 'witnessed'],
  [100, 'small', 'full', 'no-channel'],
  [100, 'message', 'delta', 'witnessed'],
  [100, 'message', 'full', 'no-channel'],
  [100, 'toolResult', 'delta', 'witnessed'],
  [100, 'toolResult', 'full', 'no-channel'],
  [250, 'small', 'delta', 'witnessed'],
  [250, 'small', 'full', 'no-channel'],
  [250, 'message', 'delta', 'witnessed'],
  [250, 'message', 'full', 'no-channel'],
  [250, 'toolResult', 'delta', 'no-channel'],
  [250, 'toolResult', 'full', 'no-channel'],
  [1000, 'small', 'delta', 'witnessed'],
  [1000, 'small', 'full', 'no-channel'],
  [1000, 'message', 'delta', 'witnessed'],
  [1000, 'message', 'full', 'no-channel'],
  [1000, 'toolResult', 'delta', 'witnessed'],
  [4000, 'small', 'delta', 'witnessed'],
  [4000, 'message', 'delta', 'witnessed'],
  [4000, 'toolResult', 'delta', 'witnessed'],
];

function history(count: number, shape: Shape, encoding: Encoding): CommitBundle[] {
  const values = Array.from({ length: count }, (_, i) => entries[shape](i));
  return values.map((value, i) =>
    encoding === 'delta'
      ? bundle(i, `write#${i}`, { history: [value] }, [{ path: 'history', verb: 'append' }])
      : bundle(i, `write#${i}`, { history: values.slice(0, i + 1) }),
  );
}

it.each(cases)(
  'keeps early and late citations in %i %s %s writes (%s)',
  async (count, shape, encoding, expected) => {
    const writes = history(count, shape, encoding);
    const output = { key: 'answer', checkedIn: 'written' as const };
    const door = { runtimeStageId: 'door', commitIdx: count + 1 };
    // Coverage can slow admission down enough to reach the default deadline. These rows pin the field limit.
    const limits = count >= 1000 ? { maxCommits: 4096, maxFields: 1_000_000, loadTimeoutMs: 30_000 } : {};
    for (const element of [1, count - 1]) {
      const row = witness({ key: 'history', element }, output);
      const link = linkFor(row, door, { ...door, key: 'evidence', element: 0 });
      const log = [
        ...writes,
        servedWrite(count, [{ key: 'history', elements: [[0, count]] }]),
        bundle(door.commitIdx, door.runtimeStageId, { answer: 'cited answer', evidence: [row] }),
      ];
      const scope = scopeFor({}, log, [link]);
      const page = await parents('memory', scope, link.output, {
        ...limits,
        sourceLinkPolicy: exactPolicy(scope.address, link),
      });
      if (expected === 'witnessed') {
        expect(page.sourceLinks).toMatchObject([{ standing: 'witnessed', input: { view: { element } } }]);
        expect(page.sourceLinkGaps?.map(({ code }) => code)).toEqual(['unavailable']);
      } else {
        expect(page.sourceLinks).toBeUndefined();
        expect(page.sourceLinkGaps).toBeUndefined();
        expect(page.complete).toBe(false);
        expect(page.gaps?.map(({ code }) => code)).toEqual(['node-limit']);
      }
    }
  },
  10_000,
);
