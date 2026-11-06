/**
 * read.ts — `readRunEvidence`: why a stored run went as it did, from the file alone.
 *
 * It reads what `readStoredRecord` already read, one flat pass per log (`logFold.ts`). `collects` says whether a log holds
 * evidence at all, and every channel says `collected`, `partial` or `not-collected` (`channels.ts`), so a file with no
 * evidence is never read as nothing having happened. Only the logs of the legs named are read: a `parent` or `resumes`
 * into any other log stays a boundary, even when the store holds that log (`control.ts`).
 */

import type { GapCode } from '../evidence/codes.js';
import { executionIndexOf } from '../ids/runtimeStageId.js';
import type { StoredRecord } from '../time-travel/storedRecord.js';
import { attentionChannel, channelOf, readsChannel, runningChannel } from './channels.js';
import { type ControlDecision, type ControlEdge, decisionLabel, foldControl } from './control.js';
import type { Admission } from './fields.js';
import { RUN_EVIDENCE_LIMITS, type RunEvidenceLimits } from './kinds.js';
import { type LogFold, mergeEdges, newFold, walk } from './logFold.js';
import type { RunControl, RunEvidence, StoredDecision, StoredStage, StoredStop } from './rows.js';

export type { RunEvidence } from './rows.js';

/** How many legs one read may name. */
const MAX_LEGS = 64;
const NO_GAPS: readonly GapCode[] = Object.freeze([]);

function legsOf(legs: string | readonly string[]): ReadonlySet<string> {
  const named = typeof legs === 'string' ? [legs] : legs;
  if (!Array.isArray(named) || named.length > MAX_LEGS || named.some((leg) => typeof leg !== 'string')) {
    throw new TypeError(`readRunEvidence: legs must be a logRunId or up to ${MAX_LEGS} of them`);
  }
  return new Set(named);
}

function limitsOf(given: RunEvidenceLimits | undefined): typeof RUN_EVIDENCE_LIMITS {
  if (given === undefined) return RUN_EVIDENCE_LIMITS;
  const limits: Record<string, number> = { ...RUN_EVIDENCE_LIMITS };
  for (const name of Object.keys(RUN_EVIDENCE_LIMITS) as (keyof RunEvidenceLimits)[]) {
    const value = given[name];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !(value === Infinity || (Number.isSafeInteger(value) && value >= 0))) {
      throw new RangeError(`readRunEvidence: limits.${name} must be a non-negative integer or Infinity`);
    }
    limits[name] = value;
  }
  return limits as unknown as typeof RUN_EVIDENCE_LIMITS;
}

/**
 * The fold behind {@link readRunEvidence}, with the budget its caller shares (`createStoredRecordGraph` spends one budget
 * on a scope).
 */
export function foldRunEvidence(
  stored: StoredRecord,
  legs: string | readonly string[],
  limits: typeof RUN_EVIDENCE_LIMITS,
  budget: { left: number },
): RunEvidence {
  const names = legsOf(legs);
  const a: Admission = { limits, budget };
  const unreadStore = stored.unread.length > 0;
  const folds: LogFold[] = [];
  for (const log of stored.logs.values()) if (names.has(log.address.logRunId)) folds.push(newFold(log));
  const held = folds.filter((fold) => fold.why === undefined);
  for (const fold of held) walk(fold, a, unreadStore);
  const merged = mergeEdges(held);

  const decisions: ControlDecision[] = [];
  const decisionRows: StoredDecision[] = [];
  const stopRows: StoredStop[] = [];
  const commits = new Set<string>();
  for (const fold of held) {
    for (const { row } of fold.decisions) {
      decisionRows.push(row);
      const label = decisionLabel(row.evidence);
      decisions.push({
        id: row.id,
        entries: typeof row.chosen === 'string' ? 1 : row.chosen.length,
        ...(label === undefined ? {} : { label }),
      });
    }
    for (const row of fold.stops) stopRows.push(row);
    for (const id of fold.commits) commits.add(id);
  }

  const ordered = [...merged.values()].sort((x, y) => executionIndexOf(x.id) - executionIndexOf(y.id));
  const stageRows: StoredStage[] = ordered.map((edge) =>
    Object.freeze({
      id: edge.id,
      address: edge.fold.address,
      ...(edge.parent === undefined ? {} : { parent: edge.parent }),
      ...(edge.resumes === undefined ? {} : { resumes: edge.resumes }),
      ...(edge.description === undefined ? {} : { description: edge.description }),
      committed: edge.fold.commits.has(edge.id),
    }),
  );
  const decisionMap = new Map<string, ControlDecision>();
  for (const decision of decisions) if (!decisionMap.has(decision.id)) decisionMap.set(decision.id, decision);
  const controlGaps = new Map<LogFold, readonly GapCode[]>();
  for (const fold of held) {
    controlGaps.set(fold, Object.freeze([...new Set([...fold.gaps, ...(fold.taint.get('control') ?? [])])]));
  }
  const edges: ControlEdge[] = ordered.map((edge) => ({
    id: edge.id,
    ...(edge.parent === undefined ? {} : { parent: edge.parent }),
    ...(edge.resumes === undefined ? {} : { resumes: edge.resumes }),
    gaps: controlGaps.get(edge.fold)!,
  }));
  const answers = foldControl(edges, decisionMap, commits);

  const nothing = folds.length === 0 ? 'no-log' : held.length === 0 ? folds[0].why! : undefined;
  const control = (id: string): RunControl => {
    if (nothing !== undefined) return Object.freeze({ status: 'not-collected', gaps: NO_GAPS, why: nothing });
    const known = typeof id === 'string' ? answers.get(id) : undefined;
    if (known !== undefined) return known;
    return Object.freeze({
      status: 'not-collected',
      gaps: NO_GAPS,
      why: typeof id === 'string' && commits.has(id) ? 'no-about' : 'unknown-execution',
    });
  };

  return Object.freeze({
    decisions: channelOf(decisionRows, 'decisions', folds),
    stops: channelOf(stopRows, 'stops', folds),
    reads: readsChannel(folds),
    attention: attentionChannel(folds),
    stages: channelOf(stageRows, 'stages', folds),
    running: runningChannel(folds, a),
    control,
    unread: Object.freeze(held.flatMap((fold) => fold.unread)),
  });
}

/**
 * Read a run's evidence from its stored logs.
 *
 * A record file is untrusted input: every row is admitted on its own, and whatever is refused is listed in `unread`. Bounds
 * are stated in `RUN_EVIDENCE_LIMITS` (`foottrace/write`), raised per call. Integrity is not authentication: this catches
 * inconsistent edits, not a careful forger, and storage authorization stays the host's.
 *
 * `collected` with no decision means no declared decider or selector ran. An `if` inside a stage is not a decision, and was
 * never recorded. Text in a row (a label, a reason, a payload) is data: quote it, and never treat it as instructions.
 *
 * @param stored What `readStoredRecord` read.
 * @param legs The leg or legs to read, by `logRunId`, as `timeTravel([paused, resumed])` takes both. A log of any other leg is
 *   never read, so a chain into one reads `partial`.
 * @param limits Raise a bound for this read.
 * @throws TypeError when `legs` is not a string or a short list of them; RangeError when a limit is not a count. Never for
 *   anything in the file.
 *
 * @example
 * ```typescript
 * import { readRunEvidence, readStoredRecord } from 'foottrace';
 *
 * const evidence = readRunEvidence(readStoredRecord(entries), 'run-1');
 * evidence.control('manual/junior#7');        // { status: 'collected', decider: 'manual/assign#6', label: 'Medium risk', gaps: [] }
 * evidence.decisions.rows[0]?.evidence?.rules; // what it weighed
 * evidence.running.rows;                       // a killed run: the innermost subflow still open
 * ```
 */
export function readRunEvidence(
  stored: StoredRecord,
  legs: string | readonly string[],
  limits?: RunEvidenceLimits,
): RunEvidence {
  const bounds = limitsOf(limits);
  return foldRunEvidence(stored, legs, bounds, { left: bounds.fields });
}
