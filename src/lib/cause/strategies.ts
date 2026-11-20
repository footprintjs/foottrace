import type { GraphContext, MarkedNode, NodeId } from './types.js';

type ScoreStrategy = (candidates: readonly MarkedNode[], context: GraphContext) => readonly NodeId[];

/** Host-computed quality drops or impact counts: scores rank recorded candidates, never create evidence. */
function maximum(scores: ReadonlyMap<NodeId, number>): ScoreStrategy {
  return (candidates) => {
    let best = -Infinity;
    const tied: NodeId[] = [];
    for (const candidate of candidates) {
      const score = scores.get(candidate.nodeId);
      if (score === undefined || !Number.isFinite(score)) throw new TypeError('CAUSE_STRATEGY_EVIDENCE_MISSING');
      if (score > best) {
        best = score;
        tied.length = 0;
      }
      if (score === best) tied.push(candidate.nodeId);
    }
    return Object.freeze(tied);
  };
}
export const largestDrop = (scores: ReadonlyMap<NodeId, number>): ScoreStrategy => maximum(scores);
export const mostAffected = (counts: ReadonlyMap<NodeId, number>): ScoreStrategy => maximum(counts);
