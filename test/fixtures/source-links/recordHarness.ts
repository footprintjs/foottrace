import { createRecordGraph, createStoredRecordGraph } from '../../../src/cause.js';
import type {
  RecordScope,
  RecordSourceLink,
  ServedRow,
  SourceLinkLocator,
  SourceLinkPolicy,
  SourceLinkRow,
  StoredRecordScope,
} from '../../../src/cause.js';
import type { RecordGraphOptions } from '../../../src/lib/cause/recordTypes.js';
import type { CommitBundle, TraceEntry } from '../../../src/lib/memory/types.js';

export const address: RecordScope['address'] = { logRunId: 'source-link-fixture', drillPath: [] };
export const context = () => ({ signal: new AbortController().signal });
export const adapters = ['memory', 'stored'] as const;
export const encodings = ['full', 'delta'] as const;
export type Adapter = (typeof adapters)[number];
export type Encoding = (typeof encodings)[number];

export function bundle(
  idx: number,
  runtimeStageId: string,
  overwrite: CommitBundle['overwrite'],
  trace: TraceEntry[] = Object.keys(overwrite).map((path) => ({ path, verb: 'set' })),
  updates: CommitBundle['updates'] = {},
): CommitBundle {
  return {
    idx,
    runtimeStageId,
    stageId: runtimeStageId,
    stage: runtimeStageId,
    trace,
    overwrite,
    updates,
    redactedPaths: [],
  };
}

export function witness(input: NonNullable<SourceLinkRow['input']>, output: SourceLinkRow['output']): SourceLinkRow {
  return {
    kind: 'source-link',
    version: 1,
    linkBasis: 'reference',
    check: 'redeemed',
    consumer: 'consumer',
    output,
    input,
  };
}

export function servedWrite(idx: number, served: ServedRow['served']): CommitBundle {
  const row: ServedRow = { kind: 'served', version: 1, consumer: 'consumer', served };
  return bundle(idx, row.consumer, { served: [row] });
}

export function linkFor(
  row: SourceLinkRow,
  output: Pick<RecordSourceLink['output'], 'runtimeStageId' | 'commitIdx'>,
  evidence: RecordSourceLink['witness'],
): RecordSourceLink {
  const { kind: _, version: __, consumer, ...fields } = row;
  return {
    ...fields,
    consumer: { runtimeStageId: consumer },
    output: { ...row.output, ...output },
    served: { key: 'served' },
    witness: evidence,
  };
}

export function scopeFor(
  initialState: Record<string, unknown>,
  commitLog: readonly CommitBundle[],
  links: readonly RecordSourceLink[],
  scopeAddress = address,
): RecordScope {
  return {
    address: scopeAddress,
    initialState,
    commitLog,
    reads: {},
    controlDeps: {},
    attention: {},
    complete: true,
    sourceLinks: { version: 1, status: 'captured', links, limitations: [] },
  };
}

function stored(scope: RecordScope): StoredRecordScope & Pick<RecordScope, 'address'> {
  const { address, initialState, commitLog } = scope;
  return {
    ...scope,
    entries: [
      { kind: 'opened', at: 0, address, initialState },
      ...(commitLog as readonly CommitBundle[]).map((bundle) => ({ kind: 'commit' as const, at: 1, address, bundle })),
      { kind: 'closed', at: 2, address, outcome: 'ok', commits: commitLog.length },
    ],
  };
}

export function reader(adapter: Adapter, scopes: readonly RecordScope[], options: RecordGraphOptions) {
  if (adapter === 'memory') return createRecordGraph(scopes, options);
  const recordings = scopes.map(stored);
  return createStoredRecordGraph(
    {
      loadLog(wanted) {
        const recording = recordings.find(
          ({ address }) =>
            address.logRunId === wanted.logRunId &&
            address.drillPath.length === wanted.drillPath.length &&
            address.drillPath.every((stage, i) => stage === wanted.drillPath[i]),
        );
        if (!recording) throw new Error('Fixture scope was not supplied');
        return recording;
      },
    },
    options,
  );
}

export function parents(
  adapter: Adapter,
  scope: RecordScope,
  output: RecordSourceLink['output'],
  options: RecordGraphOptions,
) {
  const graph = reader(adapter, [scope], options);
  return graph.parents(graph.nodeId(scope.address, output), context());
}

/** A read grants only the selected locator, never the containing array or object. */
export function exactPolicy(address: RecordScope['address'], link: RecordSourceLink): SourceLinkPolicy {
  const sameSelection = (
    location: SourceLinkLocator,
    selection: Pick<SourceLinkLocator, 'key' | 'element' | 'pointer'>,
  ) =>
    location.key === selection.key && location.element === selection.element && location.pointer === selection.pointer;
  return (location) => {
    if (
      location.address.logRunId !== address.logRunId ||
      location.address.drillPath.length !== address.drillPath.length ||
      !location.address.drillPath.every((stage, i) => stage === address.drillPath[i])
    )
      return false;
    if (location.at === 'view') {
      return (
        link.input !== undefined &&
        location.consumer === link.consumer.runtimeStageId &&
        sameSelection(location, link.input)
      );
    }
    return (
      [link.output, link.witness].some(
        (write) =>
          location.runtimeStageId === write.runtimeStageId &&
          location.commitIdx === write.commitIdx &&
          sameSelection(location, write),
      ) ||
      (link.served !== undefined &&
        location.runtimeStageId === link.consumer.runtimeStageId &&
        location.commitIdx === undefined &&
        sameSelection(location, link.served))
    );
  };
}
