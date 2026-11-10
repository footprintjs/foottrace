/**
 * kinds.ts — the shapes of a run's evidence in a stored log: one place for the writer and the reader.
 *
 * A log that declares `opened.collects` keeps, beside its commits, what an offline reader needs to say why a
 * stage ran: `commit.about` on an execution's first bundle, and three note kinds. Everything else is folded at
 * read time (`read.ts`, `control.ts`). No new top-level entry kind exists on purpose: a 1.11 reader refuses one,
 * and a note or an extra field passes through it untouched.
 *
 * WHO FILLS WHAT. The writer serves each value before it gets here: nothing in this file or in `EventLog` masks
 * anything. `runtimeStageId` is the join key everywhere; no entry stores a `commitIdx`.
 */

import type { Attention } from '../cause/types.js';
import { boundedName, type RefuseEvidence } from '../evidence/admission.js';
import { admitMarks, ATTENTION_LIMITS } from '../evidence/marks.js';
import { executionIndexOf } from '../ids/runtimeStageId.js';

/**
 * The one integer `opened.collects.v` holds. Additive fields keep it; a reader of a larger `v` says `newer-writer`. A new
 * `run.*` kind takes a larger `v`: under this one, a reader must treat a kind it cannot name as a fact it may have lost.
 */
export const RUN_EVIDENCE_VERSION = 1;

/**
 * The bounds of a run's evidence. The writer applies the first three (`boundedAbout`) and must keep its notes
 * inside the rest, because the reader refuses a row past any of them; a reader may raise them per call.
 *
 * Text sizes are UTF-16 code units, not transport bytes.
 */
export const RUN_EVIDENCE_LIMITS = /* @__PURE__ */ Object.freeze({
  /** Entries of `about.reads` looked at, so the most names kept; the rest are counted in `readsOmitted`, unread. */
  reads: 256,
  /** Characters in one read name; a longer one is left out and counted, never cut. */
  readLength: 256,
  /** Characters in `about.description`. */
  description: 512,
  /** Marks in `about.attention`: the one attention rule's own cap. */
  marks: ATTENTION_LIMITS.marks,
  /** Evidence refs on one mark: the one attention rule's own cap. */
  markRefs: ATTENTION_LIMITS.refs,
  /** Rules in one decision's evidence. */
  rules: 256,
  /** Conditions in one filter rule. */
  conditions: 64,
  /** Inputs in one function rule. */
  inputs: 64,
  /** Names in `run.decision · chosen` and `evidence.selected`. */
  chosen: 256,
  /** Characters in any one text field of a note: label, reason, summary, error message, id. */
  text: 4096,
  /** Items in a threshold the writer stores as written; past it, or non-scalar, it stores a summary. */
  thresholdItems: 16,
  /** Size of a threshold the reader admits (a forged object, say), counted as {@link RUN_EVIDENCE_LIMITS.payloadSize}. */
  thresholdSize: 4096,
  /** Depth of a pause payload the reader admits. */
  payloadDepth: 32,
  /** Size of a pause payload the reader admits: characters of its text and keys, plus 8 per scalar and 2 per container. */
  payloadSize: 1_048_576,
  /** Fields one read may admit across every row: one budget per call. */
  fields: 1_048_576,
});

/** Raise a bound for one read. Each is a non-negative integer or `Infinity`. */
export type RunEvidenceLimits = { readonly [Name in keyof typeof RUN_EVIDENCE_LIMITS]?: number };

/** What a log says it collected, on its `opened` entry. Absent: an older writer, evidence off, or a dropped field. */
export interface LogCollects {
  readonly v: number;
  /** `'off'` under a run that tracks no reads: `about.reads` then says nothing. */
  readonly reads: 'keys' | 'off';
}

/**
 * What a commit says about its execution — names only, never a value. On the FIRST bundle of an execution (no
 * `phase`), the rule `tags` follows; under `collects` it is always there, so a missing one is "not collected" for
 * that one stage. It sits beside the bundle, so the log's bytes, its served snapshot and any digest never move.
 */
export interface CommitAbout {
  /** The runtimeStageId of the execution that led here; it may be in another log. */
  readonly parent?: string;
  /** The paused execution this re-entry continues. */
  readonly resumes?: string;
  /** Distinct tracked key names, first-read order. */
  readonly reads?: readonly string[];
  /** Names past the bound on {@link reads}. */
  readonly readsOmitted?: number;
  /** Build-time text: the first execution of this stage in this log only. */
  readonly description?: string;
  /** Fixed reasons and attempt ids; absent when empty. */
  readonly attention?: readonly Attention[];
}

/** One rule's read, from `decide()` / `select()`. Its summary is already masked where the rule says so. */
export interface StoredReadInput {
  readonly key: string;
  readonly valueSummary: string;
  readonly redacted: boolean;
}

/** One filter condition. A masked threshold is a hole: its text is a placeholder, and `thresholdRedacted` says so. */
export interface StoredFilterCondition {
  readonly key: string;
  readonly op: string;
  readonly threshold: unknown;
  readonly actualSummary: string;
  readonly result: boolean;
  readonly redacted: boolean;
  /** The threshold was masked: `threshold` is a hole, not a value. The string `[REDACTED]` can be a real threshold. */
  readonly thresholdRedacted?: true;
  /** The threshold was too large or not a scalar: `threshold` is the writer's summary of it, not the value. */
  readonly thresholdSummarized?: true;
}

interface StoredRuleBase {
  readonly ruleIndex: number;
  readonly branch: string;
  readonly matched: boolean;
  readonly label?: string;
  readonly matchError?: string;
}

export interface StoredFunctionRule extends StoredRuleBase {
  readonly type: 'function';
  readonly inputs: readonly StoredReadInput[];
}

export interface StoredFilterRule extends StoredRuleBase {
  readonly type: 'filter';
  readonly conditions: readonly StoredFilterCondition[];
}

export type StoredRule = StoredFunctionRule | StoredFilterRule;

/** An explicit retry loop's logical decision: no key, raw error or provider payload. */
export interface StoredRetryLoopDecision {
  readonly id: string;
  readonly series: string;
  readonly attempt: number;
  readonly of: number;
  readonly effect: 'applied' | 'none' | 'unknown';
  readonly reconciled: boolean;
  readonly next: 'retry' | 'done' | 'stop';
  readonly reason: string;
}

/** What `decide()` recorded, as the writer served it. */
export interface StoredDecideEvidence {
  readonly retryLoop?: StoredRetryLoopDecision;
  readonly rules: readonly StoredRule[];
  readonly chosen: string;
  readonly default: string;
  readonly defaultLabel?: string;
}

/** What `select()` recorded, as the writer served it. */
export interface StoredSelectEvidence {
  readonly rules: readonly StoredRule[];
  readonly selected: readonly string[];
}

export type StoredDecisionEvidence = StoredDecideEvidence | StoredSelectEvidence;

/** A decider or selector dispatched: one per dispatch, after its commit. */
export interface RunDecisionNote {
  readonly id: string;
  readonly by: 'decide' | 'select' | 'plain';
  /** Display names: one branch for a decider, N for a selector. */
  readonly chosen: string | readonly string[];
  /** A selector's child count. */
  readonly total?: number;
  /** The returned id matched no child, so the default ran. */
  readonly fellBack?: true;
  readonly rationale?: string;
  readonly evidence?: StoredDecisionEvidence;
}

/** A stage stopped early; at most one per stop. */
export interface RunStopNote {
  readonly id: string;
  readonly by: 'break' | 'pause' | 'failure';
  /** Break: why, as served. */
  readonly reason?: string;
  /** Break: the inner subflow that raised it. */
  readonly propagatedFrom?: string;
  /** Pause: which door raised it. */
  readonly pausedBy?: 'pausable' | 'interrupt';
  /** Pause: what it asked, as served. The checkpoint keeps the real one. */
  readonly payload?: unknown;
  /** Failure: the classified category. */
  readonly category?: string;
  /** Failure: the served text, never the raw value. */
  readonly error?: { readonly name?: string; readonly message: string; readonly code?: string | number };
}

/**
 * An execution seen before, or without, a commit of its own: every mount at entry, a fork node with no function. So a
 * pause or a kill inside a subflow leaves a chain that resolves, and `resumes` is here because a re-entered mount's own
 * `about` lands only after its subflow.
 */
export interface RunStageNote {
  readonly id: string;
  readonly parent?: string;
  /** The paused execution this re-entry continues. */
  readonly resumes?: string;
}

/** What each `run.*` note holds, by kind, before the log stamps its `seq`. */
export interface RunNoteData {
  readonly 'run.decision': RunDecisionNote;
  readonly 'run.stop': RunStopNote;
  readonly 'run.stage': RunStageNote;
}

/** The closed list `EventLog · noteRun` writes. The prefix keeps them apart from a writer's own `note('decision', …)`. */
export type RunNoteKind = keyof RunNoteData;

const RUN_NOTE_KINDS: ReadonlySet<string> = /* @__PURE__ */ new Set<RunNoteKind>([
  'run.decision',
  'run.stop',
  'run.stage',
]);

/** Is `kind` one of the three the log writes? */
export function isRunNoteKind(kind: unknown): kind is RunNoteKind {
  return typeof kind === 'string' && RUN_NOTE_KINDS.has(kind);
}

const ID_GRAMMAR = /^[^#]+#(0|[1-9]\d*)$/;

/**
 * The one runtimeStageId rule of a run's evidence, for the writer and the reader alike: a name inside `maximum`, one
 * `#`, a safe execution index, no control characters. Returns the id, or throws what `refuse` makes.
 */
export function checkedExecutionId(value: unknown, maximum: number, refuse: RefuseEvidence): string {
  const id = boundedName(value, maximum, refuse);
  if (!ID_GRAMMAR.test(id) || !Number.isSafeInteger(executionIndexOf(id))) throw refuse();
  return id;
}

/** Does `kind` take the `run.` prefix only `EventLog · noteRun` may write? A writer's own `note` is refused one. */
export function isReservedNoteKind(kind: unknown): boolean {
  return typeof kind === 'string' && kind.startsWith('run.');
}

/** Is `value` a count: a non-negative safe integer? */
export function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function textField(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== 'string') throw new TypeError(`about.${name} must be a string`);
}

/** A `parent` or `resumes` the reader would admit as a runtimeStageId, or a `TypeError`. */
function idField(value: unknown, name: string): void {
  if (value === undefined) return;
  textField(value, name);
  checkedExecutionId(value, RUN_EVIDENCE_LIMITS.text, () => new TypeError(`about.${name} must be a runtimeStageId`));
}

const NOT_A_READ_NAME = new TypeError('not a read name');

/** Would the reader admit `name` as a read key? The reader's own name rule, with the record's path separator allowed. */
function isReadName(name: string): boolean {
  try {
    boundedName(name, RUN_EVIDENCE_LIMITS.readLength, () => NOT_A_READ_NAME, true);
    return true;
  } catch {
    return false;
  }
}

/**
 * The read names a sink keeps, and how many it left out. Only the bound's worth of entries is ever looked at. A name
 * the reader would refuse (empty, too long, a control character) is left out and counted, never cut or rewritten.
 */
function boundedReads(reads: unknown): { readonly kept: string[]; readonly left: number } {
  if (!Array.isArray(reads)) throw new TypeError('about.reads must be an array of strings');
  const length: unknown = reads.length;
  if (!isCount(length)) throw new TypeError('about.reads must be an array of strings');
  const looked = Math.min(length, RUN_EVIDENCE_LIMITS.reads);
  const kept: string[] = [];
  for (let i = 0; i < looked; i++) {
    const name: unknown = reads[i];
    if (typeof name !== 'string') throw new TypeError('about.reads must be an array of strings');
    if (isReadName(name)) kept.push(name);
  }
  return { kept, left: length - kept.length };
}

const refuseMarks = (): TypeError => new TypeError('about.attention must hold marks the attention rule admits');

/**
 * The marks a sink keeps, or a `TypeError`. The attention rule reads a mark's three declared fields once, as data (no
 * accessor runs), checks what it read and returns those values in fresh objects: what was checked is what is stored,
 * and an undeclared field has nowhere to go. A writer outside the rule has a bug; the count shows it.
 */
function copiedMarks(marks: unknown): readonly Attention[] {
  return admitMarks(marks, { refuse: refuseMarks, descriptors: { translateTrapErrors: true, requireOwnValue: true } });
}

/**
 * The `about` a sink keeps: the sink's own copy of the named fields only, in one key order, inside the bounds of
 * {@link RUN_EVIDENCE_LIMITS}. Each field is read once. Throws a `TypeError` when a field is not its type: the log
 * counts that as a lost `about`, and its commit still goes.
 */
export function boundedAbout(about: CommitAbout): CommitAbout {
  if (typeof about !== 'object' || about === null || Array.isArray(about)) {
    throw new TypeError('about must be a plain object');
  }
  const { parent, resumes, reads, readsOmitted, description, attention } = about;
  idField(parent, 'parent');
  idField(resumes, 'resumes');
  textField(description, 'description');
  if (readsOmitted !== undefined && !isCount(readsOmitted)) throw new TypeError('about.readsOmitted must be a count');
  const named = reads === undefined ? undefined : boundedReads(reads);
  const marks = attention === undefined ? undefined : copiedMarks(attention);
  const omitted = (readsOmitted ?? 0) + (named?.left ?? 0);
  return {
    ...(parent === undefined ? {} : { parent }),
    ...(resumes === undefined ? {} : { resumes }),
    ...(named === undefined ? {} : { reads: named.kept }),
    ...(omitted === 0 ? {} : { readsOmitted: Math.min(omitted, Number.MAX_SAFE_INTEGER) }),
    ...(description === undefined ? {} : { description: description.slice(0, RUN_EVIDENCE_LIMITS.description) }),
    ...(marks === undefined || marks.length === 0 ? {} : { attention: marks }),
  };
}
