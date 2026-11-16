import { relation } from '../../memory/keyPaths.js';
import type { LogAddress } from '../../memory/eventPosition.js';
import { nativeParentOf, isNativeChild } from '../recordSubflows.js';
import type { RecordHandoffWrite, RecordInputHandoff, RecordOutputHandoff } from '../recordSubflows.js';
import { addressKey } from '../recordValidation.js';
import type {
  LoadedRecordScope,
  PreparedRecordScope,
  RecordInspection,
  RecordScopeLoader,
  ResolvedRecordNode,
} from '../recordTypes.js';
import type { Gap, GapCode, GraphContext, GraphEdge } from '../types.js';
import { spendSubflowWork, subflowSource } from './sources.js';

class BoundaryResult {
  private readonly edges: GraphEdge[] = [];
  private readonly gaps = new Map<GapCode, { code: GapCode; evidence: string[] }>();

  constructor(private readonly maximumEdges: number) {}

  addGap(code: GapCode, evidence: readonly string[] = []): void {
    const gap = this.gaps.get(code) ?? { code, evidence: [] };
    this.gaps.set(code, gap);
    for (const reference of evidence) {
      if (gap.evidence.includes(reference)) continue;
      if (gap.evidence.length >= 32) {
        if (!this.gaps.has('truncated')) this.gaps.set('truncated', { code: 'truncated', evidence: [] });
        break;
      }
      gap.evidence.push(reference);
    }
  }

  append(inspection: RecordInspection, evidence: readonly string[]): void {
    for (const gap of inspection.gaps) this.addGap(gap.code, [...evidence, ...gap.evidence]);
    for (const edge of inspection.adjacency.edges) {
      if (this.edges.some((other) => other.nodeId === edge.nodeId)) continue;
      if (this.edges.length >= this.maximumEdges) {
        this.addGap('edge-limit');
        break;
      }
      this.edges.push({ ...edge, attribution: 'stage', evidence: [...evidence, ...edge.evidence].slice(0, 32) });
    }
  }

  finish(): RecordInspection {
    const gaps: Gap[] = [...this.gaps.values()];
    return { adjacency: { edges: this.edges, complete: gaps.length === 0 }, gaps };
  }
}

function sameAddress(left: LogAddress, right: LogAddress): boolean {
  return addressKey(left) === addressKey(right);
}

/** Only the existing authorized loader may admit a referenced scope. Never expose a host exception. */
async function load(address: LogAddress, context: GraphContext, loader: RecordScopeLoader): Promise<LoadedRecordScope> {
  if (context.signal.aborted) return { failure: 'cancelled' };
  try {
    const scope = await loader.loadScope(address, context);
    if (context.signal.aborted) return { failure: 'cancelled' };
    return 'failure' in scope || sameAddress(scope.address, address) ? scope : { failure: 'invalid-data' };
  } catch {
    return { failure: context.signal.aborted ? 'cancelled' : 'unavailable' };
  }
}

interface SelectedWrite {
  readonly write: RecordHandoffWrite;
  readonly ordinal: number;
}

function selectedWrites(node: ResolvedRecordNode, writes: readonly RecordHandoffWrite[]): readonly SelectedWrite[] {
  const bundle = node.scope.log[node.commitIndex];
  return writes.flatMap((write, ordinal) =>
    bundle.trace.some((row) => row.path === write.path) &&
    (node.identity.key === undefined || relation(write.path, node.identity.key) !== undefined)
      ? [{ write, ordinal }]
      : [],
  );
}

/** Even a refused source reference spends its work allowance before another can be tried. */
function rejectReads(
  writes: readonly SelectedWrite[],
  work: { left: number },
  result: BoundaryResult,
  first?: { left: number },
): void {
  let allowance = first ?? work;
  for (const { write } of writes)
    for (const _read of write.reads)
      if (!spendSubflowWork(allowance)) {
        result.addGap('edge-limit');
        return;
      } else allowance = work;
}

/** Reserve the first reference before its scope load; the source helper consumes this same token. */
function reserveSource(work: { left: number }, result: BoundaryResult): { left: number } | undefined {
  if (spendSubflowWork(work)) return { left: 1 };
  result.addGap('edge-limit');
  return undefined;
}

function resolveReads(
  scope: PreparedRecordScope,
  writes: readonly SelectedWrite[],
  cutoff: number,
  context: GraphContext,
  loader: RecordScopeLoader,
  work: { left: number },
  result: BoundaryResult,
  evidence: readonly string[],
  first?: { left: number },
): void {
  let allowance = first ?? work;
  for (const { write, ordinal } of writes)
    for (const read of write.reads) {
      const source = subflowSource(scope, read, cutoff, context, allowance, loader.extraGapCodes(scope));
      allowance = work;
      result.append(source, [...evidence, 'write:' + ordinal]);
      if (source.gaps.some((gap) => gap.code === 'edge-limit' || gap.code === 'cancelled')) return;
    }
}

async function inputParents(
  node: ResolvedRecordNode,
  context: GraphContext,
  loader: RecordScopeLoader,
  work: { left: number },
  result: BoundaryResult,
): Promise<void> {
  const containing = nativeParentOf(node.scope.address);
  if (!containing || node.commitIndex !== 0 || node.identity.runtimeStageId !== containing.runtimeStageId) return;
  const first = reserveSource(work, result);
  if (!first) {
    result.addGap('scope-boundary');
    return;
  }
  const parent = await load(containing.address, context, loader);
  if ('failure' in parent) {
    result.addGap('scope-boundary');
    result.addGap(parent.failure);
    return;
  }
  for (const code of parent.subflows?.gaps ?? []) result.addGap(code);
  const mounts = parent.subflows?.record?.mounts ?? [];
  const ordinal = mounts.findIndex(
    (mount) => mount.runtimeStageId === containing.runtimeStageId && sameAddress(mount.child, node.scope.address),
  );
  const mount = mounts[ordinal],
    handoff = mount?.inputHandoff;
  const evidence = ['subflow:input:' + ordinal];
  if (!mount || !handoff || !isNativeChild(parent.address, node.scope.address, mount.runtimeStageId)) {
    result.addGap('scope-boundary');
    return;
  }
  const writes = selectedWrites(node, handoff.writes);
  const firstMount = parent.log.findIndex((bundle) => bundle.runtimeStageId === mount.runtimeStageId);
  const latestAllowed = firstMount < 0 ? parent.log.length : firstMount;
  if (
    !sameAddress(handoff.parent.address, parent.address) ||
    !sameAddress(handoff.child.address, node.scope.address) ||
    handoff.child.runtimeStageId !== containing.runtimeStageId ||
    handoff.child.commitIdx !== 0 ||
    handoff.parent.beforeCommitIdx > latestAllowed ||
    handoff.parent.beforeCommitIdx > parent.log.length
  ) {
    rejectReads(writes, work, result, first);
    result.addGap('scope-boundary', evidence);
    result.addGap('invalid-data', evidence);
    return;
  }
  result.addGap('conservative', evidence);
  if (firstMount < 0 || handoff.status === 'partial' || !writes.length) result.addGap('scope-boundary', evidence);
  if (withheldInput(handoff)) {
    rejectReads(writes, work, result, first);
    result.addGap('scope-boundary', evidence);
    if (handoff.limitations.includes('privacy-active')) result.addGap('redacted', evidence);
    return;
  }
  resolveReads(parent, writes, handoff.parent.beforeCommitIdx, context, loader, work, result, evidence, first);
}

function withheldInput(handoff: RecordInputHandoff): boolean {
  return handoff.limitations.some(
    (limitation) =>
      limitation === 'privacy-active' ||
      limitation === 'parent-log-advanced' ||
      limitation === 'selector-reads-unavailable' ||
      limitation === 'resume-seed',
  );
}

async function outputParents(
  node: ResolvedRecordNode,
  context: GraphContext,
  loader: RecordScopeLoader,
  work: { left: number },
  result: BoundaryResult,
): Promise<void> {
  const mounts = node.scope.subflows?.record?.mounts ?? [];
  for (let ordinal = 0; ordinal < mounts.length; ordinal++) {
    const mount = mounts[ordinal];
    if (mount.runtimeStageId !== node.identity.runtimeStageId) continue;
    const handoff = mount.outputHandoff,
      evidence = ['subflow:output:' + ordinal, 'commit:' + node.commitIndex];
    if (!handoff) {
      if (node.scope.log[node.commitIndex].trace.length) result.addGap('scope-boundary', evidence);
      continue;
    }
    if (handoff.parent.commitIdx !== node.commitIndex) continue;
    const writes = selectedWrites(node, handoff.writes);
    if (!writes.length) {
      if (node.scope.log[node.commitIndex].trace.length) {
        result.addGap('scope-boundary', evidence);
        result.addGap('conservative', evidence);
      }
      continue;
    }
    result.addGap('conservative', evidence);
    if (handoff.status === 'partial') result.addGap('scope-boundary', evidence);
    // An empty observed prefix remains uncertain and needs no source payload load.
    if (!writes.some(({ write }) => write.reads.length)) continue;
    const first = reserveSource(work, result);
    if (!first) return;
    if (!outputMatches(node, handoff, mount.child, mount.runtimeStageId)) {
      rejectReads(writes, work, result, first);
      result.addGap('invalid-data', evidence);
      result.addGap('scope-boundary', evidence);
      continue;
    }
    if (handoff.limitations.includes('privacy-active')) {
      rejectReads(writes, work, result, first);
      result.addGap('redacted', evidence);
      result.addGap('scope-boundary', evidence);
      continue;
    }
    const child = await load(handoff.child.address, context, loader);
    if ('failure' in child) {
      rejectReads(writes, work, result, first);
      result.addGap(child.failure, evidence);
      result.addGap('scope-boundary', evidence);
      continue;
    }
    if (!child.complete || handoff.child.beforeCommitIdx !== child.log.length) {
      rejectReads(writes, work, result, first);
      result.addGap('scope-boundary', evidence);
      result.addGap('invalid-data', evidence);
      continue;
    }
    resolveReads(child, writes, handoff.child.beforeCommitIdx, context, loader, work, result, evidence, first);
  }
}

function outputMatches(
  node: ResolvedRecordNode,
  handoff: RecordOutputHandoff,
  child: LogAddress,
  mountId: string,
): boolean {
  return (
    sameAddress(handoff.parent.address, node.scope.address) &&
    handoff.parent.runtimeStageId === mountId &&
    sameAddress(handoff.child.address, child) &&
    isNativeChild(node.scope.address, child, mountId)
  );
}

function collectionBoundaries(node: ResolvedRecordNode, result: BoundaryResult): void {
  const collections = node.scope.subflows?.record?.collections ?? [];
  for (let ordinal = 0; ordinal < collections.length; ordinal++) {
    const collection = collections[ordinal],
      target = collection.parent;
    if (
      target.runtimeStageId !== node.identity.runtimeStageId ||
      target.commitIdx !== node.commitIndex ||
      !sameAddress(target.address, node.scope.address) ||
      !selectedWrites(node, [{ path: target.path, reads: [] }]).length
    )
      continue;
    if (collection.branchCount === 0 && collection.status === 'captured' && !collection.limitations.length) continue;
    const evidence = ['subflow:collection:' + ordinal, 'commit:' + node.commitIndex];
    result.addGap('scope-boundary', evidence);
    result.addGap('conservative', evidence);
    for (const slot of collection.slots) result.addGap('scope-boundary', [...evidence, 'slot:' + slot.index]);
  }
}

/** Only cross-scope observations and boundary gaps; existing local inspection remains authoritative. */
export async function subflowParents(
  node: ResolvedRecordNode,
  context: GraphContext,
  loader: RecordScopeLoader,
  maximumEdges: number,
  work = { left: maximumEdges },
): Promise<RecordInspection> {
  const result = new BoundaryResult(maximumEdges);
  // A refused optional channel is uncertainty even when no descriptor survived to name a crossing.
  for (const code of node.scope.subflows?.gaps ?? []) result.addGap(code);
  if (context.signal.aborted) {
    result.addGap('cancelled');
    return result.finish();
  }
  if (node.identity.read) return result.finish();
  await inputParents(node, context, loader, work, result);
  await outputParents(node, context, loader, work, result);
  collectionBoundaries(node, result);
  return result.finish();
}
