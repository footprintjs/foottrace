/**
 * admit.ts — one stored row, checked as untrusted input. A record file can say anything.
 *
 * THE LAW. Own data descriptors only, on plain current-realm objects and ordinary arrays: an accessor, a custom prototype
 * or a sparse array is refused, and no getter ever runs. A row is admitted whole or refused whole: what comes back is a
 * new frozen object holding the named fields, so a field nobody named is never copied and never read, which is also what
 * lets a newer writer add one without a version bump. Nothing here recurses, and every list and text has a cap. Past a
 * cap the refusal is `truncated`; anything else is `invalid-data`. A refusal carries no text from the file.
 *
 * Not here: the checks that need a whole log (a decision with no commit, a duplicate, a mount that does not lead in).
 * Those are `logFold.ts`'s. Integrity is not authentication: these catch inconsistent edits, not a careful forger.
 */

import { boundedName } from '../evidence/admission.js';
import { admitMarks } from '../evidence/marks.js';
import { executionIndexOf } from '../ids/runtimeStageId.js';
import type { UntrackedSource } from '../memory/types.js';
import {
  type CommitAbout,
  isCount,
  type LogCollects,
  type RunDecisionNote,
  type RunStageNote,
  type RunStopNote,
  type StoredDecisionEvidence,
  type StoredFilterCondition,
  type StoredReadInput,
  type StoredRetryLoopDecision,
  type StoredRule,
} from './kinds.js';
import {
  type Admission,
  boundedValue,
  count,
  DATA_ONLY,
  earlier,
  exactlyTrue,
  executionId,
  field,
  flag,
  list,
  ownField,
  plain,
  refuse,
  spend,
  text,
  tooMany,
} from './fields.js';

/** A condition's threshold: a scalar as it is, a forged object or list as a bounded copy. A hole is a string like any other. */
function threshold(value: unknown, a: Admission): unknown {
  return boundedValue(value, a.limits.thresholdSize, a);
}

function condition(value: unknown, a: Admission): StoredFilterCondition {
  plain(value);
  const { text: maxText } = a.limits;
  const held = ownField(value, 'threshold');
  return Object.freeze({
    key: text(ownField(value, 'key'), maxText),
    op: text(ownField(value, 'op'), maxText),
    ...(held === undefined ? {} : { threshold: threshold(held, a) }),
    actualSummary: text(ownField(value, 'actualSummary'), maxText),
    result: flag(ownField(value, 'result')),
    redacted: flag(ownField(value, 'redacted')),
    ...field('thresholdRedacted', ownField(value, 'thresholdRedacted'), exactlyTrue),
    ...field('thresholdSummarized', ownField(value, 'thresholdSummarized'), exactlyTrue),
  }) as StoredFilterCondition;
}

function readInput(value: unknown, a: Admission): StoredReadInput {
  plain(value);
  return Object.freeze({
    key: text(ownField(value, 'key'), a.limits.text),
    valueSummary: text(ownField(value, 'valueSummary'), a.limits.text),
    redacted: flag(ownField(value, 'redacted')),
  });
}

function rule(value: unknown, a: Admission): StoredRule {
  plain(value);
  const { text: maxText, conditions, inputs } = a.limits;
  const type = ownField(value, 'type');
  const base = {
    ruleIndex: count(ownField(value, 'ruleIndex')),
    branch: text(ownField(value, 'branch'), maxText),
    matched: flag(ownField(value, 'matched')),
    ...field('label', ownField(value, 'label'), (v) => text(v, maxText)),
    ...field('matchError', ownField(value, 'matchError'), (v) => text(v, maxText)),
  };
  if (type === 'function') {
    return Object.freeze({
      type,
      ...base,
      inputs: list(ownField(value, 'inputs'), inputs, (item) => readInput(item, a), a),
    });
  }
  if (type !== 'filter') throw refuse();
  return Object.freeze({
    type,
    ...base,
    conditions: list(ownField(value, 'conditions'), conditions, (item) => condition(item, a), a),
  });
}

function retryLoop(value: unknown, a: Admission): StoredRetryLoopDecision {
  plain(value);
  const effect = ownField(value, 'effect');
  const next = ownField(value, 'next');
  if (effect !== 'applied' && effect !== 'none' && effect !== 'unknown') throw refuse();
  if (next !== 'retry' && next !== 'done' && next !== 'stop') throw refuse();
  return Object.freeze({
    id: text(ownField(value, 'id'), a.limits.text),
    series: text(ownField(value, 'series'), a.limits.text),
    attempt: count(ownField(value, 'attempt')),
    of: count(ownField(value, 'of')),
    effect,
    reconciled: flag(ownField(value, 'reconciled')),
    next,
    reason: text(ownField(value, 'reason'), a.limits.text),
  });
}

function evidence(value: unknown, by: unknown, a: Admission): StoredDecisionEvidence {
  plain(value);
  const { text: maxText, rules, chosen } = a.limits;
  const held = list(ownField(value, 'rules'), rules, (item) => rule(item, a), a);
  const selected = ownField(value, 'selected');
  if (selected !== undefined) {
    if (by !== 'select') throw refuse();
    return Object.freeze({ rules: held, selected: list(selected, chosen, (item) => text(item, maxText), a) });
  }
  if (by !== 'decide') throw refuse();
  return Object.freeze({
    ...field('retryLoop', ownField(value, 'retryLoop'), (v) => retryLoop(v, a)),
    rules: held,
    chosen: text(ownField(value, 'chosen'), maxText),
    default: text(ownField(value, 'default'), maxText),
    ...field('defaultLabel', ownField(value, 'defaultLabel'), (v) => text(v, maxText)),
  });
}

/** What a log said it collects. A greater `v` than this reader knows is returned as it is: the caller says `newer-writer`. */
export function admitCollects(value: unknown): LogCollects {
  plain(value);
  const v = ownField(value, 'v');
  if (!isCount(v) || v < 1) throw refuse();
  const reads = ownField(value, 'reads');
  if (v === 1 && reads !== 'keys' && reads !== 'off') throw refuse();
  return Object.freeze({ v, reads: reads as LogCollects['reads'] });
}

/** A note's `seq`. */
export function admitSeq(data: unknown): number {
  plain(data);
  return count(ownField(data, 'seq'));
}

/** A commit's `about`, for the execution `id`. */
export function admitAbout(value: unknown, id: string, a: Admission): CommitAbout {
  plain(value);
  const index = executionIndexOf(id);
  const { reads, readLength, description } = a.limits;
  const attention = ownField(value, 'attention');
  const marks = attention === undefined ? undefined : admitMarks(attention, refuse, DATA_ONLY);
  if (marks !== undefined) spend(a, marks.length + 1);
  return Object.freeze({
    ...field('parent', ownField(value, 'parent'), (v) => earlier(v, index, a)),
    ...field('resumes', ownField(value, 'resumes'), (v) => earlier(v, index, a)),
    ...field('reads', ownField(value, 'reads'), (v) => list(v, reads, (name) => readName(name, readLength), a)),
    ...field('readsOmitted', ownField(value, 'readsOmitted'), count),
    ...field('description', ownField(value, 'description'), (v) => text(v, description)),
    ...(marks === undefined ? {} : { attention: marks }),
  });
}

/** One read key: a name with the record's path separator allowed. Past its length, refused, never cut. */
function readName(value: unknown, maximum: number): string {
  if (typeof value === 'string' && value.length > maximum) throw tooMany();
  return boundedName(value, maximum, refuse, true);
}

/** A stage's `bundle.untrackedSources`: the three fixed names, or a refusal. Absent reads as none. */
export function admitUntracked(value: unknown, a: Admission): readonly UntrackedSource[] {
  if (value === undefined) return [];
  return list(
    value,
    8,
    (item) => {
      if (item !== 'args' && item !== 'env' && item !== 'silent') throw refuse();
      return item;
    },
    a,
  );
}

const DECISION_BY: ReadonlySet<unknown> = new Set(['decide', 'select', 'plain']);

/** A `run.decision` note's body. */
export function admitDecision(data: unknown, a: Admission): RunDecisionNote {
  plain(data);
  const by = ownField(data, 'by');
  if (!DECISION_BY.has(by)) throw refuse();
  const { text: maxText, chosen: maxChosen } = a.limits;
  const raw = ownField(data, 'chosen');
  const chosen = typeof raw === 'string' ? text(raw, maxText) : list(raw, maxChosen, (item) => text(item, maxText), a);
  if ((by === 'decide' && typeof chosen !== 'string') || (by === 'select' && typeof chosen === 'string'))
    throw refuse();
  return Object.freeze({
    id: executionId(ownField(data, 'id'), a),
    by: by as RunDecisionNote['by'],
    chosen,
    ...field('total', ownField(data, 'total'), count),
    ...field('fellBack', ownField(data, 'fellBack'), exactlyTrue),
    ...field('rationale', ownField(data, 'rationale'), (v) => text(v, maxText)),
    ...field('evidence', ownField(data, 'evidence'), (v) => evidence(v, by, a)),
  });
}

function stopError(value: unknown, a: Admission): NonNullable<RunStopNote['error']> {
  plain(value);
  const code = ownField(value, 'code');
  if (code !== undefined && typeof code !== 'string' && typeof code !== 'number') throw refuse();
  return Object.freeze({
    ...field('name', ownField(value, 'name'), (v) => text(v, a.limits.text)),
    message: text(ownField(value, 'message'), a.limits.text),
    ...(code === undefined ? {} : { code: typeof code === 'string' ? text(code, a.limits.text) : code }),
  });
}

const STOP_BY: ReadonlySet<unknown> = new Set(['break', 'pause', 'failure']);
const PAUSED_BY: ReadonlySet<unknown> = new Set(['pausable', 'interrupt']);

/** A `run.stop` note's body. */
export function admitStop(data: unknown, a: Admission): RunStopNote {
  plain(data);
  const by = ownField(data, 'by');
  if (!STOP_BY.has(by)) throw refuse();
  const pausedBy = ownField(data, 'pausedBy');
  if (pausedBy !== undefined && !PAUSED_BY.has(pausedBy)) throw refuse();
  const payload = ownField(data, 'payload');
  const { text: maxText, payloadSize } = a.limits;
  return Object.freeze({
    id: executionId(ownField(data, 'id'), a),
    by: by as RunStopNote['by'],
    ...field('reason', ownField(data, 'reason'), (v) => text(v, maxText)),
    ...field('propagatedFrom', ownField(data, 'propagatedFrom'), (v) => executionId(v, a)),
    ...(pausedBy === undefined ? {} : { pausedBy: pausedBy as RunStopNote['pausedBy'] }),
    ...(payload === undefined ? {} : { payload: boundedValue(payload, payloadSize, a) }),
    ...field('category', ownField(data, 'category'), (v) => text(v, maxText)),
    ...field('error', ownField(data, 'error'), (v) => stopError(v, a)),
  });
}

/** A `run.stage` note's body. */
export function admitStage(data: unknown, a: Admission): RunStageNote {
  plain(data);
  const id = executionId(ownField(data, 'id'), a);
  const index = executionIndexOf(id);
  return Object.freeze({
    id,
    ...field('parent', ownField(data, 'parent'), (v) => earlier(v, index, a)),
    ...field('resumes', ownField(data, 'resumes'), (v) => earlier(v, index, a)),
  });
}
