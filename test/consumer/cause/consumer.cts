import {
  couldHaveChanged,
  explain,
  pathTo,
  type BackwardResult,
  type CauseGraph,
  type CauseResult,
  type CouldHaveChangedResult,
  type RootSelection,
  type RootStrategy,
  type RootStrategyWalk,
  type TraversalLimits,
  type WithheldRoot,
} from 'foottrace/cause';
import type { Attention, StoredRecord } from 'foottrace';

const mark: Attention = { kind: 'error', reason: 'ERROR_RECORDED', evidence: ['proof:source'] };
declare const graph: CauseGraph;
const result: Promise<CauseResult> = explain(graph, 'source');
void mark;
void result;
const reverse: Promise<BackwardResult | undefined> = explain(graph, 'source', { includeBackward: true }).then(
  (finding) => finding.backward,
);
void reverse;
const withheld: WithheldRoot = { nodeId: 'source', reason: 'host-policy' };
const rankRoots: RootStrategy = (_marked, _context, walk: RootStrategyWalk): RootSelection => {
  const path = pathTo(walk.edges, 'symptom', withheld.nodeId);
  // @ts-expect-error Public paths are immutable in both module formats.
  path.push(withheld.nodeId);
  return { select: [], withheld: [withheld] };
};
const withheldResult: Promise<readonly WithheldRoot[] | undefined> = explain(graph, 'symptom', { rankRoots }).then(
  (finding) => finding.withheldRoots,
);
void withheldResult;
const legacyRankRoots: RootStrategy = (candidates, { signal }) =>
  signal.aborted ? [] : candidates.map(({ nodeId }) => nodeId);
void explain(graph, 'source', { rankRoots: legacyRankRoots });
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

import type { Adjacency, Gap } from 'foottrace/cause';
const parentPage: Adjacency = {
  edges: [],
  complete: false,
  gaps: [{ code: 'not-collected', nodeId: 'source', evidence: ['proof:missing-parents'] }],
};
const legacyPage: Adjacency = { edges: [], complete: true };
const directionalGraph: CauseGraph = {
  parents: () => parentPage,
  children: () => legacyPage,
  attention: () => [mark],
  gaps: () => [],
};
void explain(directionalGraph, 'source', { includeBackward: true });
// @ts-expect-error Page reasons remain immutable at the public door.
parentPage.gaps?.push({ code: 'redacted', evidence: [] });
// @ts-expect-error Adjacency reasons use the existing closed gap vocabulary.
const invalidPageReason: Gap = { code: 'invented', evidence: [] };
void invalidPageReason;

import { bindSourceLinkWrites, type SourceLinkRowLocation, type SourceLinkWrite } from 'foottrace/cause';
declare const locators: readonly SourceLinkRowLocation[];
const bindings = bindSourceLinkWrites(sourceScope, locators);
const firstBinding: SourceLinkWrite | undefined = bindings.writes[0];
const complete: boolean = bindings.complete;
void firstBinding;
void complete;
// @ts-expect-error The result contains an immutable positional list.
bindings.writes.push(undefined);

declare const recorded: StoredRecord;
const skipped: Promise<CouldHaveChangedResult> = couldHaveChanged(recorded, 'total', 1);
void skipped;
