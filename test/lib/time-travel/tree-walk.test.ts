/**
 * `commitStops` reads mount ids off an execution tree that may come from a file or be built by hand.
 * A node is read only when it is a plain object, and once: a null child is no crash, and a `next` or
 * a child that points back is no endless walk. (The slice reader's tree walk,
 * `keysReadFromExecutionTree`, has guarded both since it shipped.)
 */
import { describe, expect, it } from 'vitest';

import { commitStops, timeTravel } from '../../../src/index.js';
import type { CommitBundle } from '../../../src/lib/memory/types.js';

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

const LOG = [bundle('a#0', 0), bundle('sf#1', 1)];
const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, runtimeStageId: id, ...extra });
const kinds = (tree: unknown) => commitStops(LOG, tree as never).map((stop) => stop.kind);

describe('commitStops walks a hand-built execution tree safely', () => {
  it('finds the mount beside a null child', () => {
    const tree = node('a#0', { children: [null, node('sf#1', { subflowId: 'sf' })] });
    expect(kinds(tree)).toEqual(['start', 'commit', 'mount', 'end']);
  });

  it('ends on a `next` that points back at its own node', () => {
    const tree = node('a#0', { next: node('sf#1', { subflowId: 'sf' }) }) as Record<string, any>;
    tree.next.next = tree;
    expect(kinds(tree)).toEqual(['start', 'commit', 'mount', 'end']);
  });

  it('ends on a child that holds its parent', () => {
    const tree = node('a#0') as Record<string, any>;
    tree.children = [node('sf#1', { subflowId: 'sf' }), tree];
    expect(kinds(tree)).toEqual(['start', 'commit', 'mount', 'end']);
  });

  it('reads a node whose fields have the wrong shape as a node with no mount id', () => {
    const tree = node('a#0', { next: 'not a node', children: 'not a list', subflowId: 'sf', runtimeStageId: 7 });
    expect(kinds(tree)).toEqual(['start', 'commit', 'commit', 'end']);
  });

  it('timeTravel takes the same trees', () => {
    const tree = node('a#0', { children: [null] }) as Record<string, any>;
    tree.next = tree;
    const cursor = timeTravel({ commitLog: LOG, initialState: {}, executionTree: tree } as never);
    expect(cursor.stops).toHaveLength(4);
  });
});
