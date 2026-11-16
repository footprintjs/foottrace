import type { LogAddress } from '../../memory/eventPosition.js';
import { relation } from '../../memory/keyPaths.js';
import { normaliseStateKey } from '../../record-paths/codec.js';
import { writtenKeysForNode } from '../recordCoverage.js';
import { nodeIdFor, readNodeIdentity } from '../recordIdentity.js';
import type { RecordScopeLoader, ResolvedRecordNode } from '../recordTypes.js';
import { addressKey } from '../recordValidation.js';
import type { Adjacency, GraphContext, GraphEdge } from '../types.js';
import { nativeParentOf } from '../recordSubflows.js';
import { subflowParents } from './parents.js';
import { spendSubflowWork } from './sources.js';
import type { RecordSubflowMount } from '../recordSubflows.js';

interface ForwardState {
  edges: GraphEdge[];
  complete: boolean;
  work: { left: number };
}

/** Source identity is a whole log/commit, with a qualified value when requested. */
function refersTo(edge: GraphEdge, source: ResolvedRecordNode): boolean {
  try {
    const identity = readNodeIdentity(edge.nodeId);
    return (
      addressKey(identity.address) === addressKey(source.scope.address) &&
      identity.runtimeStageId === source.identity.runtimeStageId &&
      identity.commitIdx === source.commitIndex &&
      (source.identity.key === undefined ||
        (identity.key !== undefined && relation(identity.key, source.identity.key) !== undefined))
    );
  } catch {
    return false;
  }
}

function readsWrittenKey(reads: readonly string[], source: ResolvedRecordNode): boolean {
  const keys = writtenKeysForNode(source.scope.log[source.commitIndex], source.identity);
  return reads.some((read) => {
    const path = normaliseStateKey([read]);
    return keys.some((key) => relation(path, key) !== undefined);
  });
}

/** Reuse the admitted backward join, so an inverse cannot invent a different source. */
async function appendInverse(
  source: ResolvedRecordNode,
  address: LogAddress,
  runtimeStageId: string,
  commitIndex: number,
  key: string,
  context: GraphContext,
  loader: RecordScopeLoader,
  maximum: number,
  state: ForwardState,
): Promise<void> {
  // Charge candidates even if loading/validation refuses or the prefix names no writer.
  if (!spendSubflowWork(state.work)) {
    state.complete = false;
    return;
  }
  const loaded = await loader.loadScope(address, context);
  if ('failure' in loaded) {
    state.complete = false;
    return;
  }
  const target: ResolvedRecordNode = {
    scope: loaded,
    identity: { address, runtimeStageId, commitIdx: commitIndex, key },
    commitIndex,
  };
  if (loaded.log[commitIndex]?.runtimeStageId !== runtimeStageId) {
    state.complete = false;
    return;
  }
  const parents = await subflowParents(target, context, loader, maximum, state.work);
  if (!parents.adjacency.complete) state.complete = false;
  const nodeId = nodeIdFor(address, { runtimeStageId, commitIdx: commitIndex, key });
  for (const edge of parents.adjacency.edges) {
    if (!refersTo(edge, source) || state.edges.some((other) => other.nodeId === nodeId && other.kind === edge.kind))
      continue;
    if (nodeId === 'record:invalid' || state.edges.length >= maximum) {
      state.complete = false;
      return;
    }
    state.edges.push({ ...edge, nodeId });
    // An observed prefix is conservative in either direction.
    state.complete = false;
  }
}

async function inputChildren(
  source: ResolvedRecordNode,
  mounts: readonly RecordSubflowMount[],
  context: GraphContext,
  loader: RecordScopeLoader,
  maximum: number,
  state: ForwardState,
): Promise<void> {
  for (const mount of mounts) {
    const input = mount.inputHandoff;
    if (!input || input.status === 'partial') state.complete = false;
    if (!input || input.parent.beforeCommitIdx <= source.commitIndex) continue;
    for (const write of input.writes) {
      if (!readsWrittenKey(write.reads, source)) continue;
      await appendInverse(
        source,
        input.child.address,
        input.child.runtimeStageId,
        input.child.commitIdx,
        write.path,
        context,
        loader,
        maximum,
        state,
      );
      if (state.work.left <= 0) return;
    }
  }
}

async function outputChildren(
  source: ResolvedRecordNode,
  context: GraphContext,
  loader: RecordScopeLoader,
  maximum: number,
  state: ForwardState,
): Promise<void> {
  const parent = nativeParentOf(source.scope.address);
  if (!parent) return;
  if (!spendSubflowWork(state.work)) {
    state.complete = false;
    return;
  }
  const loaded = await loader.loadScope(parent.address, context);
  if ('failure' in loaded) {
    state.complete = false;
    return;
  }
  const declared = loaded.subflows?.record;
  if (!declared || declared.status === 'partial' || loaded.subflows?.gaps.length) state.complete = false;
  const mount = declared?.mounts.find(
    (entry) =>
      entry.runtimeStageId === parent.runtimeStageId && addressKey(entry.child) === addressKey(source.scope.address),
  );
  const output = mount?.outputHandoff;
  if (!output) {
    state.complete = false;
    return;
  }
  if (output.status === 'partial') state.complete = false;
  for (const write of output.writes) {
    if (!readsWrittenKey(write.reads, source)) continue;
    await appendInverse(
      source,
      output.parent.address,
      output.parent.runtimeStageId,
      output.parent.commitIdx,
      write.path,
      context,
      loader,
      maximum,
      state,
    );
    if (state.work.left <= 0) return;
  }
  if (declared?.collections.some((collection) => collection.branchCount > 0)) state.complete = false;
}

/** Forward-only inventory/load/cap gaps never enter the backward inspection or root rule. */
export async function subflowChildren(
  source: ResolvedRecordNode,
  context: GraphContext,
  loader: RecordScopeLoader,
  maximum: number,
  local: Adjacency,
): Promise<Adjacency> {
  const state: ForwardState = { edges: [...local.edges], complete: local.complete, work: { left: maximum } };
  const subflows = source.scope.subflows;
  if (subflows?.gaps.length || subflows?.record?.status === 'partial') state.complete = false;
  if (context.signal.aborted) return { edges: state.edges, complete: false };
  if (!writtenKeysForNode(source.scope.log[source.commitIndex], source.identity).length)
    return { edges: state.edges, complete: state.complete };
  if (subflows?.record) {
    await inputChildren(source, subflows.record.mounts, context, loader, maximum, state);
    if (subflows.record.collections.some((collection) => collection.branchCount > 0)) state.complete = false;
  }
  if (state.work.left > 0) await outputChildren(source, context, loader, maximum, state);
  else state.complete = false;
  return { edges: state.edges, complete: state.complete };
}
