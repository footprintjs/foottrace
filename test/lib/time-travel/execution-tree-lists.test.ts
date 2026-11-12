/**
 * The list form of an execution tree (footprintjs 12): a chain is an array of stages in the order
 * they ran, and a fork's children are `branches`, one chain each. Its depth is how far forks nest,
 * never how long the run was. Every reader of the linked form reads it too, and the linked form
 * still reads (stored recordings).
 */
import { describe, expect, it } from 'vitest';

import { commitStops, keysReadFromExecutionTree } from '../../../src/index.js';
import type { CommitBundle, ExecutionChain } from '../../../src/lib/memory/types.js';
import { admitProvRecord } from '../../../src/lib/prov/admission.js';
import { provOptions } from '../../../src/lib/prov/options.js';

function bundle(runtimeStageId: string, idx: number): CommitBundle {
  const stageId = runtimeStageId.split('#')[0];
  return {
    idx,
    stage: stageId,
    stageId,
    runtimeStageId,
    trace: [{ path: stageId, verb: 'set' }],
    redactedPaths: [],
    overwrite: { [stageId]: idx },
    updates: {},
  };
}

const stage = (id: string, extra: Record<string, unknown> = {}) => ({ id, runtimeStageId: id, ...extra });
const longChain = (n: number): ExecutionChain =>
  Array.from({ length: n }, (_, i) => stage(`step#${i}`, { stageReads: { [`k${i % 3}`]: null } }));

describe('commitStops reads the list form', () => {
  const LOG = [bundle('a#0', 0), bundle('sf#1', 1)];

  it('finds a mount in the root chain', () => {
    const tree = [stage('a#0'), stage('sf#1', { subflowId: 'sf' })];
    expect(commitStops(LOG, tree).map((s) => s.kind)).toEqual(['start', 'commit', 'mount', 'end']);
  });

  it('finds a mount inside a branch', () => {
    const tree = [stage('a#0', { branches: [[stage('sf#1', { subflowId: 'sf' })]] })];
    expect(commitStops(LOG, tree).map((s) => s.kind)).toEqual(['start', 'commit', 'mount', 'end']);
  });

  it('ends on a chain that holds itself', () => {
    const tree: unknown[] = [stage('a#0'), stage('sf#1', { subflowId: 'sf' })];
    (tree[0] as Record<string, unknown>).branches = [tree];
    expect(commitStops(LOG, tree as never).map((s) => s.kind)).toEqual(['start', 'commit', 'mount', 'end']);
  });

  it('ends on a chain that is its own item', () => {
    const tree: unknown[] = [stage('a#0'), stage('sf#1', { subflowId: 'sf' })];
    tree.push(tree);
    expect(commitStops(LOG, tree as never).map((s) => s.kind)).toEqual(['start', 'commit', 'mount', 'end']);
  });

  it('reads the same stops from either form', () => {
    const linked = stage('a#0', { next: stage('sf#1', { subflowId: 'sf' }) });
    const listed = [stage('a#0'), stage('sf#1', { subflowId: 'sf' })];
    expect(commitStops(LOG, listed)).toEqual(commitStops(LOG, linked));
  });
});

describe('keysReadFromExecutionTree reads the list form', () => {
  it('reads every stage of a chain and its branches', () => {
    const tree = [
      stage('a#0', { stageReads: { x: 1 } }),
      stage('fork#1', {
        branches: [[stage('left#2', { stageReads: { l: 1 } })], [stage('right#3', { stageReads: { r: 1 } })]],
      }),
    ];
    const reads = keysReadFromExecutionTree(tree);
    expect([reads.lookup('a#0'), reads.lookup('left#2'), reads.lookup('right#3')]).toEqual([['x'], ['l'], ['r']]);
    expect(reads.coverage).toEqual({ steps: 4, stepsWithReads: 3 });
  });

  it('refuses branches that are not lists of lists, naming the path', () => {
    expect(() => keysReadFromExecutionTree([stage('a#0', { branches: [stage('b#1')] })])).toThrow(
      /\$\[0\]\.branches must be an array of arrays/,
    );
  });

  it('reads a 30,000-stage chain, which is one level deep', () => {
    const reads = keysReadFromExecutionTree(longChain(30_000));
    expect(reads.coverage?.steps).toBe(30_000);
    expect(reads.lookup('step#29999')).toEqual(['k2']);
  });
});

describe('provenance admission reads the list form', () => {
  const options = () => provOptions({ base: 'urn:example:run:one/' });

  it('reads a chain far longer than the depth limit, since a chain adds no depth', () => {
    const result = admitProvRecord({ commitLog: [], executionTree: longChain(1_000) }, options());
    expect(result.reads?.size).toBe(1_000);
    expect(result.gaps.some((gap) => gap.code === 'depth-limit')).toBe(false);
  });

  it('reads the stages inside branches', () => {
    const tree = [stage('fork#0', { branches: [[stage('left#1', { stageReads: { l: null } })]] })];
    const result = admitProvRecord({ commitLog: [], executionTree: tree }, options());
    expect(result.reads?.get('left#1')).toEqual(['l']);
  });

  it('records a gap for a branch that is not a chain', () => {
    const tree = [stage('fork#0', { branches: [stage('left#1')] })];
    const result = admitProvRecord({ commitLog: [], executionTree: tree }, options());
    expect(result.gaps.length).toBeGreaterThan(0);
  });
});
