/**
 * logFold.ts — one flat pass over one log's entries, and the checks that need the whole log.
 *
 * Row shapes are `admit.ts`'s. Here: `seq` and `about` keep the first; a decision needs its commit, unless the store lost
 * a commit and so cannot say; a mount's first execution must lead in from its mount, or continue a pause; `run.stage` and
 * `about` for one execution must agree. Holes are counted by arithmetic and never allocated, so a forged `seq` costs
 * nothing. Every refused row goes to `unread` by position, with a reason that names a field and never echoes the file.
 */

import { EvidenceRefusal } from '../evidence/admission.js';
import type { GapCode } from '../evidence/codes.js';
import { executionIndexOf } from '../ids/runtimeStageId.js';
import type { LogAddress } from '../memory/eventPosition.js';
import type { UntrackedSource } from '../memory/types.js';
import type { StoredLog } from '../time-travel/storedRecord.js';
import { admitAbout, admitCollects, admitDecision, admitSeq, admitStage, admitStop, admitUntracked } from './admit.js';
import { type Admission, executionId, ownField, spend } from './fields.js';
import {
  type CommitAbout,
  isCount,
  isRunNoteKind,
  type LogCollects,
  RUN_EVIDENCE_VERSION,
  type RunNoteKind,
} from './kinds.js';
import type { RunEvidenceUnread, StoredDecision, StoredStop } from './rows.js';

/** A refusal with a fixed reason of its own. Any other refusal is named by its row. */
class Refusal extends EvidenceRefusal {
  constructor(reason: string, code: GapCode = 'invalid-data') {
    super(code, reason);
  }
}

export type Channel = 'decisions' | 'stops' | 'reads' | 'attention' | 'stages' | 'control';
const ABOUT_CHANNELS: readonly Channel[] = ['reads', 'attention', 'stages', 'control'];
const EVERY_CHANNEL: readonly Channel[] = ['decisions', 'stops', 'reads', 'attention', 'stages', 'control'];
/** What any `run.*` row could have held: so a closed count, or a row of a kind this reader cannot name. */
const ANY_NOTE_CHANNELS: readonly Channel[] = ['decisions', 'stops', 'stages', 'control'];
const NOTE_CHANNELS: Record<RunNoteKind, readonly Channel[]> = {
  'run.decision': ['decisions', 'control'],
  'run.stop': ['stops'],
  'run.stage': ['stages', 'control'],
};

/** One execution as one log saw it, from one row. */
export interface LocalEdge {
  readonly id: string;
  readonly parent?: string;
  readonly resumes?: string;
  readonly description?: string;
  readonly from: 'about' | 'stage';
  readonly index: number;
}

/** One log's walk: what it holds, what it refused, and what that does to each channel. */
export interface LogFold {
  readonly log: StoredLog;
  readonly address: LogAddress;
  /** Why this log holds no evidence; absent when it does. */
  readonly why?: string;
  readonly collects?: LogCollects;
  readonly gaps: Set<GapCode>;
  readonly taint: Map<Channel, Set<GapCode>>;
  readonly unread: RunEvidenceUnread[];
  readonly commits: Set<string>;
  /** First bundles that came with no `about`. */
  readonly missing: Set<string>;
  readonly abouts: Map<string, { readonly about: CommitAbout; readonly index: number }>;
  readonly untracked: Map<string, Set<UntrackedSource>>;
  readonly edges: LocalEdge[];
  decisions: { readonly row: StoredDecision; readonly index: number }[];
  readonly stops: StoredStop[];
  readonly seqs: Set<number>;
  maxSeq: number;
  runNotes: number;
  sawCount: boolean;
}

function codeOf(error: unknown): GapCode {
  return error instanceof EvidenceRefusal ? error.code : 'invalid-data';
}

function refused(fold: LogFold, channels: readonly Channel[], index: number, reason: string, code: GapCode): void {
  fold.unread.push(Object.freeze({ address: fold.address, index, reason }));
  for (const channel of channels) {
    const held = fold.taint.get(channel);
    if (held === undefined) fold.taint.set(channel, new Set([code]));
    else held.add(code);
  }
}

/** Does this log hold evidence? Absent, malformed and newer all answer no, each with its own name. */
function collectsOf(log: StoredLog): { collects?: LogCollects; why?: string } {
  try {
    const opened = log.entries.find((entry) => ownField(entry, 'kind') === 'opened');
    const raw = opened === undefined ? undefined : ownField(opened, 'collects');
    if (raw === undefined) return { why: 'no-collects' };
    const collects = admitCollects(raw);
    return collects.v > RUN_EVIDENCE_VERSION ? { why: 'newer-writer' } : { collects };
  } catch {
    return { why: 'invalid-collects' };
  }
}

export function newFold(log: StoredLog): LogFold {
  const { collects, why } = collectsOf(log);
  return {
    log,
    address: log.address,
    ...(why === undefined ? {} : { why }),
    ...(collects === undefined ? {} : { collects }),
    gaps: new Set(),
    taint: new Map(),
    unread: [],
    commits: new Set(),
    missing: new Set(),
    abouts: new Map(),
    untracked: new Map(),
    edges: [],
    decisions: [],
    stops: [],
    seqs: new Set(),
    maxSeq: -1,
    runNotes: 0,
    sawCount: false,
  };
}

/** The mount this log belongs to; a root has none. */
export function mountOf({ drillPath }: LogAddress): string | undefined {
  return drillPath.length === 0 ? undefined : drillPath[drillPath.length - 1];
}

function readCommit(fold: LogFold, entry: unknown, index: number, a: Admission): void {
  try {
    const bundle = ownField(entry, 'bundle');
    const raw = ownField(bundle, 'runtimeStageId');
    const about = ownField(entry, 'about');
    const phase = ownField(bundle, 'phase');
    const id = executionId(raw, a);
    const seed = id === mountOf(fold.address);
    // A seed is the mount's own act in its own log: it says nothing about the mount's execution, whose row is in the parent log.
    if (!seed) fold.commits.add(id);
    const untracked = admitUntracked(ownField(bundle, 'untrackedSources'), a);
    if (untracked.length > 0) {
      const held = fold.untracked.get(id) ?? new Set();
      for (const source of untracked) held.add(source);
      fold.untracked.set(id, held);
    }
    if (about === undefined) {
      if (!seed && phase === undefined && !fold.abouts.has(id)) fold.missing.add(id);
      return;
    }
    if (seed) throw new Refusal('about: on a mount log’s seed, which carries none');
    if (phase !== undefined) throw new Refusal('about: on a continuation bundle, which carries none');
    if (fold.abouts.has(id)) throw new Refusal('about: a duplicate; the first stands');
    spend(a, 1);
    const admitted = admitAbout(about, id, a);
    fold.abouts.set(id, { about: admitted, index });
    fold.missing.delete(id);
    fold.edges.push({
      id,
      ...(admitted.parent === undefined ? {} : { parent: admitted.parent }),
      ...(admitted.resumes === undefined ? {} : { resumes: admitted.resumes }),
      ...(admitted.description === undefined ? {} : { description: admitted.description }),
      from: 'about',
      index,
    });
  } catch (error) {
    refusedRow(fold, ABOUT_CHANNELS, index, 'commit: about refused', error);
  }
}

function refusedRow(fold: LogFold, channels: readonly Channel[], index: number, label: string, error: unknown): void {
  const reason = error instanceof Refusal ? error.message : `${label} (${codeOf(error)})`;
  refused(fold, channels, index, reason, codeOf(error));
}

function readNote(fold: LogFold, entry: unknown, index: number, a: Admission): void {
  const kind = ownField(entry, 'note');
  if (typeof kind !== 'string' || !kind.startsWith('run.')) return;
  const known = isRunNoteKind(kind);
  try {
    const data = ownField(entry, 'data');
    const seq = admitSeq(data);
    if (fold.seqs.has(seq)) throw new Refusal('a run note with a duplicate seq; the first stands');
    fold.seqs.add(seq);
    fold.maxSeq = Math.max(fold.maxSeq, seq);
    spend(a, 1);
    if (!known) {
      refused(fold, ANY_NOTE_CHANNELS, index, 'a run note of an unknown kind: not read', 'invalid-data');
    } else if (kind === 'run.decision') {
      fold.decisions.push({ row: Object.freeze({ seq, ...admitDecision(data, a), address: fold.address }), index });
    } else if (kind === 'run.stop') {
      fold.stops.push(Object.freeze({ seq, ...admitStop(data, a), address: fold.address }));
    } else {
      fold.edges.push({ ...admitStage(data, a), from: 'stage', index });
    }
  } catch (error) {
    const label = known ? `${kind}: refused` : 'a run note of an unknown kind: refused';
    refusedRow(fold, known ? NOTE_CHANNELS[kind] : ANY_NOTE_CHANNELS, index, label, error);
  }
}

function readClosed(fold: LogFold, entry: unknown, index: number): void {
  try {
    const runNotes = ownField(entry, 'runNotes');
    if (runNotes === undefined) return;
    if (!isCount(runNotes)) throw new Refusal('closed: runNotes is not a count');
    fold.runNotes = Math.max(fold.runNotes, runNotes);
    fold.sawCount = true;
  } catch (error) {
    refusedRow(fold, ANY_NOTE_CHANNELS, index, 'closed: refused', error);
  }
}

/** What a log's own shape says about every channel. Holes are counted, never listed: a forged `seq` allocates nothing. */
function logGaps(fold: LogFold, unreadStore: boolean): void {
  const { log, seqs, maxSeq, runNotes, sawCount, gaps } = fold;
  if (!log.complete || log.gaps.length > 0 || unreadStore) gaps.add('not-collected');
  if (log.complete && !sawCount) gaps.add('not-collected');
  if (Math.max(maxSeq + 1, runNotes) > seqs.size) gaps.add('not-collected');
}

/** A decision needs its commit in its log, unless the store lost a commit and so cannot say. */
function checkDecisions(fold: LogFold): void {
  const seen = new Set<string>();
  const kept: LogFold['decisions'] = [];
  for (const item of fold.decisions) {
    const { id } = item.row;
    const channels: readonly Channel[] = ['decisions', 'control'];
    if (seen.has(id)) {
      refused(fold, channels, item.index, 'run.decision: a duplicate; the first stands', 'invalid-data');
    } else if (!fold.commits.has(id) && fold.log.gaps.length === 0) {
      refused(fold, channels, item.index, 'run.decision: no commit for this id in its log', 'invalid-data');
    } else {
      seen.add(id);
      kept.push(item);
    }
  }
  fold.decisions = kept;
}

/** Refuse a row already read as an edge, and what its `about` brought with it. */
function refuseEdge(fold: LogFold, edge: LocalEdge, reason: string): void {
  if (edge.from === 'about') fold.abouts.delete(edge.id);
  refused(
    fold,
    edge.from === 'about' ? ABOUT_CHANNELS : NOTE_CHANNELS['run.stage'],
    edge.index,
    reason,
    'invalid-data',
  );
}

/** A mount's first execution must lead in from its mount, or continue a pause. A log with a loss cannot say which is first. */
function checkMountEntry(fold: LogFold): void {
  const mount = mountOf(fold.address);
  if (mount === undefined || fold.gaps.has('not-collected') || fold.edges.length === 0) return;
  let first = fold.edges[0];
  for (const edge of fold.edges) if (executionIndexOf(edge.id) < executionIndexOf(first.id)) first = edge;
  if (first.parent !== mount && first.resumes === undefined) {
    fold.edges.splice(fold.edges.indexOf(first), 1);
    refuseEdge(fold, first, 'a mount’s first execution does not lead in from its mount');
  }
}

/** One row per execution across every log. `run.stage` and `about` may both name one, and must agree. */
export function mergeEdges(folds: readonly LogFold[]): Map<string, LocalEdge & { fold: LogFold; froms: Set<string> }> {
  const merged = new Map<string, LocalEdge & { fold: LogFold; froms: Set<string> }>();
  for (const fold of folds) {
    for (const edge of fold.edges) {
      const held = merged.get(edge.id);
      if (held === undefined) {
        merged.set(edge.id, { ...edge, fold, froms: new Set([edge.from]) });
      } else if (
        held.fold !== fold ||
        held.froms.has(edge.from) ||
        held.parent !== edge.parent ||
        (held.resumes !== undefined && edge.resumes !== undefined && held.resumes !== edge.resumes)
      ) {
        refuseEdge(fold, edge, 'an execution another row already says otherwise about; the first stands');
      } else {
        held.froms.add(edge.from);
        merged.set(edge.id, {
          ...held,
          ...(edge.resumes === undefined ? {} : { resumes: edge.resumes }),
          ...(edge.description === undefined ? {} : { description: edge.description }),
        });
      }
    }
  }
  return merged;
}

/** Read one log's entries, then its whole-log checks. */
export function walk(fold: LogFold, a: Admission, unreadStore: boolean): void {
  const { entries } = fold.log;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    try {
      const kind = ownField(entry, 'kind');
      if (kind === 'commit') readCommit(fold, entry, index, a);
      else if (kind === 'note') readNote(fold, entry, index, a);
      else if (kind === 'closed') readClosed(fold, entry, index);
    } catch (error) {
      refusedRow(fold, EVERY_CHANNEL, index, 'an entry refused', error);
    }
  }
  logGaps(fold, unreadStore);
  checkDecisions(fold);
  checkMountEntry(fold);
}
