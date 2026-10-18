import type { Attention, Gap, MarkedNode, NodeId, TraversedEdge } from './types.js';
import { Session } from './session.js';
import type { BudgetView } from './queryBudget.js';
import { adjacency, attention, gap, gaps, uniqueGaps } from './validation.js';

export interface Walk {
  readonly nodes: readonly NodeId[];
  readonly marked: readonly MarkedNode[];
  readonly edges: readonly TraversedEdge[];
  readonly gaps: readonly Gap[];
}
/** BFS discovers the shallowest arrival; a repeated diamond node is not a cycle. */
export async function walk(
  session: Session,
  budget: BudgetView,
  seeds: readonly NodeId[],
  direction: 'parents' | 'children',
): Promise<Walk> {
  const queue: Array<[NodeId, number]> = [],
    seen = new Set<NodeId>(),
    marks: MarkedNode[] = [],
    edges: TraversedEdge[] = [],
    missing: Gap[] = [];
  const enqueue = (id: NodeId, depth: number) => {
    if (seen.has(id)) return;
    const refusal = budget.admit(id);
    if (refusal) {
      missing.push(refusal);
      return;
    }
    seen.add(id);
    queue.push([id, depth]);
  };
  for (const id of seeds) enqueue(id, 0);
  for (let index = 0; index < queue.length; index++) {
    const [id, depth] = queue[index],
      stopped = session.stopGap(id);
    if (stopped) {
      missing.push(stopped);
      break;
    }
    const marked = await session.read(budget, 'attention', id, attention);
    if (marked.gap) missing.push(marked.gap);
    if (marked.value?.length) {
      marks.push(Object.freeze({ nodeId: id, attention: marked.value }));
      if (marked.value.some((item) => item.kind === 'not-collected')) missing.push(gap('not-collected', id));
    }
    const coverage = await session.read(budget, 'gaps', id, gaps);
    if (coverage.gap) missing.push(coverage.gap);
    if (coverage.value) missing.push(...coverage.value);
    const page = await session.read(budget, direction, id, (raw) => adjacency(raw, session.limits.maxEdges));
    if (page.gap) {
      missing.push(page.gap);
      continue;
    }
    if (!page.value) continue;
    if (!page.value.complete) missing.push(gap('not-collected', id));
    if (depth >= budget.maxDepth) {
      if (page.value.edges.length) missing.push(gap('depth-limit', id));
      continue;
    }
    for (const edge of page.value.edges) {
      const edgeRefusal = budget.takeEdge(id);
      if (edgeRefusal) {
        missing.push(edgeRefusal);
        break;
      }
      const refusal = budget.admit(edge.nodeId);
      if (refusal) {
        missing.push(refusal);
        continue;
      }
      edges.push(
        Object.freeze({
          from: id,
          to: edge.nodeId,
          kind: edge.kind,
          attribution: edge.attribution,
          evidence: edge.evidence,
        }),
      );
      if (edge.attribution === 'stage') missing.push(gap('conservative', id));
      enqueue(edge.nodeId, depth + 1);
    }
  }
  if (hasCycle(edges)) missing.push(gap('cycle'));
  return Object.freeze({
    nodes: Object.freeze(queue.map((row) => row[0])),
    marked: Object.freeze(marks),
    edges: Object.freeze(edges),
    gaps: uniqueGaps(missing),
  });
}
/** Iterative three-colour walk; shared nodes remain distinguishable from back edges. */
function hasCycle(edges: readonly TraversedEdge[]): boolean {
  const next = new Map<NodeId, NodeId[]>();
  for (const edge of edges) {
    if (!next.has(edge.from)) next.set(edge.from, []);
    next.get(edge.from)!.push(edge.to);
  }
  const state = new Map<NodeId, number>();
  for (const seed of next.keys()) {
    if (state.has(seed)) continue;
    const stack: Array<[NodeId, number]> = [[seed, 0]];
    state.set(seed, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1],
        children = next.get(frame[0]) ?? [];
      if (frame[1] >= children.length) {
        state.set(frame[0], 2);
        stack.pop();
        continue;
      }
      const child = children[frame[1]++];
      if (state.get(child) === 1) return true;
      if (!state.has(child)) {
        state.set(child, 1);
        stack.push([child, 0]);
      }
    }
  }
  return false;
}
export function frontier(result: Walk): readonly MarkedNode[] {
  const marked = new Set(
    result.marked
      .filter((item) => item.attention.some((mark) => mark.kind !== 'not-collected'))
      .map((item) => item.nodeId),
  );
  const pending = new Map<NodeId, number>(result.nodes.map((id) => [id, 0]));
  const dependents = new Map<NodeId, NodeId[]>();
  for (const edge of result.edges) {
    pending.set(edge.from, (pending.get(edge.from) ?? 0) + 1);
    if (!dependents.has(edge.to)) dependents.set(edge.to, []);
    dependents.get(edge.to)!.push(edge.from);
  }
  // Process causal ancestors first, propagating one boolean through the DAG.
  // This is O(nodes + edges), rather than a fresh ancestry scan per marked node.
  const queue = [...pending].filter(([, count]) => count === 0).map(([id]) => id);
  const earlierMark = new Set<NodeId>(),
    eligible = new Set<NodeId>();
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (marked.has(id) && !earlierMark.has(id)) eligible.add(id);
    for (const dependent of dependents.get(id) ?? []) {
      if (marked.has(id) || earlierMark.has(id)) earlierMark.add(dependent);
      const count = pending.get(dependent)! - 1;
      pending.set(dependent, count);
      if (count === 0) queue.push(dependent);
    }
  }
  // Nodes left in a cycle cannot supply a validated earliest ancestor.
  return result.marked.filter((item) => eligible.has(item.nodeId));
}
export function pathTo(edges: readonly TraversedEdge[], start: NodeId, target: NodeId): readonly NodeId[] {
  const queue = [start],
    previous = new Map<NodeId, NodeId | undefined>([[start, undefined]]);
  const next = new Map<NodeId, NodeId[]>();
  for (const edge of edges) {
    if (!next.has(edge.from)) next.set(edge.from, []);
    next.get(edge.from)!.push(edge.to);
  }
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (id === target) break;
    for (const child of next.get(id) ?? [])
      if (!previous.has(child)) {
        previous.set(child, id);
        queue.push(child);
      }
  }
  if (!previous.has(target)) return Object.freeze([]);
  const path: NodeId[] = [];
  let id: NodeId | undefined = target;
  while (id !== undefined) {
    path.push(id);
    id = previous.get(id);
  }
  return Object.freeze(path.reverse());
}
