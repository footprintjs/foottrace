import { describe, expect, it } from 'vitest';

import type { StoredDecision } from '../../run-evidence/rows.js';
import { skippedBranches } from './dispatch.js';
import type { NormalizedChoice, NormalizedControl, NormalizedSkippedStage } from './types.js';

const address = { logRunId: 'r', drillPath: [] };
const stage = (id: string, edges: readonly string[], writes: readonly string[] = []): NormalizedSkippedStage => ({
  id,
  stageId: id,
  role: 'stage',
  edges,
  writes,
});
const graph = new Map([
  ['choose', stage('choose', ['keep', 'skip', 'tail'])],
  ['keep', stage('keep', ['tail'])],
  ['skip', stage('skip', ['tail'], ['price'])],
  ['tail', stage('tail', ['choose'], ['price'])],
]);
const control: NormalizedControl = {
  placementId: 'choose',
  kind: 'decider',
  choices: [
    { entry: 'keep', name: 'Keep' },
    { entry: 'skip', name: 'Skip' },
  ],
  continuation: 'tail',
};
const actual: StoredDecision = { id: 'choose#2', address, seq: 0, by: 'decide', chosen: 'Keep' };
const investigate = (decision = actual, bound = control, loop = { recorded: true, reentered: false }) =>
  skippedBranches(decision, bound, graph, new Set(), (path) => path === 'price', loop, { left: 100 });

describe('admitted dispatch and skipped direct choices', () => {
  it('includes a skipped writer without following the shared continuation', () => {
    expect(investigate()).toEqual({
      branches: [{ entry: 'skip', writers: [{ placementId: 'skip', stageId: 'skip', basis: 'declared' }] }],
      gaps: [],
    });
  });

  it('refuses an ambiguous display name or a fallback that does not match the declared default', () => {
    const colliding = { ...control, choices: [...control.choices, { entry: 'other', name: 'Keep' }] };
    expect(investigate(actual, colliding)).toEqual({ branches: [], gaps: ['graph-ambiguous'] });
    expect(investigate({ ...actual, fellBack: true })).toEqual({ branches: [], gaps: ['graph-ambiguous'] });
    const fallback: readonly NormalizedChoice[] = [
      { entry: 'keep', name: 'Keep', fallback: true },
      { entry: 'skip', name: 'Skip' },
    ];
    expect(investigate({ ...actual, fellBack: true }, { ...control, choices: fallback }).gaps).toEqual([]);
  });

  it('treats a recorded empty selector result as a positive choice of no branch', () => {
    const result = investigate({ ...actual, by: 'select', chosen: [], total: 2 }, { ...control, kind: 'selector' });
    expect(result.branches.map((branch) => branch.entry)).toEqual(['skip']);
    expect(result.gaps).toEqual([]);
  });

  it('requires a positive exit choice and the loop-capable evidence format', () => {
    const loop: NormalizedControl = {
      ...control,
      choices: [
        { entry: 'keep', name: 'Keep' },
        { entry: 'repeat', name: 'Repeat', loopBack: { body: 'skip', exit: 'keep', owner: 'choose' } },
      ],
    };
    expect(investigate(actual, loop, { recorded: false, reentered: false }).gaps).toEqual(['loop-evidence']);
    expect(investigate(actual, loop, { recorded: true, reentered: true }).gaps).toEqual(['loop-evidence']);
    expect(investigate(actual, loop).branches).toEqual([
      { entry: 'repeat', writers: [{ placementId: 'skip', stageId: 'skip', basis: 'declared' }] },
    ]);
  });
});
