/**
 * slice/keyTimeline.ts — the whole life of ONE key, in commit order.
 *
 * The flat companion to {@link forwardSliceForKey}: no graph, no budgets,
 * no anchor — every write of the key and every recorded read of it, as one
 * chronological list. This is what a UI timeline row and an LLM's "walk me
 * through what happened to `total`" both want, and what makes a forward
 * slice checkable: the same facts, unfolded instead of walked.
 *
 * Every moment carries BOTH universal join keys — `runtimeStageId` (to
 * recorders, execution trees, UIs) and `commitIdx` (to the commit log).
 *
 * ### LAW — read attribution is the walk's, exactly
 *
 * A read moment's `fromWriteIdx` is the write whose live range it sits in:
 * the last write at a STRICTLY earlier commit index. That is the same
 * `(writeIdx, nextWriteIdx]` rule `forwardSliceForKey` walks (reads fire
 * PRE-commit), so the two doors can never disagree about which value a read
 * saw — pinned by a cross-door property test. A read before ANY write has no
 * `fromWriteIdx` and raises the `'pre-run-origin'` note: it saw initial
 * state, frozen run `input`, or a closure.
 *
 * ### LAW — a value built in steps is said on the WRITE, once
 *
 * A write that did not replace the value (a merge, an append, a path inside
 * the key) was folded onto the write before it. The write moment names that
 * one (`builtOnWriteIdx`), or says the value from before the run was under it
 * (`builtOnPreRun`). The rule is `memory/builtOn.ts`, the one the backward
 * walk follows, so the two cannot disagree. The moments here are COMMITS, so
 * the link is by commit: a step that committed twice has its later commit
 * linked to its earlier one. WHY on the write and not on the read: a read of
 * a list that was appended to N times saw N writes, and a list on every read
 * grows with the square of a loop that appends and reads. The link is one
 * number per write, found with one look at one bundle; a reader follows it
 * from the write a read names. One more link, with fields of its own: a `set`
 * row the WRITER built on the step's view (`TraceEntry.builtOnView`) holds
 * what the view held, as of the moment the view was pinned
 * (`CommitBundle.viewAt`). That is one write (`builtOnViewIdx`), and it need
 * not be the write the commit was folded onto: a commit with such a row
 * INSIDE the key has both links. A view that held no write of the key says
 * so in its own field too (`builtOnViewPreRun`). Only where the reader
 * cannot place the view at one position of the array could it have held
 * other writes (`orViewIdxs`).
 *
 * DAG position: memory ← slice. Imports memory/ only (see README.md).
 */

import type { KeysReadLookup } from '../memory/backtrack.js';
import { builtOnBefore, readFromView } from '../memory/builtOn.js';
import { readSourcesOf } from '../memory/readWindow.js';
import type { CommitBundle } from '../memory/types.js';
import {
  buildKeyIndex,
  concurrentReadsNote,
  fromInitialStateNote,
  hasRecordedReads,
  lastIndexBefore,
  mergedWrites,
  nestedOnlyWrites,
  nestedRowsNote,
  partialWriteNote,
  preRunOriginNote,
  readsNotRecordedNote,
  unknownKeyNote,
  writeEntry,
} from './keyIndex.js';
import { resolveKeysReadSource } from './keysReadSources.js';
import { normaliseStateKey } from '../record-paths/codec.js';
import type { HonestyNote, KeyMoment, KeysReadSource, KeyTimeline, StateKey } from './types.js';

/** Options for {@link keyTimeline}. */
export interface KeyTimelineOptions {
  /**
   * Exclusive commit-array-index upper bound: only moments BEFORE this idx.
   * Same word and semantics as `sliceForKey`'s `before` (note the sibling
   * `arrayProvenance` uses an INCLUSIVE `atIdx` — this family follows the
   * slice doors).
   */
  before?: number;
}

/**
 * The life of one key as a chronological list of writes and reads.
 *
 * @param commitLog Ordered commit bundles — `getSnapshot().commitLog`.
 * @param key A {@link StateKey} — normalised through the same
 *   `normaliseStateKey` both slice doors use.
 * @param keysRead A {@link KeysReadSource} or bare lookup (reads are not in
 *   the commit log).
 * @returns Always a {@link KeyTimeline}; absence carries its reason, and an
 *   unknown key is NAMED as unknown with a bounded list of known keys.
 */
export function keyTimeline(
  commitLog: CommitBundle[],
  key: StateKey,
  keysRead: KeysReadSource | KeysReadLookup,
  options?: KeyTimelineOptions,
): KeyTimeline {
  const source = resolveKeysReadSource(keysRead);
  const normalisedKey = normaliseStateKey(key);
  const base: Pick<KeyTimeline, 'key' | 'before' | 'keysReadKind' | 'readsCoverage'> = {
    key: normalisedKey,
    ...(options?.before !== undefined && { before: options.before }),
    keysReadKind: source.kind,
    ...(source.coverage !== undefined && { readsCoverage: source.coverage }),
  };

  if (commitLog.length === 0) return { ...base, missing: 'empty-log', notes: [] };

  const index = buildKeyIndex(commitLog, source.lookup);
  const readsRecorded = hasRecordedReads(index);
  const notes: HonestyNote[] = [];

  // Same typo guard as the forward walk — one rule, both doors.
  if (!index.isKnown(normalisedKey)) {
    notes.push(unknownKeyNote(index, normalisedKey));
    if (readsRecorded) return { ...base, missing: 'never-written', notes };
  }
  if (!readsRecorded) notes.push(readsNotRecordedNote());

  const limit = options?.before ?? commitLog.length;
  // Writes under the writer rule (on the key, inside it, or around it and
  // changing it); reads on the key, inside it or around it (keyIndex.ts).
  const allWrites = index.writesOf(normalisedKey);
  const writes = allWrites.filter((i) => i < limit);
  const reads = index.readsOf(normalisedKey).filter((i) => i < limit);

  // Merge two ascending index lists. At the SAME commit index a read comes
  // first: reads fire before their stage's commit (the engine's event order,
  // and the reason the live range is closed at the next write).
  const moments: KeyMoment[] = [];
  let w = 0;
  let r = 0;
  let sawPreRunRead = false;
  let concurrentReads = 0;
  let restsOnPreRun = false;
  const bundleAt = (position: number): CommitBundle => commitLog[position];
  const writeBefore = (_key: string, before: number): number => lastIndexBefore(allWrites, before) ?? -1;
  while (w < writes.length || r < reads.length) {
    const takeRead = r < reads.length && (w >= writes.length || reads[r] <= writes[w]);
    if (takeRead) {
      const idx = reads[r++];
      const bundle = commitLog[idx];
      // The value this read saw is the one rule's answer (`memory/readWindow.ts`): the last write before
      // the step began, or a write inside its read window (none for a step with no window).
      const sources = readSourcesOf(normalisedKey, index.windows.get(idx) ?? { start: idx, end: idx }, writeBefore);
      if (sources.before < 0) sawPreRunRead = true;
      if (sources.during.length > 0) concurrentReads++;
      moments.push({
        kind: 'read',
        commitIdx: idx,
        runtimeStageId: bundle.runtimeStageId,
        stageId: bundle.stageId,
        stageName: bundle.stage,
        ...(sources.before >= 0 && { fromWriteIdx: sources.before }),
        ...(sources.during.length > 0 && { orWriteIdxs: [...sources.during] }),
      });
    } else {
      const idx = writes[w++];
      const bundle = commitLog[idx];
      const entry = writeEntry(bundle, normalisedKey);
      // A write that did not replace the value was folded onto the write before it, or onto the value
      // from before the run when there is none (`memory/builtOn.ts`). Said ONCE, on the write: a read
      // names the write it saw, and a reader of the timeline follows the links from there. (A list on
      // every read would grow with the square of a key that is appended to and read in a loop.)
      const under = builtOnBefore(normalisedKey, idx, bundleAt, writeBefore);
      // A `set` row the WRITER built on the step's view still holds what the view held, as of the
      // moment the view was pinned (`CommitBundle.viewAt`, `memory/builtOn.ts · readFromView`). That
      // is a second link with fields of its own, because it can name another write than the fold does:
      // the fold names the write just before this commit, and the view may have been pinned before
      // that one. `during` is empty unless the array does not show where the view sits.
      const seen = readFromView(bundle, normalisedKey)
        ? readSourcesOf(normalisedKey, index.views.get(idx) ?? { start: idx, end: idx }, writeBefore)
        : undefined;
      // Each link has its own way to say "nothing in the log is under it": the two can differ (a row
      // inside the key, folded onto an earlier commit, whose view was pinned before any write).
      const foldPreRun = under === -1;
      const viewPreRun = seen !== undefined && seen.before < 0;
      if (foldPreRun || viewPreRun) restsOnPreRun = true;
      moments.push({
        kind: 'write',
        commitIdx: idx,
        runtimeStageId: bundle.runtimeStageId,
        stageId: bundle.stageId,
        stageName: bundle.stage,
        ...(entry !== undefined && { verb: entry.verb }),
        ...(under !== undefined && under >= 0 && { builtOnWriteIdx: under }),
        ...(foldPreRun && { builtOnPreRun: true as const }),
        ...(seen !== undefined && seen.before >= 0 && { builtOnViewIdx: seen.before }),
        ...(viewPreRun && { builtOnViewPreRun: true as const }),
        ...(seen !== undefined && seen.during.length > 0 && { orViewIdxs: [...seen.during] }),
      });
    }
  }

  if (sawPreRunRead) notes.push(preRunOriginNote(normalisedKey));
  const nested = nestedOnlyWrites(commitLog, normalisedKey, writes);
  if (nested.length > 0) notes.push(nestedRowsNote(normalisedKey, nested));
  const merged = mergedWrites(commitLog, normalisedKey, writes);
  if (merged.length > 0) notes.push(partialWriteNote(normalisedKey, merged));
  if (restsOnPreRun) notes.push(fromInitialStateNote(normalisedKey));
  if (concurrentReads > 0) notes.push(concurrentReadsNote(concurrentReads));
  return { ...base, moments, notes };
}
