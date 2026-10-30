import { explain, type BackwardResult, type CauseGraph, type CauseResult, type TraversalLimits } from 'foottrace/cause';
import type { Attention } from 'foottrace';

const mark: Attention = { kind: 'error', reason: 'ERROR_RECORDED', evidence: ['proof:source'] };
declare const graph: CauseGraph;
const result: Promise<CauseResult> = explain(graph, 'source');
void mark;
void result;
const reverse: Promise<BackwardResult | undefined> = explain(graph, 'source', { includeBackward: true }).then(
  (finding) => finding.backward,
);
void reverse;
// @ts-expect-error Backward evidence is requested with a boolean, not a model-provided string.
void explain(graph, 'source', { includeBackward: 'true' });
const backward: TraversalLimits = { maxNodes: 10, maxCalls: 50 };
void explain(graph, 'source', { backward, impact: { maxNodes: 10, maxDepth: 0 } });
// @ts-expect-error The enclosing query is the sole owner of the deadline.
const invalidDirection: TraversalLimits = { timeoutMs: 10 };
void invalidDirection;

// @ts-expect-error Public node identities are strings in both module formats.
explain(graph, 1);

import type { RecordReadSources, RecordScope } from 'foottrace/cause';
declare const sources: RecordReadSources;
const sourceScope: RecordScope = { address: { logRunId: 'run', drillPath: [] }, commitLog: [], initialState: {}, readSources: sources };
void sourceScope;
