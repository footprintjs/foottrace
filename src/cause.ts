/** Optional read-only cause and impact queries over recorded dependency graphs. */
export { explain, attentionList } from './lib/cause/explain.js';
export { largestDrop, mostAffected } from './lib/cause/strategies.js';
export { createRecordGraph } from './lib/cause/recordAdapter.js';
export { createStoredRecordGraph } from './lib/cause/storedRecordAdapter.js';
export type {
  Adjacency,
  AttentionListOptions,
  AttentionListResult,
  AttentionReason,
  CauseGraph,
  CauseResult,
  Confidence,
  ExplainOptions,
  Gap,
  GapCode,
  GraphContext,
  GraphEdge,
  ImpactResult,
  ImpactStrategy,
  MarkedNode,
  MaybePromise,
  NodeId,
  RootStrategy,
  TraversedEdge,
  TraversalLimits,
  WalkLimits,
} from './lib/cause/types.js';
export type { RecordScope, RecordGraphOptions, RecordCauseGraph, RecordNode } from './lib/cause/recordAdapter.js';
export type { StoredRecordScope, StoredRecordHost } from './lib/cause/storedRecordAdapter.js';

export type { RecordReadSources, ReadSourceExecution } from './lib/cause/recordSources.js';
