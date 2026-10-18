import { explain, type CauseGraph, type CauseResult, type TraversalLimits } from 'foottrace/cause';
import type { Attention } from 'foottrace';

const mark: Attention = { kind: 'error', reason: 'ERROR_RECORDED', evidence: ['proof:source'] };
declare const graph: CauseGraph;
const result: Promise<CauseResult> = explain(graph, 'source');
void mark;
void result;
const backward: TraversalLimits = { maxNodes: 10, maxCalls: 50 };
void explain(graph, 'source', { backward, impact: { maxNodes: 10, maxDepth: 0 } });
// @ts-expect-error The enclosing query is the sole owner of the deadline.
const invalidDirection: TraversalLimits = { timeoutMs: 10 };
void invalidDirection;

// @ts-expect-error Public node identities are strings in both module formats.
explain(graph, 1);
