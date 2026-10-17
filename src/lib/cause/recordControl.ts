import type { ControlDependency } from '../memory/backtrack.js';
import { nodeIdFor } from './recordIdentity.js';
import type { AddRecordGap, PreparedRecordScope, RecordIdentity } from './recordTypes.js';
import type { GraphEdge } from './types.js';

/** Only an execution or captured read may govern control flow; a written key alone cannot. */
export function controlChildren(
  scope: PreparedRecordScope,
  identity: RecordIdentity,
): Iterable<readonly [string, ControlDependency]> {
  // A read-only execution may govern later work; a particular written key is not itself a decision.
  return identity.key === undefined || identity.read ? scope.control ?? [] : [];
}

/** Canonical slicing receives only control parents that existed before the dependent execution. */
export function controlParentLookup(
  scope: PreparedRecordScope,
): ((runtimeStageId: string) => ControlDependency | undefined) | undefined {
  return scope.control === undefined
    ? undefined
    : (runtimeStageId) => {
        const dependency = scope.control!.get(runtimeStageId);
        if (!dependency) return undefined;
        const parentIndex = scope.log.findIndex((bundle) => bundle.runtimeStageId === dependency.deciderId),
          childIndex = scope.log.findIndex((bundle) => bundle.runtimeStageId === runtimeStageId);
        return parentIndex >= 0 && parentIndex < childIndex ? dependency : undefined;
      };
}

/** Keep missing or future deciders visible rather than silently dropping their recorded dependency. */
export function collectControlParentCoverage(
  scope: PreparedRecordScope,
  identity: RecordIdentity,
  firstCommitIndex: number,
  addGap: AddRecordGap,
): void {
  const dependency = scope.control?.get(identity.runtimeStageId);
  if (!dependency) return;
  const parentIndex = scope.log.findIndex((bundle) => bundle.runtimeStageId === dependency.deciderId);
  if (parentIndex < 0) addGap('scope-boundary');
  else if (parentIndex >= firstCommitIndex) addGap('invalid-data');
}

/** Include control fan-out in the same immediate-neighbor cap used for data adjacency. */
export function collectControlChildCoverage(
  scope: PreparedRecordScope,
  identity: RecordIdentity,
  firstCommitIndex: number,
  neighbors: Set<string>,
  addGap: AddRecordGap,
): void {
  for (const [childStageId, dependency] of controlChildren(scope, identity))
    if (dependency.deciderId === identity.runtimeStageId) {
      const childIndex = scope.log.findIndex((bundle) => bundle.runtimeStageId === childStageId);
      if (childIndex < 0) addGap('scope-boundary');
      else if (childIndex <= firstCommitIndex) addGap('invalid-data');
      else neighbors.add(JSON.stringify(['control', childStageId]));
    }
}

/** Preserve recorded control order and coverage when a dependent execution is absent or capped. */
export function appendControlChildren(
  scope: PreparedRecordScope,
  identity: RecordIdentity,
  commitIndex: number,
  maximumEdges: number,
  edges: GraphEdge[],
): boolean {
  let complete = true;
  for (const [childStageId, dependency] of controlChildren(scope, identity)) {
    if (dependency.deciderId !== identity.runtimeStageId) continue;
    const childIndex = scope.log.findIndex((bundle) => bundle.runtimeStageId === childStageId);
    if (childIndex <= commitIndex) {
      complete = false;
      continue;
    }
    if (edges.length >= maximumEdges) {
      complete = false;
      break;
    }
    edges.push({
      nodeId: nodeIdFor(scope.address, { runtimeStageId: childStageId, commitIdx: childIndex }),
      kind: 'control',
      attribution: 'recorded-control',
      evidence: ['commit:' + childIndex],
    });
  }
  return complete;
}
