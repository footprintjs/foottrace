import type { CommitBundle } from '../memory/types.js';
import { relation } from '../memory/keyPaths.js';
import { forwardSliceForKey } from '../slice/forwardSliceForKey.js';
import { collectControlChildCoverage } from './recordControl.js';
import { readKeysForStage } from './recordScope.js';
import type { AddRecordGap, PreparedRecordScope, RecordIdentity, ResolvedRecordNode } from './recordTypes.js';
import type { Attention, Gap } from './types.js';

/** Preserve first-observed coverage order while collapsing repeated codes from different evidence paths. */
export function recordGapCollector(): { gaps: Gap[]; addGap: AddRecordGap } {
  const gaps: Gap[] = [];
  return {
    gaps,
    addGap: (code) => {
      if (!gaps.some((gap) => gap.code === code)) gaps.push({ code, evidence: [] });
    },
  };
}

/** Failed loading exposes a fixed category, never the host error or an apparently complete empty graph. */
export function gapForRecordFailure(code: Gap['code']): readonly Gap[] {
  return [{ code, evidence: [] }];
}

/** Return captured mark references without treating an omitted attention map as collected evidence. */
export function attentionForRecordNode(node: ResolvedRecordNode): readonly Attention[] {
  // An omitted map stays unknown coverage; it is never replaced by an affirmative empty map.
  return node.scope.marks?.get(node.identity.runtimeStageId) ?? [];
}

/** Emit host and capture gaps before query-derived gaps so existing evidence order stays stable. */
export function collectScopeCoverage(
  scope: PreparedRecordScope,
  bundle: CommitBundle,
  extraGapCodes: readonly Gap['code'][] | undefined,
  addGap: AddRecordGap,
): void {
  for (const code of extraGapCodes ?? []) addGap(code);
  if (!scope.complete || scope.control === undefined || scope.marks === undefined) addGap('not-collected');
  if (bundle.untrackedSources?.length) addGap('untracked-input');
  if (bundle.redactedPaths.length) addGap('redacted');
}

/** A read-only identity has no new value life; unqualified executions retain written-key encounter order. */
export function writtenKeysForNode(bundle: CommitBundle, identity: RecordIdentity): string[] {
  return identity.read
    ? []
    : identity.key === undefined
    ? [...new Set(bundle.trace.map((entry) => entry.path))]
    : [identity.key];
}

/** Immediate adjacency caps affect graph coverage even when the caller asks only for parents. */
export function collectForwardCoverage(
  scope: PreparedRecordScope,
  identity: RecordIdentity,
  commitIndex: number,
  firstCommitIndex: number,
  maximumEdges: number,
  addGap: AddRecordGap,
): void {
  const neighbors = new Set<string>();
  const lookup = (runtimeStageId: string) => readKeysForStage(scope, runtimeStageId);
  for (const key of writtenKeysForNode(scope.log[commitIndex], identity)) {
    const forward = forwardSliceForKey(scope.log, key, lookup, {
      before: commitIndex + 1,
      maxDepth: 1,
      maxNodes: maximumEdges + 1,
    });
    // A one-hop query intentionally stops at depth one; only a node cap hides immediate adjacency.
    if (forward.root?.truncated?.byNodes) addGap('edge-limit');
    for (const edge of forward.root?.fedEdges ?? [])
      neighbors.add(JSON.stringify(['data', edge.child.commitIdx, edge.child.key]));
    for (const read of forward.root?.reads ?? [])
      if (!scope.log[read.commitIdx]?.trace.length) neighbors.add(JSON.stringify(['read', read.commitIdx, key]));
  }
  collectControlChildCoverage(scope, identity, firstCommitIndex, neighbors, addGap);
  if (neighbors.size > maximumEdges) addGap('edge-limit');
}

/** Exact attribution requires captured per-write provenance or a validated read-only key context. */
export function readAttributionIsPrecise(
  scope: PreparedRecordScope,
  identity: RecordIdentity,
  bundle: CommitBundle,
): boolean {
  const relevant =
    identity.key === undefined
      ? bundle.trace
      : bundle.trace.filter((entry) => relation(entry.path, identity.key!) !== undefined);
  return identity.read === true
    ? identity.key !== undefined && readKeysForStage(scope, identity.runtimeStageId).includes(identity.key)
    : identity.key !== undefined && relevant.length > 0 && relevant.every((entry) => entry.readKeys !== undefined);
}

/** Distinguish conservative attribution from missing collection without marking a proven empty leaf. */
export function collectReadCoverage(
  scope: PreparedRecordScope,
  identity: RecordIdentity,
  precise: boolean,
  addGap: AddRecordGap,
): void {
  if (!precise && (identity.key !== undefined || readKeysForStage(scope, identity.runtimeStageId).length > 0))
    addGap('conservative');
  if (!scope.reads?.has(identity.runtimeStageId) && !precise) addGap('not-collected');
}

/** Forward absence is trustworthy only when every potentially consuming execution collected its reads. */
export function allStageReadsCollected(scope: PreparedRecordScope): boolean {
  return !scope.log.some(
    (bundle) =>
      !scope.reads?.has(bundle.runtimeStageId) &&
      (bundle.trace.length === 0 || bundle.trace.some((entry) => entry.readKeys === undefined)),
  );
}
