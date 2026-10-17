/** Read a recorded execution: replay, time travel, slicing and attribution. */
export type { CommitIdx, ExecutionCounter, ExecutionIndex, RuntimeStageId } from './lib/ids/runtimeStageId.js';
export {
  buildRuntimeStageId,
  createExecutionCounter,
  parseRuntimeStageId,
  splitStageId,
} from './lib/ids/runtimeStageId.js';
export type { AttemptId } from './lib/ids/attemptId.js';
export { buildAttemptId, parseAttemptId } from './lib/ids/attemptId.js';
export { UnknownVerbError } from './lib/memory/verbs.js';
export type { CommitBundle, MemoryPatch, TraceEntry } from './lib/memory/types.js';
export type { ExecutionTree } from './lib/memory/types.js';
export { applySmartMerge } from './lib/memory/verbs.js';
export type {
  ValueBasis,
  ValueBasisOptions,
  ValueWithBasis,
  WriterBasis,
  WriterWithBasis,
} from './lib/memory/commitLogUtils.js';
export {
  buildCommitIndex,
  commitIndexOf,
  commitValueAt,
  commitValueAtWithBasis,
  findCommit,
  findCommits,
  findLastWriter,
  findLastWriterWithBasis,
  inferLegacyPhases,
  recordsPhases,
} from './lib/memory/commitLogUtils.js';
export type { CommitPhase } from './lib/memory/types.js';
export type {
  AxisRefusal,
  AxisSplit,
  BookendedAxis,
  FoldBasis,
  FoldedState,
  FoldSource,
  LogGap,
  Mark,
  Move,
  MoveRefusal,
  Stop,
  StopFilter,
  StopKind,
  StoredLog,
  StoredNote,
  StoredRecord,
  StoredRecordLimits,
  TimeTravel,
  TimeTravelOptions,
  TimeTravelSource,
  TimeTravelStrategy,
} from './lib/time-travel/index.js';
export {
  commitStops,
  commitStopsStrategy,
  filterStops,
  isCommitBundle,
  readStoredRecord,
  splitAxis,
  stateAt,
  tagStops,
  timeTravel,
} from './lib/time-travel/index.js';
export type { LogOutcome, Meta } from './lib/memory/sink.js';
export type {
  CausalChainOptions,
  CausalEdge,
  CausalNode,
  ControlDependency,
  ControlDepLookup,
  EdgeWeigher,
  KeysReadLookup,
} from './lib/memory/backtrack.js';
export { causalChain, flattenCausalDAG, formatCausalChain } from './lib/memory/backtrack.js';
export type { UntrackedSource } from './lib/memory/types.js';
export type {
  ArrayProvenance,
  AttributionBasis,
  ElementBirth,
  FedBasis,
  ForwardEdge,
  ForwardNode,
  ForwardRead,
  ForwardSlice,
  ForwardSliceJSON,
  HonestyNote,
  HonestyNoteCode,
  KeyMoment,
  KeysReadSource,
  KeyTimeline,
  MissingProvenanceReason,
  MissingSliceReason,
  ReadsCoverage,
  SliceJSON,
  StateKey,
  VariableSlice,
} from './lib/slice/index.js';
export type { ForwardSliceForKeyOptions, KeyTimelineOptions, SliceForKeyOptions } from './lib/slice/index.js';
export {
  arrayProvenance,
  elementProvenance,
  formatForwardSlice,
  formatSlice,
  formatTimeline,
  forwardSliceForKey,
  forwardSliceToJSON,
  keysReadFromExecutionTree,
  keysReadFromMap,
  keyTimeline,
  resolveKeysReadSource,
  sliceForKey,
  sliceToJSON,
} from './lib/slice/index.js';
export type { HonestyCode } from './lib/memory/honesty.js';
export { HONESTY_CODES } from './lib/memory/honesty.js';
export type { RangeEntry, RangeToken } from './lib/recorder/CommitRangeIndex.js';
export { CommitRangeIndex } from './lib/recorder/CommitRangeIndex.js';
export type { CommitValuesMode } from './lib/memory/types.js';
export type { EmitSourcePosition, LogAddress } from './lib/memory/eventPosition.js';
export {
  EXECUTION_DELIMITER,
  PATH_DELIMITER,
  isExecutionKey,
  joinPath,
  pathSegments as idPathSegments,
  stageIdOf,
  subflowSegmentsOf,
} from './lib/ids/runtimeStageId.js';
export { deepEqual } from './lib/memory/equality.js';
export { serveRecord } from './lib/capture/freeze.js';

/** Record attention types are shared with producers; the optional cause reader has its own door. */
export type { Attention, AttentionKind } from './lib/cause/types.js';
