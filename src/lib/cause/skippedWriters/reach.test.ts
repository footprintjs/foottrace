import { describe, expect, it } from 'vitest';

import { walkSkippedPath } from './reach.js';
import type { NormalizedSkippedStage } from './types.js';

function graph(...stages: readonly NormalizedSkippedStage[]): Map<string, NormalizedSkippedStage> {
  return new Map(stages.map((stage) => [stage.id, stage]));
}

const matches = (path: string): boolean => path === 'stock';

describe('walkSkippedPath', () => {
  it('prefers exhaustive declarations and records observed writers and unknowns separately', () => {
    const stages = graph(
      {
        id: 'entry',
        stageId: 'declare',
        role: 'stage',
        writes: ['other', 'stock'],
        edges: ['observed', 'different', 'empty', 'unknown'],
      },
      { id: 'observed', stageId: 'seen', role: 'stage', edges: [] },
      { id: 'different', stageId: 'different', role: 'stage', writes: ['other'], edges: [] },
      { id: 'empty', stageId: 'empty', role: 'stage', writes: [], edges: [] },
      { id: 'unknown', stageId: 'unknown', role: 'stage', edges: [] },
    );
    expect(
      walkSkippedPath(stages, 'entry', new Set(), new Set(['seen', 'different', 'empty']), matches, { left: 50 }),
    ).toEqual({
      writers: [
        { placementId: 'entry', stageId: 'declare', basis: 'declared' },
        { placementId: 'observed', stageId: 'seen', basis: 'observed' },
      ],
      gaps: ['writers-unknown'],
    });
  });

  it('stops at the owner, continuation, mounts and loop references while passing interior joins', () => {
    const stages = graph(
      {
        id: 'entry',
        stageId: 'entry',
        role: 'stage',
        writes: [],
        edges: ['join', 'mount', 'ref', 'continuation', 'owner'],
      },
      { id: 'join', stageId: 'join', role: 'join', writes: ['stock'], edges: ['writer'] },
      { id: 'writer', stageId: 'writer', role: 'stage', writes: ['stock'], edges: [] },
      { id: 'mount', stageId: 'mount', role: 'mount', writes: ['stock'], edges: ['missing-child'] },
      { id: 'ref', stageId: 'ref', role: 'loop-reference', writes: ['stock'], edges: ['missing-back'] },
      {
        id: 'continuation',
        stageId: 'continuation',
        role: 'stage',
        writes: ['stock'],
        edges: ['missing-continuation'],
      },
      { id: 'owner', stageId: 'owner', role: 'stage', writes: ['stock'], edges: ['missing-owner'] },
    );
    expect(
      walkSkippedPath(stages, 'entry', new Set(['continuation', 'owner']), new Set(), matches, { left: 50 }),
    ).toEqual({
      writers: [{ placementId: 'writer', stageId: 'writer', basis: 'declared' }],
      gaps: ['scope-boundary'],
    });
  });

  it('charges every edge but visits each placement once through convergence and cycles', () => {
    const stages = graph(
      { id: 'a', stageId: 'other', role: 'stage', writes: [], edges: ['b', 'c'] },
      { id: 'b', stageId: 'same-stage', role: 'stage', writes: ['stock'], edges: ['c'] },
      { id: 'c', stageId: 'same-stage', role: 'stage', edges: ['a'] },
    );
    const budget = { left: 8 }; // Three nodes, four edges and one examined declaration.
    expect(walkSkippedPath(stages, 'a', new Set(), new Set(['same-stage']), matches, budget)).toEqual({
      writers: [
        { placementId: 'b', stageId: 'same-stage', basis: 'declared' },
        { placementId: 'c', stageId: 'same-stage', basis: 'observed' },
      ],
      gaps: [],
    });
    expect(budget.left).toBe(0);
  });

  it('retains confirmed writers when the shared work budget runs out', () => {
    const stages = graph(
      { id: 'first', stageId: 'first', role: 'stage', writes: ['stock'], edges: ['second'] },
      { id: 'second', stageId: 'second', role: 'stage', writes: ['other', 'stock'], edges: [] },
    );
    const budget = { left: 5 };
    expect(walkSkippedPath(stages, 'first', new Set(), new Set(), matches, budget)).toEqual({
      writers: [{ placementId: 'first', stageId: 'first', basis: 'declared' }],
      gaps: ['limit'],
    });
    expect(budget.left).toBe(0);
    expect(walkSkippedPath(stages, 'second', new Set(), new Set(), matches, budget)).toEqual({
      writers: [],
      gaps: ['limit'],
    });
  });

  it('discards candidates when any reached node is missing', () => {
    const stages = graph({ id: 'a', stageId: 'stage', role: 'stage', writes: ['stock'], edges: ['missing'] });
    expect(walkSkippedPath(stages, 'a', new Set(), new Set(), matches, { left: 5 })).toEqual({
      writers: [],
      gaps: ['graph-ambiguous'],
    });
  });
});
