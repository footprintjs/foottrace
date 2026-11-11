/**
 * slice/notes.ts — the sentences a key query says about what it could not see.
 *
 * LAW: every answer states what it could not see, in the SAME words whichever query produced it. A
 * code is what a consumer branches on (`HonestyNoteCode`, registered in `memory/honesty.ts`); the
 * detail is what a human or an LLM reads. One builder per sentence, in one place.
 *
 * WHY ITS OWN FILE: these lived in `keyIndex.ts`, between the index and its range helpers, and grew
 * with every code the readers gained (13 builders by 1.14.0). The index is about positions in a log;
 * this file is about words. Nothing here reads a log.
 *
 * DAG position: internal to slice/ (not exported from the barrel).
 */

import { shownPath } from '../record-paths/codec.js';
import type { KeyIndex } from './keyIndex.js';
import type { HonestyNote } from './types.js';

/** How many known keys an unknown-key refusal lists before it says "+N more". */
export const KNOWN_KEYS_LISTED = 10;

/**
 * At least one read a forward answer lists is only possible: the key was written inside the reader's window.
 * Two things make a window hold a write, and the sentence names both: the step really looked at state
 * again after another step committed, or the array does not show where the step's reads sit, so a
 * write that could lie in the window is taken to (`memory/windowPlacement.ts`). WHY both: the note
 * named only the first, and for a step that never looked again, in an array with a bundle that says
 * no index, it stated a second look that did not happen.
 */
export function concurrentReadsNote(reads: number): HonestyNote {
  return {
    code: 'concurrent-write',
    detail:
      `${reads} read${reads === 1 ? ' was' : 's were'} made by a step that looked at state again after another ` +
      'step committed the key (steps side by side), or by a step the array handed over does not place among ' +
      'its commits. Such a step may have read this value or another one written in that time, so it is a ' +
      'possible reader, not a certain one.',
  };
}

/**
 * LAW — an unknown key is NAMED as unknown; it never renders as "no history".
 *
 * The failure this prevents: `forwardSliceForKey(log, 'recipId')` (typo) must
 * not come back looking like a real variable that nothing happened to. The
 * answer says so out loud AND lists the keys the log does know — bounded, so
 * a 400-key agent state is a hint, not a wall.
 *
 * Why a NOTE and not a throw: the module's absence convention is a RESULT,
 * not an exception (`VariableSlice.missing`) — one absence vocabulary across
 * both doors. The loudness comes from the note + `missing: 'never-written'`,
 * not from a stack trace a triage tool would have to catch.
 */
export function unknownKeyNote(index: Pick<KeyIndex, 'knownKeys'>, key: string): HonestyNote {
  const all = [...index.knownKeys].sort();
  const shown = all.slice(0, KNOWN_KEYS_LISTED).map(shownPath);
  const more = all.length - shown.length;
  const known = shown.length > 0 ? `${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}` : '(none)';
  return {
    code: 'unknown-key',
    detail:
      `unknown key '${shownPath(key)}' — this commit log has no write and no recorded read of it. ` +
      `Known keys: ${known}. ` +
      'If the key is real, check that the commit log and the reads provider come from the SAME scope ' +
      '(a subflow has its own).',
  };
}

/** How many commit positions a note lists before it says "+N more" (a note is one bounded line). */
export const NESTED_WRITES_LISTED = 5;

/** The commits a note names, as words: `commit 3`, `commits 3, 7`, `commits 0, 1, 2, 3, 4 (+2 more)`. */
function commitsListed(commits: readonly number[]): string {
  const shown = commits.slice(0, NESTED_WRITES_LISTED);
  const more = commits.length - shown.length;
  return `commit${commits.length === 1 ? '' : 's'} ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`;
}

/** A write the answer rests on, or that a value's life crosses, merged into the key or appended to it. */
export function partialWriteNote(key: string, commits: readonly number[]): HonestyNote {
  return {
    code: 'partial-write',
    detail:
      `'${shownPath(key)}' was merged into or appended to at ${commitsListed(commits)} — such a write did not ` +
      'replace the value: it is made of that write and of the earlier ones, and a reader after it read all of them.',
  };
}

/** A write the answer rests on reached the key only through paths inside it. */
export function nestedRowsNote(key: string, commits: readonly number[]): HonestyNote {
  const at = commitsListed(commits);
  return {
    code: 'nested-rows',
    detail:
      `'${shownPath(key)}' was written only through paths inside it at ${at} — such a write changed part of ` +
      'its value, not the whole: earlier writes account for the rest (a walk back follows them), and a ' +
      'reader of the key may not have read the part it changed.',
  };
}

/**
 * At least one `set` row the writer built on a view is listed with possible sources only, because the
 * array does not show where that view sits. One sentence for the three queries that can meet it (a
 * backward slice, a forward slice, a timeline). No count: the three would count different things.
 */
export function viewNotPlacedNote(): HonestyNote {
  return {
    code: 'view-not-placed',
    detail:
      "a set row the writer built on a step's view is listed with possible sources only — the array handed " +
      'over does not show where that view sits among its commits (bundles around the commit say no index, ' +
      'the array holds several logs, or the stamp cannot be one), so each write the view could have held is ' +
      'named and none is certain.',
  };
}

/** At least one read a backward slice follows has only possible sources: its key was written inside the reader's window. */
export function concurrentWriteNote(reads: number): HonestyNote {
  return {
    code: 'concurrent-write',
    detail:
      `${reads} read${reads === 1 ? ' was' : 's were'} made by a step that looked at state again after another ` +
      'step committed the same key (steps side by side), or by a step the array handed over does not place ' +
      'among its commits. The record cannot say which value such a read saw, so every writer shown for that ' +
      'key is a possible source, not a certain one; the real source is among them, or is the value from ' +
      'before the run when the key is listed as read from there.',
  };
}

/** The value a backward slice explains holds, or lost the key under, the log's redaction placeholder. */
export function redactedValueNote(key: string): HonestyNote {
  return {
    code: 'redacted',
    detail:
      `'${shownPath(key)}' was redacted when it was written — where its value shows the log's placeholder (or ` +
      'the key is missing under a placeholder that replaced its container), the real value was never recorded.',
  };
}

/**
 * No set or delete of the key, or of a container around it, is under a value: it rests on the pre-run state.
 *
 * Said of ONE point, and the two callers have different points. A backward slice says it of the value
 * it explains (no `at`): nothing in its range wrote the whole value. A timeline says it of one WRITE
 * (`at`): the first write of the key, which did not replace it. WHY the timeline names the write: its
 * range goes on after that write, and a later one can replace the key. "No write of its whole value
 * in range" would then be false of the timeline, though it is true of that write.
 */
export function fromInitialStateNote(key: string, at?: number): HonestyNote {
  const shown = shownPath(key);
  return {
    code: 'from-initial-state',
    detail:
      at === undefined
        ? `'${shown}' has no write of its whole value in range — its value rests on what it held before the ` +
          'run, which the commit log cannot see, so the writes here may be only part of it.'
        : `'${shown}' was first written at commit ${at}, by a write that did not replace it — the value there ` +
          'rests on what the key held before the run, which the commit log cannot see, so the writes listed ' +
          'may be only part of it until one replaces the key.',
  };
}

/**
 * A `set` row the writer built on its step's view, when that view held no write of the key
 * (`KeyMoment.builtOnViewPreRun`). The row can sit on the key, around it, or on a path inside it
 * (then it holds part of the key): "in whole or in part". WHY NOT the `'from-initial-state'` note:
 * that one says no write of the whole value is under the value, which may then be partial. Such a
 * row is a whole write of its path. What the log cannot see is where the part of it came from that
 * the step did not write.
 */
export function preRunViewNote(key: string, commits: readonly number[]): HonestyNote {
  return {
    code: 'pre-run-view',
    detail:
      `'${shownPath(key)}' at ${commitsListed(commits)} is held, in whole or in part, in a set row the writer ` +
      "built on its step's view, and that view held no write of the key (or may have held none, where the " +
      "moment lists other writes it could have held) — what the row holds beyond the step's own writes was " +
      'absent or came from before the run, which the commit log cannot see.',
  };
}

// ── Shared honesty notes (one sentence per code, one place) ───────────────
//
// LAW: every forward answer states what it could not see, in the SAME words
// whichever query produced it. Codes are what a consumer branches on; the
// detail is what a human or an LLM reads.

/** The `readTracking: 'off'` signature — see the HonestyNoteCode docs. */
export function readsNotRecordedNote(): HonestyNote {
  return {
    code: 'reads-not-recorded',
    detail:
      "reads were not recorded (readTracking may be 'off') — 'nothing read this value' is " +
      'UNKNOWABLE here, not true.',
  };
}

/** The value predates every write this log can see. */
export function preRunOriginNote(key: string): HonestyNote {
  return {
    code: 'pre-run-origin',
    detail:
      `'${shownPath(key)}' has no write before this point — the value came from initial state, frozen run input ` +
      '(args), or a closure. The reads listed did see it; who put it there is outside the commit log.',
  };
}

/** At least one fed edge rests on stage-level co-occurrence only. */
export function conservativeEdgesNote(key: string): HonestyNote {
  return {
    code: 'conservative-fed-edges',
    detail:
      "some 'fed' edges are CONSERVATIVE (stage-level): those writes carry no per-write read provenance, " +
      `so a stage that read '${shownPath(key)}' and wrote another key may not actually have used it. Run with ` +
      "writeProvenance: 'reads-prefix' to get exact edges.",
  };
}

/** A budget cut the walk — stated, never silent. */
export function truncatedNote(byDepth: boolean, byNodes: boolean): HonestyNote {
  const causes = [byDepth && 'maxDepth reached', byNodes && 'maxNodes reached'].filter(Boolean).join(', ');
  return {
    code: 'truncated',
    detail: `walk truncated (${causes}) — more consumers of this value exist beyond this horizon.`,
  };
}
