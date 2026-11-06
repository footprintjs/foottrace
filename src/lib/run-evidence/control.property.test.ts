/**
 * Property: on any chart shape, the read-time fold equals an independent copy of the live recorder's correlation (its
 * pending slots, consumed as stages finish), for every execution. The real recorder's parity is the fixture test; this one
 * explores shapes no fixture holds.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { evidenceStore } from '../../../test/helpers/evidenceFixture';
import { readStoredRecord } from '../time-travel/storedRecord';
import { readRunEvidence } from './read';

type Shape = { readonly kind: 'stage' } | { readonly kind: 'decide' | 'select'; readonly branches: readonly Shape[][] };

const shapes = fc.letrec<{ list: Shape[]; one: Shape }>((tie) => ({
  list: fc.array(tie('one'), { minLength: 1, maxLength: 3 }),
  one: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.constant<Shape>({ kind: 'stage' }),
    fc.record({
      kind: fc.constantFrom<'decide' | 'select'>('decide', 'select'),
      branches: fc.array(tie('list'), { minLength: 0, maxLength: 3 }),
    }),
  ),
})).list;

interface Executed {
  id: string;
  parent?: string;
  finishes: number;
}

/** Runs a shape the way the engine stamps parents: each stage's parent is what ran before it on its path. */
function execute(shape: readonly Shape[]) {
  const executions: Executed[] = [];
  const decisions = new Map<string, number>();
  let index = 0;
  let clock = 0;
  const walk = (list: readonly Shape[], from: string | undefined): void => {
    let parent = from;
    for (const node of list) {
      const id = `s${index}#${index}`;
      index++;
      executions.push({ id, ...(parent ? { parent } : {}), finishes: ++clock });
      if (node.kind !== 'stage') {
        const taken = node.kind === 'decide' ? node.branches.slice(0, 1) : node.branches;
        decisions.set(id, taken.length);
        for (const branch of taken) walk(branch, id);
      }
      parent = id;
    }
  };
  walk(shape, undefined);
  return { executions, decisions };
}

/** The recorder's correlation, copied: pending slots, consumed by parent in the order stages finish; then the ancestor walk. */
function liveOracle({ executions, decisions }: ReturnType<typeof execute>): Map<string, string | undefined> {
  const parentOf = new Map(executions.flatMap((e) => (e.parent ? [[e.id, e.parent] as const] : [])));
  const pending = new Map(decisions);
  const entry = new Map<string, string>();
  for (const e of [...executions].sort((a, b) => a.finishes - b.finishes)) {
    const left = e.parent === undefined ? undefined : pending.get(e.parent);
    if (left !== undefined && left > 0) {
      entry.set(e.id, e.parent!);
      pending.set(e.parent!, left - 1);
    }
  }
  const answers = new Map<string, string | undefined>();
  for (const e of executions) {
    let cur: string | undefined = e.id;
    while (cur !== undefined && !entry.has(cur)) cur = parentOf.get(cur);
    answers.set(e.id, cur === undefined ? undefined : entry.get(cur));
  }
  return answers;
}

describe('the fold equals an independent copy of the live correlation', () => {
  it('on any chart shape, for every execution', () => {
    fc.assert(
      fc.property(shapes, (shape) => {
        const run = execute(shape);
        const store = evidenceStore();
        for (const e of run.executions) {
          store.commit(['r'], e.id, e.parent ? { parent: e.parent } : {});
          const taken = run.decisions.get(e.id);
          if (taken !== undefined) {
            store.note(['r'], 'run.decision', { id: e.id, by: 'plain', chosen: Array(taken).fill('b') });
          }
        }
        store.close(['r']);
        const evidence = readRunEvidence(readStoredRecord(store.entries()), 'r');
        const live = liveOracle(run);
        for (const e of run.executions) {
          const folded = evidence.control(e.id);
          expect([e.id, folded.status, folded.decider]).toEqual([e.id, 'collected', live.get(e.id)]);
        }
      }),
      { numRuns: 200 },
    );
  });
});
