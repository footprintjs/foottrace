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
const sourceScope: RecordScope = {
  address: { logRunId: 'run', drillPath: [] },
  commitLog: [],
  initialState: {},
  readSources: sources,
};
void sourceScope;

import type { TraceEntry } from 'foottrace';
import { RecordFrame } from 'foottrace/write';
declare const answerFrame: RecordFrame;
answerFrame.noteReadAttempt('fetch#0@1.1@1');
const answerRow: TraceEntry = { path: 'result', verb: 'set', readAttempts: ['fetch#0@1.1@1'] };
// @ts-expect-error Answer ceilings are immutable through the public record type.
answerRow.readAttempts?.push('fetch#0@1.2@1');
void answerRow;

import {
  causalChain,
  forwardSliceForKey,
  keyTimeline,
  sliceForKey,
  SliceQueryError,
  type SliceWalkOptions,
} from 'foottrace';
const rootLimits: SliceWalkOptions = {
  maxDepth: 20,
  maxNodes: 100,
  maxEdges: 1000,
  maxWork: 1000000,
  timeoutMs: 1000,
  signal: new AbortController().signal,
};
const chain = causalChain([], 'root#0', () => [], rootLimits);
const backwardSlice = sliceForKey([], 'x', () => [], rootLimits);
const forwardSlice = forwardSliceForKey([], 'x', () => [], { ...rootLimits, maxReads: 2000 });
const timeline = keyTimeline([], 'x', () => [], { maxMoments: 2000, timeoutMs: 1000 });
const edgeCut: boolean | undefined = chain?.truncated?.byEdges;
const readCut: boolean | undefined = forwardSlice.root?.truncated?.byReads;
const momentCut: true | undefined = timeline.truncated?.byMoments;
const stopped: string = new SliceQueryError('SLICE_CANCELLED').code;
void [backwardSlice, edgeCut, readCut, momentCut, stopped];
// @ts-expect-error Signals must be AbortSignals rather than model-provided strings.
causalChain([], 'root', () => [], { signal: 'stop' });
