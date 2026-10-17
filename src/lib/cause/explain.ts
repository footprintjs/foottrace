import type {
  AttentionListOptions,
  AttentionListResult,
  CauseGraph,
  CauseResult,
  ExplainOptions,
  Gap,
  ImpactResult,
  NodeId,
} from './types.js';
import { Session } from './session.js';
import { frontier, pathTo, walk } from './walk.js';
import { gap, name, nodeIds, own, uniqueGaps } from './validation.js';
import { admitRanking } from './ranking.js';

/** Read-only deterministic cause localisation and impact. No inference from timestamps or structural ancestry. */
export async function explain(graph: CauseGraph, nodeId: NodeId, options: ExplainOptions = {}): Promise<CauseResult> {
  name(nodeId);
  const session = new Session(graph, options);
  try {
    const backward = await walk(session, [nodeId], 'parents');
    const missing: Gap[] = [...backward.gaps];
    let candidates = frontier(backward).map((item) => item.nodeId);
    const rank = own(options, 'rankRoots');
    if (rank !== undefined) {
      if (typeof rank !== 'function') throw new TypeError('CAUSE_CONFIGURATION_INVALID');
      const eligible = backward.marked.filter((item) => item.attention.some((mark) => mark.kind !== 'not-collected'));
      const selection = await session.invoke(
        undefined,
        () => rank(Object.freeze(eligible), session.context),
        (raw) =>
          admitRanking(raw, new Set(eligible.map((item) => item.nodeId)), {
            exactPermutation: false,
            maximum: session.limits.maxNodes,
          }),
      );
      if (selection.gap) missing.push(selection.gap, gap('strategy-failed'));
      else candidates = [...(selection.value ?? [])];
    }
    const stopped = session.stopGap(nodeId);
    if (stopped) missing.push(stopped);
    const causeComplete = missing.length === 0;
    const rootCause = causeComplete && candidates.length === 1 ? candidates[0] : undefined;
    const forward = await walk(session, [nodeId], 'children');
    let impactNodes = Object.freeze(forward.nodes.filter((id) => id !== nodeId));
    const impactGaps = [...forward.gaps],
      rankImpact = own(options, 'rankImpact');
    if (typeof rankImpact === 'function') {
      const selection = await session.invoke(
        undefined,
        () => rankImpact(impactNodes, session.context),
        (raw) =>
          admitRanking(raw, new Set(impactNodes), {
            exactPermutation: true,
            maximum: session.limits.maxNodes,
          }),
      );
      if (selection.gap) impactGaps.push(selection.gap, gap('strategy-failed'));
      else impactNodes = selection.value ?? impactNodes;
    }
    const impact: ImpactResult = Object.freeze({
      nodes: impactNodes,
      edges: forward.edges,
      confidence: impactGaps.length ? 'incomplete' : 'complete',
      gaps: uniqueGaps(impactGaps),
    });
    const allGaps = uniqueGaps([...missing, ...impactGaps]);
    return Object.freeze({
      nodeId,
      attention: backward.marked.find((item) => item.nodeId === nodeId)?.attention ?? Object.freeze([]),
      ...(rootCause ? { rootCause } : {}),
      path: rootCause ? pathTo(backward.edges, nodeId, rootCause) : Object.freeze([]),
      alternatives: Object.freeze(rootCause ? [] : candidates),
      impact,
      confidence: allGaps.length ? 'incomplete' : 'complete',
      gaps: allGaps,
    });
  } finally {
    session.dispose();
  }
}

/** Discover only bounded host seeds; this is not a global scan of arbitrary storage. */
export async function attentionList(
  graph: CauseGraph,
  options: AttentionListOptions = {},
): Promise<AttentionListResult> {
  const session = new Session(graph, options);
  try {
    let seeds: readonly NodeId[] = [],
      missing: Gap[] = [];
    const requested = own(options, 'nodeIds');
    const admitSeeds = (raw: unknown): readonly NodeId[] => {
      // Only inspect the bounded prefix; the unread tail is explicitly incomplete.
      if (!Array.isArray(raw)) return nodeIds(raw, session.limits.maxNodes);
      const length = own(raw, 'length');
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)
        return nodeIds(raw, session.limits.maxNodes);
      if (length > session.limits.maxNodes) missing.push(gap('node-limit'));
      const prefix: unknown[] = [];
      for (let i = 0; i < Math.min(length, session.limits.maxNodes); i++) prefix.push(own(raw, String(i)));
      return nodeIds(prefix, session.limits.maxNodes);
    };
    if (requested !== undefined) {
      const read = await session.invoke(undefined, () => requested, admitSeeds);
      if (read.gap) missing.push(read.gap);
      else seeds = read.value ?? [];
    } else if (session.hasRoots()) {
      const read = await session.read('roots', undefined, admitSeeds);
      if (read.gap) missing.push(read.gap);
      else seeds = read.value ?? [];
    } else missing.push(gap('not-collected'));
    const result = await walk(session, seeds, 'children');
    missing = [...missing, ...result.gaps];
    return Object.freeze({
      nodes: result.marked,
      confidence: missing.length ? 'incomplete' : 'complete',
      gaps: uniqueGaps(missing),
    });
  } finally {
    session.dispose();
  }
}
