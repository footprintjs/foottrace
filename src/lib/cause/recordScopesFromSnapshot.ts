import { RECORD_ADDRESS_MAX_DEPTH, recordRefusalCode, refuseRecord, spend } from '../evidence/recordData.js';
import type { LogAddress } from '../memory/eventPosition.js';
import { rootCapture, rootSources } from './recordScopesFromSnapshot/capture.js';
import {
  field,
  list,
  MAX_DISCOVERY_DEPTH,
  MAX_LOG,
  MAX_SCOPES,
  MAX_WORK,
  plain,
  sameAddress,
  snapshotAddress,
  type Budget,
} from './recordScopesFromSnapshot/read.js';
import { snapshotTree } from './recordScopesFromSnapshot/tree.js';
import type { RecordFanoutCollection, RecordSubflowMount } from './recordSubflows.js';
import type { RecordScope } from './recordTypes.js';
import { dataCopy, recordName } from './recordValidation.js';
import type { GapCode } from './types.js';

export interface SnapshotScopeGap {
  readonly code: GapCode;
  readonly address?: LogAddress;
  readonly depth?: number;
  readonly channel?: 'reads' | 'writes' | 'readSources';
}

export interface SnapshotRecordScopes {
  readonly scopes: readonly RecordScope[];
  readonly gaps: readonly SnapshotScopeGap[];
}

interface ScopeInput {
  readonly raw: unknown;
  readonly history: unknown;
  readonly address: LogAddress;
  readonly output?: RecordSubflowMount['outputHandoff'];
}

interface Projection {
  readonly scopes: RecordScope[];
  readonly gaps: SnapshotScopeGap[];
  readonly budget: Budget;
  readonly results: unknown;
  visited: number;
}

function handoff(value: unknown, budget: Budget): unknown {
  const status = field(value, 'status');
  if (status === 'partial' && field(field(value, 'limitations'), 'length') === 0) return undefined;
  return dataCopy(value, budget);
}

function controlMap(value: unknown, ids: ReadonlySet<string>, budget: Budget): RecordScope['controlDeps'] {
  if (value === undefined) return undefined;
  if (!plain(value)) throw refuseRecord();
  const rows: [string, { deciderId: string }][] = [];
  for (const id of ids) {
    spend(budget, 1);
    const row = field(value, id);
    if (row === undefined) continue;
    const deciderId = recordName(field(row, 'deciderId'));
    if (ids.has(deciderId)) rows.push([id, { deciderId }]);
  }
  return Object.freeze(Object.fromEntries(rows));
}

function childInput(state: Projection, parent: LogAddress, id: string) {
  const result = field(state.results, id);
  const raw = field(result, 'treeContext');
  const expected = { logRunId: parent.logRunId, drillPath: Object.freeze([...parent.drillPath, id]) };
  const childAddress = field(raw, 'logAddress');
  const history = field(raw, 'history');
  if (
    childAddress === undefined ||
    !Array.isArray(history) ||
    !sameAddress(snapshotAddress(childAddress, state.budget), expected)
  ) {
    state.gaps.push({ code: 'scope-boundary', address: expected });
    return undefined;
  }
  return { result, raw, history, address: Object.freeze(expected) };
}

function nextScopes(state: Projection, address: LogAddress, mounts: readonly string[], retain: boolean) {
  const children: ScopeInput[] = [];
  const records: RecordSubflowMount[] = [];
  for (const id of mounts) {
    spend(state.budget, 1);
    const child = childInput(state, address, id);
    if (child === undefined) continue;
    const input = retain
      ? (handoff(field(child.result, 'inputHandoff'), state.budget) as RecordSubflowMount['inputHandoff'])
      : undefined;
    const output = retain
      ? (handoff(field(child.result, 'outputHandoff'), state.budget) as RecordSubflowMount['outputHandoff'])
      : undefined;
    if (retain) {
      if (input === undefined || output === undefined)
        state.gaps.push({ code: 'scope-boundary', address: child.address });
      records.push({
        runtimeStageId: id,
        child: child.address,
        ...(input === undefined ? {} : { inputHandoff: input }),
        ...(output === undefined ? {} : { outputHandoff: output }),
      });
    }
    children.push({ raw: child.raw, history: child.history, address: child.address, output });
  }
  return { children, records };
}

function coveredChild(input: ScopeInput, length: number, budget: Budget): boolean {
  const cut = field(input.output, 'child'),
    address = field(cut, 'address');
  return (
    input.output?.status === 'captured' &&
    address !== undefined &&
    sameAddress(snapshotAddress(address, budget), input.address) &&
    field(cut, 'beforeCommitIdx') === length
  );
}

function visit(input: ScopeInput, state: Projection): void {
  const { raw, address } = input,
    { budget } = state;
  const depth = address.drillPath.length;
  if (++state.visited > MAX_SCOPES) throw refuseRecord('node-limit');
  spend(budget, 1);
  if (depth > RECORD_ADDRESS_MAX_DEPTH) state.gaps.push({ code: 'depth-limit', address, depth });
  if (depth > MAX_DISCOVERY_DEPTH) return;
  const projection = snapshotTree(field(raw, depth ? 'stageContexts' : 'executionTree'), budget);
  const { children, records } = nextScopes(state, address, projection.mounts, depth < RECORD_ADDRESS_MAX_DEPTH);
  if (depth <= RECORD_ADDRESS_MAX_DEPTH) {
    const log = list(input.history, budget, MAX_LOG).map((bundle) => dataCopy(bundle, budget));
    const capture = rootCapture(raw, address, log.length, budget);
    for (const channel of ['reads', 'writes', 'readSources'] as const) {
      const observed = capture?.channels[channel];
      if (observed?.status === 'disabled') state.gaps.push({ code: 'not-collected', address, channel });
      if (observed?.status === 'partial' || observed?.status === 'failed')
        state.gaps.push({ code: 'unavailable', address, channel });
    }
    const complete =
      coveredChild(input, log.length, budget) ||
      (capture?.completed === true &&
        capture.channels.reads.mode === 'full' &&
        capture.channels.reads.status === 'collected' &&
        capture.channels.writes.status === 'collected' &&
        capture.channels.writePrefixes.mode === 'reads-prefix' &&
        log.every((bundle, index) => {
          const id = field(bundle, 'runtimeStageId');
          return typeof id === 'string' && ((index === 0 && id === '') || projection.ids.has(id));
        }));
    const initialState = dataCopy(field(raw, 'initialState'), budget) as RecordScope['initialState'];
    const readSources = dataCopy(rootSources(raw, address, log.length, budget), budget) as RecordScope['readSources'];
    const inventory = field(raw, 'fanoutCollections'),
      status = field(inventory, 'status');
    const collections =
      field(inventory, 'version') === 1 && (status === 'captured' || status === 'partial')
        ? (list(field(inventory, 'collections'), budget).map((row) =>
            dataCopy(row, budget),
          ) as RecordFanoutCollection[])
        : [];
    const controlDeps = controlMap(field(raw, 'controlDeps'), projection.ids, budget);
    state.scopes.push({
      address,
      commitLog: Object.freeze(log),
      initialState,
      reads: projection.reads,
      complete,
      subflows: { version: 1, status: 'partial', mounts: records, collections },
      ...(readSources === undefined ? {} : { readSources }),
      ...(controlDeps === undefined ? {} : { controlDeps }),
    });
  }
  for (const child of children) visit(child, state);
}

/**
 * Project bounded plain-data engine snapshots for `createRecordGraph`. Use the returned gaps
 * when showing what could not be projected. This function never calls an accessor body.
 * Reflective operations can execute Proxy traps; parse inert JSON first when no caller code may run.
 */
export function recordScopesFromSnapshot(snapshot: unknown): SnapshotRecordScopes {
  const budget = { left: MAX_WORK };
  try {
    if (!plain(snapshot)) throw refuseRecord();
    const rawAddress = field(snapshot, 'logAddress');
    if (rawAddress === undefined) return { scopes: [], gaps: [{ code: 'not-collected' }] };
    const address = snapshotAddress(rawAddress, budget);
    if (address.drillPath.length !== 0) throw refuseRecord();
    const state = { scopes: [], gaps: [], budget, results: field(snapshot, 'subflowResults'), visited: 0 };
    visit({ raw: snapshot, history: field(snapshot, 'commitLog'), address }, state);
    return { scopes: state.scopes, gaps: state.gaps };
  } catch (error) {
    return { scopes: [], gaps: [{ code: recordRefusalCode(error) ?? 'invalid-data' }] };
  }
}
