/**
 * slice/sliceForKey.ts — the variable-first backward slice query.
 *
 * "Why is `key` what it is?" — the ONE question every triage surface asks:
 * a human clicking a key in explainable-ui, an LLM calling a `backtrack`
 * tool mid-conversation, an offline autopsy agent over a stored run.
 *
 * WHY this is deliberately a composition and not a new algorithm:
 * `findLastWriter` already answers "who made the value what it is" and
 * `causalChain` already answers "what influenced that step" (thin backward
 * slicing, Weiser 1984). What was missing is the shared CONTRACT — without
 * it, every surface hand-rolls the anchor step differently and their answers
 * disagree. The value of this function is that they can't.
 */

import {
  type CausalChainOptions,
  type KeysReadLookup,
  causalChainFromCommit,
  flattenCausalDAG,
} from '../memory/backtrack.js';
import { requireControlDepsFunction } from '../memory/controlDeps.js';
import { commitValueAtWithBasis, findLastWriterWithBasis } from '../memory/commitLogUtils.js';
import type { CommitBundle } from '../memory/types.js';
import { normaliseStateKey } from '../record-paths/codec.js';
import {
  concurrentWriteNote,
  fromInitialStateNote,
  nestedRowsNote,
  redactedValueNote,
  viewNotPlacedNote,
} from './notes.js';
import { resolveKeysReadSource } from './keysReadSources.js';
import type { KeysReadSource, StateKey, VariableSlice } from './types.js';

/** Options for {@link sliceForKey} — causalChain's options plus anchoring. */
export interface SliceForKeyOptions extends CausalChainOptions {
  /**
   * Exclusive commit-array-index upper bound: slice the value as it stood
   * BEFORE this idx (time-travel triage — "why was it X at step 12?").
   * Same contract as `findLastWriter`'s `beforeIdx`. Omit for the current
   * value. Chained-triage idiom: to slice at an {@link ElementBirth}, pass
   * `before: birth.commitIdx + 1` (birth idx is inclusive, this bound is
   * exclusive — the +1 makes the birth commit itself the anchor).
   */
  before?: number;
}

/**
 * Backward slice for one state key: anchor at the key's last writer, then
 * walk read→write (and optional control) dependencies transitively.
 * This state-key view retains `writer.trace[].readAttempts` but does not project
 * those call sources into parents; empty parents do not rule out external ancestry.
 *
 * Honest-absence contract: a missing slice is a RESULT, not an error —
 * `missing: 'never-written'` tells a triage tool (or its LLM caller) that
 * the value came from initial state / frozen args / a closure, which is
 * itself diagnostic information. See {@link VariableSlice} — including its
 * SERIALIZATION WARNING before you stringify the result.
 */
export function sliceForKey(
  commitLog: CommitBundle[],
  key: StateKey,
  keysRead: KeysReadSource | KeysReadLookup,
  options?: SliceForKeyOptions,
): VariableSlice {
  // Refused at the call: an empty log or a key never written would return before the walk could refuse it.
  requireControlDepsFunction(options?.controlDeps, 'sliceForKey');
  const source = resolveKeysReadSource(keysRead);
  const normalisedKey = normaliseStateKey(key);
  const base: Pick<VariableSlice, 'key' | 'before' | 'keysReadKind' | 'readsCoverage'> = {
    key: normalisedKey,
    ...(options?.before !== undefined && { before: options.before }),
    keysReadKind: source.kind,
    ...(source.coverage !== undefined && { readsCoverage: source.coverage }),
  };

  if (commitLog.length === 0) return { ...base, missing: 'empty-log' };

  const { writer, basis } = findLastWriterWithBasis(commitLog, normalisedKey, options?.before);
  // F4b: what the value at the slice's point rests on, from the value twin — a redaction, the pre-run base.
  const end = Math.min(options?.before ?? commitLog.length, commitLog.length) - 1;
  const value = end >= 0 ? commitValueAtWithBasis(commitLog, end, normalisedKey).basis : [];
  if (!writer) {
    // 'never-written' already says the value came from before the run; a redaction that hid the write does not.
    return {
      ...base,
      missing: 'never-written',
      ...(value.includes('redacted') && { notes: [redactedValueNote(normalisedKey)] }),
    };
  }
  // A writer that reached the key only through rows inside it made part of the value — say so.
  const notes = basis.includes('nested-rows') ? [nestedRowsNote(normalisedKey, [commitLog.indexOf(writer)])] : [];
  if (value.includes('from-initial-state')) notes.push(fromInitialStateNote(normalisedKey));
  if (value.includes('redacted')) notes.push(redactedValueNote(normalisedKey));

  // INVARIANT: `writer` came FROM this commitLog, so its runtimeStageId is
  // always present in causalChain's index — causalChain cannot return
  // undefined here (it only does for ids absent from the log). The non-null
  // assertion keeps the VariableSlice contract airtight: `missing` is the
  // ONLY absent-root state. Options pass straight through (controlDeps /
  // weigh / maxDepth / maxNodes keep their causalChain semantics).
  //
  // edgeAttribution defaults to 'per-write' HERE (unlike causalChain's
  // 'stage' default): a variable-first slice knows exactly which written key
  // anchors the question, and per-write attribution is strictly-safe — logs
  // without `TraceEntry.readKeys` (the writeProvenance dial off) fall back
  // to stage-level expansion per node, byte-identically. Consumers can force
  // 'stage' via options.
  // Preserve this exact writer's metadata/read prefix, even when it is a
  // continuation. Causal expansion separately uses the execution's first commit.
  const root = causalChainFromCommit(commitLog, writer, source.lookup, {
    ...options,
    edgeAttribution: options?.edgeAttribution ?? 'per-write',
    rootLinkKeys: options?.rootLinkKeys ?? [normalisedKey],
  })!;
  // Steps side by side: say how many reads have only possible sources (one read = one step and one key).
  // An edge a view made is no read by a step, and is possible for another reason: said apart.
  let contested = 0;
  let viewNotPlaced = false;
  for (const node of flattenCausalDAG(root)) {
    const possible = node.parentEdges.filter((edge) => edge.overlap !== undefined);
    contested += new Set(possible.filter((edge) => edge.builtOn === undefined).map((edge) => edge.key)).size;
    if (possible.some((edge) => edge.overlap === 'view-not-placed')) viewNotPlaced = true;
  }
  if (contested > 0) notes.push(concurrentWriteNote(contested));
  if (viewNotPlaced) notes.push(viewNotPlacedNote());
  return { ...base, writer, root, ...(notes.length > 0 && { notes }) };
}
