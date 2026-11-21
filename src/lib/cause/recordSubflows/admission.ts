import type { GapCode } from '../../evidence/codes.js';
import type { LogAddress } from '../../memory/eventPosition.js';
import { lowerBound, relation } from '../../memory/keyPaths.js';
import type { CommitBundle } from '../../memory/types.js';
import { RecordRefusal, recordRefusalCode, spend } from '../recordValidation.js';
import { isNativeChild, nativeParentOf } from './identity.js';
import {
  address,
  admission,
  execution,
  integer,
  limitations,
  list,
  literal,
  name,
  object,
  refuse,
  sameAddress,
  status,
  version,
  type SubflowAdmission,
} from './data.js';
import type {
  PreparedRecordSubflows,
  RecordFanoutCollection,
  RecordFanoutLimitation,
  RecordHandoffWrite,
  RecordInputHandoff,
  RecordInputLimitation,
  RecordOutputHandoff,
  RecordOutputLimitation,
  RecordSubflowMount,
} from './types.js';

const OUTPUT_LIMITATIONS: readonly RecordOutputLimitation[] = [
  'explicit-output',
  'privacy-active',
  'budget-exhausted',
  'output-mutated',
  'commit-time-read',
];
const INPUT_LIMITATIONS: readonly RecordInputLimitation[] = [
  'privacy-active',
  'budget-exhausted',
  'parent-log-advanced',
  'resume-seed',
  'commit-time-read',
  'selector-reads-unavailable',
];
const FANOUT_LIMITATIONS: readonly RecordFanoutLimitation[] = [
  'privacy-active',
  'budget-exhausted',
  'branches-truncated',
  'missing-child-record',
  'explicit-output',
  'failed-slot',
];
const HANDOFF_FIELDS = ['version', 'attribution', 'parent', 'child', 'writes', 'status', 'limitations'];

/** Every retained reference spends the existing producer envelope and the shared reader field allowance. */
function writes(value: unknown, state: SubflowAdmission): readonly RecordHandoffWrite[] {
  const paths = new Set<string>();
  return list(
    value,
    128,
    (entry) => {
      const row = object(entry, ['path', 'reads'], [], state);
      const path = name(row.path, state, true);
      if (paths.has(path)) return refuse();
      paths.add(path);
      const reads = list(
        row.reads,
        4096,
        (raw) => {
          if (++state.references > 4096) throw new RecordRefusal('node-limit');
          return name(raw, state);
        },
        state,
      );
      if (new Set(reads).size !== reads.length) return refuse();
      return Object.freeze({ path, reads });
    },
    state,
  );
}

/** Bind the cited bundle to its own execution, index and optional exact path. */
function writtenAt(log: readonly CommitBundle[], id: string, index: number, path?: string): CommitBundle {
  const row = log[index];
  if (
    !row ||
    row.runtimeStageId !== id ||
    (row.idx !== undefined && row.idx !== index) ||
    row.phase === 'exit' ||
    (path !== undefined && !row.trace.some((entry) => entry.path === path))
  )
    return refuse();
  return row;
}

function indexOutputCommits(log: readonly CommitBundle[], budget: { left: number }): Map<string, number[]> {
  const indexes = new Map<string, number[]>();
  for (let index = 0; index < log.length; index++) {
    spend(budget, 1);
    const { runtimeStageId } = log[index];
    const execution = indexes.get(runtimeStageId);
    if (execution) execution.push(index);
    else indexes.set(runtimeStageId, [index]);
  }
  return indexes;
}

type OutputCommitIndexes = (executionId: string) => readonly number[];

/** A continuation of the same execution can supersede a mapped write. Later visits are independent. */
function checkLaterOutputWrites(
  log: readonly CommitBundle[],
  targetIndex: number,
  executionId: string,
  mapped: readonly RecordHandoffWrite[],
  budget: { left: number },
  outputCommitIndexes: OutputCommitIndexes,
): void {
  if (mapped.length === 0) return;
  const indexes = outputCommitIndexes(executionId);
  for (let offset = lowerBound(indexes, targetIndex + 1); offset < indexes.length; offset++) {
    spend(budget, 1);
    const bundle = log[indexes[offset]];
    if (bundle.phase === 'exit') continue;
    for (const entry of bundle.trace) {
      for (const write of mapped) {
        spend(budget, 1);
        if (relation(entry.path, write.path) !== undefined) refuse();
      }
    }
  }
}

function outputHandoff(
  value: unknown,
  parent: LogAddress,
  child: LogAddress,
  id: string,
  log: readonly CommitBundle[],
  budget: { left: number },
  outputCommitIndexes: OutputCommitIndexes,
): RecordOutputHandoff {
  const state = admission(budget),
    raw = object(value, HANDOFF_FIELDS, [], state);
  version(raw.version);
  literal(raw.attribution, ['observed-read-prefix']);
  const capture = status(raw.status);
  const limits = limitations(raw.limitations, OUTPUT_LIMITATIONS, capture, state);
  const p = object(raw.parent, ['address', 'runtimeStageId', 'commitIdx'], [], state);
  const parentAddress = address(p.address, state),
    runtimeStageId = execution(p.runtimeStageId, state);
  const commitIdx = integer(p.commitIdx, log.length - 1);
  if (!sameAddress(parentAddress, parent) || runtimeStageId !== id) return refuse();
  const target = writtenAt(log, id, commitIdx);
  const c = object(raw.child, ['address', 'beforeCommitIdx'], [], state);
  const childAddress = address(c.address, state),
    beforeCommitIdx = integer(c.beforeCommitIdx, 4096);
  if (!sameAddress(childAddress, child)) return refuse();
  const mapped = writes(raw.writes, state);
  if (
    mapped.some((write) => !target.trace.some((entry) => entry.path === write.path)) ||
    (limits.includes('privacy-active') && mapped.some((write) => write.reads.length))
  )
    return refuse();
  checkLaterOutputWrites(log, commitIdx, runtimeStageId, mapped, budget, outputCommitIndexes);
  return Object.freeze({
    version: 1,
    attribution: 'observed-read-prefix',
    parent: Object.freeze({ address: parentAddress, runtimeStageId, commitIdx }),
    child: Object.freeze({ address: childAddress, beforeCommitIdx }),
    writes: mapped,
    status: capture,
    limitations: limits,
  });
}

function inputHandoff(
  value: unknown,
  parent: LogAddress,
  child: LogAddress,
  id: string,
  log: readonly CommitBundle[],
  budget: { left: number },
  gaps: Set<GapCode>,
): RecordInputHandoff {
  const state = admission(budget),
    raw = object(value, HANDOFF_FIELDS, [], state);
  version(raw.version);
  literal(raw.attribution, ['observed-read-prefix']);
  const capture = status(raw.status);
  const limits = limitations(raw.limitations, INPUT_LIMITATIONS, capture, state);
  const p = object(raw.parent, ['address', 'beforeCommitIdx'], [], state);
  const parentAddress = address(p.address, state),
    beforeCommitIdx = integer(p.beforeCommitIdx, log.length);
  if (!sameAddress(parentAddress, parent)) return refuse();
  const first = log.findIndex((entry) => entry.runtimeStageId === id);
  if (first >= 0 && beforeCommitIdx > first) return refuse();
  if (first < 0) gaps.add('not-collected');
  const c = object(raw.child, ['address', 'runtimeStageId', 'commitIdx'], [], state);
  const childAddress = address(c.address, state),
    runtimeStageId = execution(c.runtimeStageId, state);
  const commitIdx = integer(c.commitIdx, 0);
  if (!sameAddress(childAddress, child) || runtimeStageId !== id) return refuse();
  const mapped = writes(raw.writes, state);
  if (
    limits.some((code) => ['privacy-active', 'parent-log-advanced', 'selector-reads-unavailable'].includes(code)) &&
    mapped.some((write) => write.reads.length)
  )
    return refuse();
  if (limits.includes('resume-seed') && mapped.length) return refuse();
  return Object.freeze({
    version: 1,
    attribution: 'observed-read-prefix',
    parent: Object.freeze({ address: parentAddress, beforeCommitIdx }),
    child: Object.freeze({ address: childAddress, runtimeStageId, commitIdx }),
    writes: mapped,
    status: capture,
    limitations: limits,
  });
}

function mount(
  value: unknown,
  parent: LogAddress,
  log: readonly CommitBundle[],
  state: SubflowAdmission,
  ids: Set<string>,
  children: Set<string>,
  gaps: Set<GapCode>,
  outputCommitIndexes: OutputCommitIndexes,
): RecordSubflowMount {
  const raw = object(value, ['runtimeStageId', 'child'], ['inputHandoff', 'outputHandoff'], state);
  const runtimeStageId = execution(raw.runtimeStageId, state),
    child = address(raw.child, state);
  const childKey = JSON.stringify([child.logRunId, ...child.drillPath]);
  if (!isNativeChild(parent, child, runtimeStageId) || ids.has(runtimeStageId) || children.has(childKey))
    return refuse();
  ids.add(runtimeStageId);
  children.add(childKey);
  return Object.freeze({
    runtimeStageId,
    child,
    ...(Object.hasOwn(raw, 'inputHandoff')
      ? { inputHandoff: inputHandoff(raw.inputHandoff, parent, child, runtimeStageId, log, state.budget, gaps) }
      : {}),
    ...(Object.hasOwn(raw, 'outputHandoff')
      ? {
          outputHandoff: outputHandoff(
            raw.outputHandoff,
            parent,
            child,
            runtimeStageId,
            log,
            state.budget,
            outputCommitIndexes,
          ),
        }
      : {}),
  });
}

function collection(
  value: unknown,
  parent: LogAddress,
  log: readonly CommitBundle[],
  budget: { left: number },
  maximumScopes: number,
  targets: Set<string>,
): RecordFanoutCollection {
  const state = admission(budget);
  const raw = object(
    value,
    ['version', 'attribution', 'parent', 'totalItems', 'branchCount', 'slots', 'status', 'limitations'],
    [],
    state,
  );
  version(raw.version);
  literal(raw.attribution, ['observed-scope-collection']);
  const capture = status(raw.status),
    limits = limitations(raw.limitations, FANOUT_LIMITATIONS, capture, state);
  const p = object(raw.parent, ['address', 'runtimeStageId', 'commitIdx', 'path'], [], state);
  const parentAddress = address(p.address, state),
    runtimeStageId = execution(p.runtimeStageId, state);
  const commitIdx = integer(p.commitIdx, log.length - 1),
    path = name(p.path, state, true);
  if (!sameAddress(parent, parentAddress)) return refuse();
  writtenAt(log, runtimeStageId, commitIdx, path);
  const target = JSON.stringify([runtimeStageId, commitIdx, path]);
  if (targets.has(target)) return refuse();
  targets.add(target);
  const totalItems = integer(raw.totalItems),
    branchCount = integer(raw.branchCount, totalItems);
  let previous = -1;
  const children = new Set<string>();
  const slots = list(
    raw.slots,
    maximumScopes,
    (value) => {
      const slot = object(value, ['index', 'child', 'observation'], [], state);
      const index = integer(slot.index, branchCount - 1);
      if (index <= previous) return refuse();
      previous = index;
      const c = object(slot.child, ['address', 'beforeCommitIdx'], [], state);
      const childAddress = address(c.address, state),
        beforeCommitIdx = integer(c.beforeCommitIdx, 4096);
      const containing = nativeParentOf(childAddress);
      const key = JSON.stringify([childAddress.logRunId, ...childAddress.drillPath]);
      if (!containing || !isNativeChild(parent, childAddress, containing.runtimeStageId) || children.has(key))
        return refuse();
      children.add(key);
      const observation = literal(slot.observation, ['scope-snapshot', 'explicit-output', 'failed-slot']);
      if (observation !== 'scope-snapshot' && (!limits.includes(observation) || capture !== 'partial')) return refuse();
      return Object.freeze({ index, child: Object.freeze({ address: childAddress, beforeCommitIdx }), observation });
    },
    state,
  );
  if (
    (capture === 'captured' && slots.length !== branchCount) ||
    (limits.includes('privacy-active') && slots.length) ||
    (branchCount < totalItems && !limits.includes('branches-truncated')) ||
    (slots.length < branchCount &&
      !limits.some((code) => ['privacy-active', 'budget-exhausted', 'missing-child-record'].includes(code)))
  )
    return refuse();
  return Object.freeze({
    version: 1,
    attribution: 'observed-scope-collection',
    parent: Object.freeze({ address: parentAddress, runtimeStageId, commitIdx, path }),
    totalItems,
    branchCount,
    slots,
    status: capture,
    limitations: limits,
  });
}

/** Bad metadata withholds only this channel. The caller retains its separately admitted local log. */
export function prepareRecordSubflows(
  value: unknown,
  parent: LogAddress,
  log: readonly CommitBundle[],
  budget: { left: number },
  maximumScopes: number,
): PreparedRecordSubflows {
  if (value === undefined) return Object.freeze({ gaps: Object.freeze([]) });
  try {
    if (
      !Number.isSafeInteger(maximumScopes) ||
      maximumScopes < 1 ||
      maximumScopes > 256 ||
      !Number.isSafeInteger(budget.left) ||
      budget.left < 0
    )
      return refuse();
    const state = admission(budget),
      raw = object(value, ['version', 'status', 'mounts', 'collections'], [], state);
    version(raw.version);
    const capture = status(raw.status),
      gaps = new Set<GapCode>();
    const ids = new Set<string>(),
      children = new Set<string>(),
      targets = new Set<string>();
    // The lazy index is shared by every output handoff in this admission.
    let outputIndex: Map<string, number[]> | undefined;
    const outputCommitIndexes: OutputCommitIndexes = (executionId) => {
      outputIndex ??= indexOutputCommits(log, budget);
      return outputIndex.get(executionId) ?? [];
    };
    const mounts = list(
      raw.mounts,
      maximumScopes,
      (entry) => mount(entry, parent, log, state, ids, children, gaps, outputCommitIndexes),
      state,
    );
    const collections = list(
      raw.collections,
      128,
      (entry) => collection(entry, parent, log, budget, maximumScopes, targets),
      state,
    );
    return Object.freeze({
      record: Object.freeze({ version: 1, status: capture, mounts, collections }),
      gaps: Object.freeze([...gaps]),
    });
  } catch (error) {
    return Object.freeze({ gaps: Object.freeze([recordRefusalCode(error) ?? 'invalid-data']) });
  }
}
