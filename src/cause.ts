/** Optional read-only cause and impact queries over recorded dependency graphs. */
export { explain, attentionList } from './lib/cause/explain.js';
export { pathTo } from './lib/cause/walk.js';
export { largestDrop, mostAffected } from './lib/cause/strategies.js';
export { recordScopesFromSnapshot } from './lib/cause/recordScopesFromSnapshot.js';
export type { SnapshotRecordScopes, SnapshotScopeGap } from './lib/cause/recordScopesFromSnapshot.js';
export { createRecordGraph } from './lib/cause/recordAdapter.js';
export { createStoredRecordGraph } from './lib/cause/storedRecordAdapter.js';
export type {
  Adjacency,
  AttentionListOptions,
  AttentionListResult,
  AttentionReason,
  BackwardResult,
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
  RootSelection,
  RootStrategy,
  RootStrategyWalk,
  SourceLinkPage,
  TraversedEdge,
  TraversalLimits,
  WalkLimits,
  WithheldRoot,
} from './lib/cause/types.js';
export type {
  CaptureAwareRecordGraph,
  RecordScope,
  RecordGraphOptions,
  RecordCauseGraph,
  RecordNode,
} from './lib/cause/recordAdapter.js';
export type { StoredRecordScope, StoredRecordHost } from './lib/cause/storedRecordAdapter.js';

export type { RecordReadSources, ReadSourceExecution } from './lib/cause/recordSources.js';
export type {
  RecordFanoutCollection,
  RecordFanoutLimitation,
  RecordInputHandoff,
  RecordInputLimitation,
  RecordOutputHandoff,
  RecordOutputLimitation,
  RecordSubflowMount,
  RecordSubflows,
} from './lib/cause/recordSubflows.js';
export type {
  CaptureChannel,
  CaptureCoverage,
  CaptureFailure,
  CaptureMode,
  CaptureQuery,
  CaptureReason,
  CaptureWitness,
} from './lib/cause/recordCapture.js';

export { bindSourceLinkWrite, bindSourceLinkWrites } from './lib/cause/sourceLinks/bind.js';
export { readSourceLinkRow, readServedRow } from './lib/cause/sourceLinks/rows.js';
export type {
  RecordSourceLink,
  RecordSourceLinks,
  ServedRow,
  SourceLink,
  SourceLinkGap,
  SourceLinkLocator,
  SourceLinkPolicy,
  SourceLinkRow,
  SourceLinkRowLocation,
  SourceLinkWrite,
} from './lib/cause/sourceLinks/types.js';
