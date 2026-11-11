/** rows.ts — what `readRunEvidence` hands back: its channels, its rows and how far to trust each. */

import type { Attention } from '../cause/types.js';
import type { GapCode } from '../evidence/codes.js';
import type { LogAddress } from '../memory/eventPosition.js';
import type { UntrackedSource } from '../memory/types.js';
import type { RunDecisionNote, RunStopNote } from './kinds.js';

/**
 * Why a channel or a `control` answer could not say more. The log-wide reasons: `no-collects` (no `opened.collects`, so
 * an older writer or evidence off), `newer-writer` (a larger `collects.v`), `invalid-collects`, `reads-off` (the reads
 * channel of a run that tracked none), `no-log` (no log given for the leg). The `control` reasons: `resumed-leg` (a
 * parentless execution that is not the root), `log-not-given` (a parent no given log holds), `no-about` (a stage with
 * no `about`), `unknown-execution` (an id no given log committed).
 */
export type RunEvidenceWhy =
  | 'no-collects'
  | 'newer-writer'
  | 'invalid-collects'
  | 'reads-off'
  | 'no-log'
  | 'resumed-leg'
  | 'log-not-given'
  | 'no-about'
  | 'unknown-execution';

/**
 * One kind of fact, and how far to trust its absence.
 *
 * - `collected`: the writer collected it and the log is whole, so an empty channel means none happened.
 * - `partial`: incomplete, a `seq` hole, a limit, a refused row. Empty means none SEEN.
 * - `not-collected`: this log holds no such facts. It says nothing about what happened; `why` says which case.
 */
export type EvidenceChannel<T> =
  | { readonly status: 'collected'; readonly rows: readonly T[] }
  | { readonly status: 'partial'; readonly rows: readonly T[]; readonly gaps: readonly GapCode[] }
  | { readonly status: 'not-collected'; readonly rows: readonly []; readonly why: RunEvidenceWhy };

/** A `run.decision` note, admitted. */
export interface StoredDecision extends RunDecisionNote {
  readonly seq: number;
  readonly address: LogAddress;
}

/** A `run.stop` note, admitted. */
export interface StoredStop extends RunStopNote {
  readonly seq: number;
  readonly address: LogAddress;
}

/** What one execution read, by name. A stage that also read what no name shows carries `untracked`. */
export interface StoredReads {
  readonly id: string;
  readonly address: LogAddress;
  readonly keys: readonly string[];
  /** Names the writer left out. */
  readonly omitted?: number;
  /** `bundle.untrackedSources`: args, env or a silent read fed this stage too. */
  readonly untracked?: readonly UntrackedSource[];
}

/** The attention marks one execution carried. */
export interface StoredMarks {
  readonly id: string;
  readonly address: LogAddress;
  readonly marks: readonly Attention[];
}

/** One execution, from its `about` and any `run.stage` note. */
export interface StoredStage {
  readonly id: string;
  readonly address: LogAddress;
  readonly parent?: string;
  readonly resumes?: string;
  readonly description?: string;
  /** Does its own commit stand in this log? A mount a pause or a kill stopped has none. */
  readonly committed: boolean;
}

/** A subflow whose log never closed: at the end of the file, this mount was running. The stage inside it stays unknown. */
export interface StoredRunningSubflow {
  readonly id: string;
  readonly address: LogAddress;
}

/**
 * Which decision let one execution run. No `decider` with `collected` means a whole chain to the root, with no decision
 * on it; absence under any other status never means ungoverned.
 */
export interface RunControl {
  readonly status: 'collected' | 'partial' | 'not-collected';
  readonly decider?: string;
  /** The matched rule's label; a selector has none. */
  readonly label?: string;
  readonly gaps: readonly GapCode[];
  /** Why the chain could not finish, or why nothing was collected: one {@link RunEvidenceWhy}. */
  readonly why?: RunEvidenceWhy;
}

/** A row refused, by its position in its log's entries. The reason names a field, never the file's text. */
export interface RunEvidenceUnread {
  readonly address: LogAddress;
  readonly index: number;
  readonly reason: string;
}

/** Everything one read of a run's stored logs can say about why it went as it did. */
export interface RunEvidence {
  readonly decisions: EvidenceChannel<StoredDecision>;
  readonly stops: EvidenceChannel<StoredStop>;
  readonly reads: EvidenceChannel<StoredReads>;
  readonly attention: EvidenceChannel<StoredMarks>;
  readonly stages: EvidenceChannel<StoredStage>;
  readonly running: EvidenceChannel<StoredRunningSubflow>;
  control(id: string): RunControl;
  readonly unread: readonly RunEvidenceUnread[];
}
