import { causalChain, type CausalChainOptions, type CausalNode, type KeysReadLookup } from '../../memory/backtrack.js';
import { buildCommitIndex } from '../../memory/commitLogUtils.js';
import type { StoredRecord } from '../../time-travel/storedRecord.js';
import type { CouldHaveChangedCandidate } from './analyze.js';
import {
  analyzeSavedSkippedPaths,
  type CouldHaveChangedOptions,
  type CouldHaveChangedResult,
  savedSkippedQuery,
  SKIPPED_QUERY_WORK,
  unavailableSkippedPaths,
} from './couldHaveChanged.js';

export interface CouldHaveChangedEdge extends CouldHaveChangedCandidate {
  readonly kind: 'could-have-changed';
  readonly key: string;
}

export interface CausalChainWithCouldHaveChanged {
  readonly causal: CausalNode | undefined;
  readonly skipped: readonly CouldHaveChangedEdge[];
  readonly gaps: CouldHaveChangedResult['gaps'];
}

/** The opt-in walk retains omitted paths alongside the unchanged causal DAG. */
export async function causalChainWithCouldHaveChanged(
  recording: StoredRecord,
  startId: string,
  getKeysRead: KeysReadLookup,
  key: string,
  options: CouldHaveChangedOptions,
  causalOptions?: CausalChainOptions,
): Promise<CausalChainWithCouldHaveChanged> {
  const query = savedSkippedQuery(recording, options);
  if (typeof query === 'string') return { causal: undefined, skipped: [], gaps: unavailableSkippedPaths(query).gaps };
  if (query.log.commitLog.length > SKIPPED_QUERY_WORK) return { causal: undefined, skipped: [], gaps: ['truncated'] };
  const commits = [...query.log.commitLog];
  const beforeIdx = buildCommitIndex(commits).get(startId);
  if (beforeIdx === undefined) return { causal: undefined, skipped: [], gaps: ['no-match'] };
  const skipped = await analyzeSavedSkippedPaths(query, key, beforeIdx);
  return {
    causal: causalChain(commits, startId, getKeysRead, causalOptions),
    skipped: skipped.candidates.map((candidate) => ({ kind: 'could-have-changed', key, ...candidate })),
    gaps: skipped.gaps,
  };
}
