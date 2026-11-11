/**
 * backtrackViews.ts — two ways to read the result of a walk back (`backtrack.ts · causalChain`): a
 * flat list of its nodes, and indented text.
 *
 * WHY ITS OWN FILE: neither walks the log. They read a finished result, and each visits a node once,
 * which is what makes them safe on a result that holds a cycle (see the header of `backtrack.ts`).
 */

import type { CausalEdge, CausalNode } from './backtrackTypes.js';
import type { SourceOverlap } from './parentEdges.js';
import { shownPath } from '../record-paths/codec.js';

/**
 * Flatten the causal DAG into a BFS-ordered list of nodes.
 * Each node appears exactly once (first occurrence by BFS order).
 * Useful for linear display or iteration.
 */
export function flattenCausalDAG(root: CausalNode): CausalNode[] {
  const result: CausalNode[] = [];
  const visited = new Set<string>();
  const queue: CausalNode[] = [root];

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (visited.has(node.runtimeStageId)) continue;
    visited.add(node.runtimeStageId);
    result.push(node);

    for (const parent of node.parents) {
      if (!visited.has(parent.runtimeStageId)) {
        queue.push(parent);
      }
    }
  }

  return result;
}

/**
 * Format a causal DAG as human-readable indented text.
 * Shows the dependency chain with depth indentation and linked-by keys.
 *
 * RFC-003 D2: nodes that consumed untracked read paths render an extra
 * `⚠ also consumed … — slice may be incomplete here` line, so a consumer
 * (human or LLM) debugging from the slice is TOLD when it is incomplete.
 *
 * RFC-003 D3: control edges render as `← [control: <rule label>]`
 * (label omitted when the decision carried none). A data edge renders as
 * `← via <key>`: the key of the edge from the child the node is shown under
 * (the first one, when that child read several keys from this node). A parent
 * that is only a possible source of a key (`CausalEdge.overlap`) says why:
 * `← via x (as the reader began; written again while it ran)` or
 * `← via x (written while the reader ran)`, naming the keys when they are not
 * the one shown.
 *
 * An edge no read made (`CausalEdge.builtOn`: the child's write of the key did not replace the value,
 * or the writer built it on the step's view, so it kept part of what the parent had written) renders
 * as `← built on <key>`.
 *
 * RFC-003 D4: edge weights from the `weigh` hook render as a suffix —
 * `← via systemPrompt (0.18)` — only when ≠ 1.0, so unweighted output is
 * unchanged. A truncated slice (root.truncated) appends a final
 * `⚠ slice truncated …` line.
 */
/** How a tree line says each mark. Short on purpose: the full sentence is the registry's. */
const OVERLAP_WORDS: Record<SourceOverlap, string> = {
  'replaced-while-running': 'as the reader began; written again while it ran',
  'written-while-running': 'written while the reader ran',
  'view-not-placed': 'possibly: the array does not show where the view sits',
};

export function formatCausalChain(root: CausalNode): string {
  const lines: string[] = [];
  const visited = new Set<string>();

  const weightSuffix = (edge: CausalEdge | undefined): string =>
    edge !== undefined && edge.weight !== 1 ? ` (${edge.weight})` : '';
  // The keys this parent is only a possible source of, said per mark (`CausalEdge.overlap`).
  const overlapSuffix = (edges: CausalEdge[] | undefined, shown: CausalEdge): string =>
    (Object.keys(OVERLAP_WORDS) as SourceOverlap[])
      .map((mark) => {
        const keys = [...new Set((edges ?? []).filter((e) => e.overlap === mark && e.key).map((e) => e.key as string))];
        if (keys.length === 0) return '';
        const only = keys.length === 1 && keys[0] === shown.key;
        return only ? ` (${OVERLAP_WORDS[mark]})` : ` (${OVERLAP_WORDS[mark]}: ${keys.map(shownPath).join(', ')})`;
      })
      .join('');

  function walk(node: CausalNode, indent: number, edgesFromChild?: CausalEdge[]): void {
    if (visited.has(node.runtimeStageId)) {
      lines.push(`${'  '.repeat(indent)}↳ ${node.runtimeStageId} (see above)`);
      return;
    }
    visited.add(node.runtimeStageId);

    // The key is the DISPLAYED child's own edge to this node. `node.linkedBy` is the key of whichever
    // child discovered the node first (breadth-first), and this walk is depth-first: under another
    // child it named a key that child never read.
    const linkParts: string[] = [];
    // A read's edge is shown before one no read made (`CausalEdge.builtOn`): `via x` says the child
    // read `x` from this node; `built on x` says the child's own write of `x` kept part of what this
    // node had written there.
    const dataEdge =
      edgesFromChild?.find((e) => e.kind === 'data' && e.builtOn === undefined) ??
      edgesFromChild?.find((e) => e.kind === 'data');
    if (dataEdge?.key)
      linkParts.push(
        `${dataEdge.builtOn === undefined ? 'via' : 'built on'} ${shownPath(dataEdge.key)}${weightSuffix(
          dataEdge,
        )}${overlapSuffix(edgesFromChild, dataEdge)}`,
      );
    const controlEdge = edgesFromChild?.find((e) => e.kind === 'control');
    if (controlEdge) {
      linkParts.push(`[control${controlEdge.key ? `: ${controlEdge.key}` : ''}]${weightSuffix(controlEdge)}`);
    }
    const link = linkParts.length > 0 ? ` ← ${linkParts.join(' ← ')}` : '';

    const writes = node.keysWritten.length > 0 ? ` [wrote: ${node.keysWritten.map(shownPath).join(', ')}]` : '';
    lines.push(`${'  '.repeat(indent)}${node.stageName} (${node.runtimeStageId})${link}${writes}`);

    if (node.incompleteSources && node.incompleteSources.length > 0) {
      lines.push(
        `${'  '.repeat(indent + 1)}⚠ also consumed ${node.incompleteSources.join('/')} — slice may be incomplete here`,
      );
    }

    for (const parent of node.parents) {
      walk(
        parent,
        indent + 1,
        node.parentEdges.filter((e) => e.parent === parent),
      );
    }
  }

  walk(root, 0);

  if (root.truncated) {
    const causes = [root.truncated.byDepth && 'maxDepth reached', root.truncated.byNodes && 'maxNodes reached']
      .filter(Boolean)
      .join(', ');
    lines.push(`⚠ slice truncated (${causes}) — older causes exist beyond this horizon`);
  }

  return lines.join('\n');
}
