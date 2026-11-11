/**
 * writerLookup.ts — "which commit last wrote this key before that position?", answered by a scan for
 * a small log and by the log's read model for a large one.
 *
 * WHY ITS OWN FILE: it is the one part of the walk back (`backtrack.ts`) that is about speed and not
 * about what a cause is. Both strategies give the same answer, so the walk never knows which one ran.
 */

import { lastWriterPosition } from './commitLogUtils.js';
import { logModel } from './logModel.js';
import type { LastWriterBefore } from './readWindow.js';
import type { CommitBundle } from './types.js';

/**
 * Threshold for switching from linear scan to reverse index.
 * Below this, O(N) scan is faster (no index build cost).
 * Above this, O(log N) binary search wins.
 */
export const REVERSE_INDEX_THRESHOLD = 256;

/**
 * Writer lookup function signature.
 * Returns the ARRAY position of the commit that last wrote `key` before position `beforeIdx`, or -1.
 */
export type WriterLookup = LastWriterBefore;

/** Strategy 1: Linear scan — O(N) per lookup, zero setup cost. */
function linearScanLookup(commitLog: CommitBundle[]): WriterLookup {
  return (key, beforeIdx) => lastWriterPosition(commitLog, key, beforeIdx);
}

/**
 * Strategy 2: Reverse index — one O(rows) build, O(depth + log N) per lookup.
 * The log's read model (`logModel.ts`: a path trie, each top-level key folded at
 * most once) answers the writer rule — rows on, inside or around the key — by
 * binary search for the last write on or inside it, then a verdict only for the
 * around-candidates after it. The same answer `findLastWriter` gives, so the
 * strategy switch below never changes a slice.
 */
function reverseIndexLookup(commitLog: CommitBundle[]): WriterLookup {
  const model = logModel(commitLog);
  return (key: string, beforeIdx: number): number => model.lastWriterBefore(key, beforeIdx);
}

/**
 * Staged optimization: pick the right writer-lookup strategy based on data size.
 *
 * Like a database query optimizer choosing between sequential scan and index scan:
 *
 * - **Small log (≤ 256):** the scan (`findLastWriter`). No model is built for the call unless
 *   a lookup needs one; a frozen log is answered from its memoised read model.
 *
 * - **Large log (> 256):** the read model. One O(rows) build is amortized across all BFS
 *   hops, and each lookup is a binary search instead of a scan. For an agent loop with 500
 *   iterations and 5 keys per hop, this is 500×5×log(500)≈22K ops vs 500×5×500=1.25M ops
 *   with a scan.
 *
 * The caller never sees this — `causalChain()` picks automatically.
 */
export function createWriterLookup(commitLog: CommitBundle[]): WriterLookup {
  if (commitLog.length <= REVERSE_INDEX_THRESHOLD) {
    return linearScanLookup(commitLog);
  }
  return reverseIndexLookup(commitLog);
}
