import { captureFor } from '../read-sources/bindings.js';
/**
 * recordCommit — one stage's commit onto the record (C1, L3). The one owner of a bundle's bytes and
 * of where a commit lands: live state, the redacted mirror, the log.
 *
 * THE LAW:
 *   1. No payload (the stage staged no write) → an EMPTY bundle goes to the log, and nothing else
 *      moves: live state and the mirror keep their generation. Every executed stage is a cursor stop.
 *   2. A payload → its names are read first, so a stamp that cannot be read fails the commit before
 *      anything moves; then its raw rows build live state's next generation, `scrubPatch`
 *      (`scrub.ts`, the record's own) puts the placeholder at each redacted path that holds a value
 *      (in a spine copy, never in the raw patch), and the mirror and the log take the scrubbed rows —
 *      never the raw ones. The redacted paths are data by now: the engine decided them per write
 *      (`RecordFrame · write`); nothing here imports the engine's verdict (C4).
 *   3. The bundle's KEY ORDER is the record's bytes: `overwrite`, `updates`, `redactedPaths`, `trace`,
 *      `stage`, `stageId`, `runtimeStageId`, then `untrackedSources`, `tags` and `phase`, each only
 *      when it has something to say (absent, never empty). `EventLog · record` appends `idx`. The
 *      names are names: no redaction reads them, and no encoding (`commitValues`) changes them.
 *      Last come `beganAt` and `sawUntil`, what the frame saw of the log ({@link seenOf}), each only
 *      when it says something: the frame knows them, the engine does not supply them.
 *   4. `about` goes to the log BESIDE the bundle, read with the names; it is never in the bundle, so
 *      it moves no byte of the log, the mirror or live state.
 *
 * The frame (`StageContext`) decides WHAT is committed — the payload, the names, whether the bundle
 * is a continuation — and keeps what is not the record: retention, diagnostics, the dev-mode
 * warnings and the commit observer.
 */

import type { CommitAbout } from '../run-evidence/kinds.js';
import type { EventLog } from './EventLog.js';
import { scrubPatch } from './scrub.js';
import type { SharedMemory } from './SharedMemory.js';
import type { TransactionBuffer } from './TransactionBuffer.js';
import type { CommitBundle, CommitPhase, MemoryPatch, TraceEntry, UntrackedSource } from './types.js';

/** One stage's net change, as `TransactionBuffer · commit` hands it over. */
export type CommitPayload = ReturnType<TransactionBuffer['commit']>;

/** What names a commit on the record, beside its payload (law 3). */
export interface CommitStamp {
  stage: string;
  stageId: string;
  runtimeStageId: string;
  untrackedSources?: ReadonlySet<UntrackedSource>;
  tags?: readonly string[];
  phase?: CommitPhase;
  /** What this commit says about its execution, for a log that keeps evidence (law 4). */
  about?: CommitAbout;
}

/** Where a commit lands: live state always; the mirror and the log when the run keeps them. */
export interface CommitTargets {
  state: SharedMemory;
  mirror?: SharedMemory;
  log?: EventLog;
}

type Names = Pick<CommitBundle, 'stage' | 'stageId' | 'runtimeStageId' | 'untrackedSources' | 'tags' | 'phase'>;

/**
 * Record one commit (the module law). `payload` absent = the empty commit. `beganAt` and `sawUntil`
 * are the log's length at the committing frame's first look at state and at its latest, when it looked.
 */
export function recordCommit(
  payload: CommitPayload | undefined,
  stamp: CommitStamp,
  into: CommitTargets,
  beganAt?: number,
  sawUntil?: number,
): void {
  const names = namesOf(stamp);
  const about = stamp.about;
  const seen = seenOf(into.log?.length, beganAt, sawUntil);
  if (payload === undefined) {
    into.log?.record(bundleOf({}, {}, [], [], names, seen), about);
    return;
  }
  const { redactedPaths, trace } = payload;
  into.state.applyPatch(payload.overwrite, payload.updates, trace);
  const capture = captureFor(into.state);
  const sourceClock = capture?.clock;
  const overwrite = scrubPatch(payload.overwrite, redactedPaths);
  const updates = scrubPatch(payload.updates, redactedPaths);
  into.mirror?.applyPatch(overwrite, updates, trace);
  if (!into.log) return;
  const bundle = bundleOf(overwrite, updates, [...redactedPaths], trace, names, seen);
  into.log.record(bundle, about);
  if (capture && capture === captureFor(into.log) && sourceClock !== undefined && bundle.idx !== undefined) {
    capture.confirm(sourceClock, bundle.idx, trace, redactedPaths);
  }
}

/** What a bundle says about when its frame looked at state (`CommitBundle.beganAt` / `sawUntil`). */
type Seen = Required<Pick<CommitBundle, 'beganAt'>> & Pick<CommitBundle, 'sawUntil'>;

/**
 * What the bundle about to take index `length` says of its frame's looks at state, or nothing.
 *
 * WHY EACH IS KEPT ONLY SOMETIMES. A reader dates a step's reads at its own commit unless the bundle
 * says otherwise, and that is right whenever nothing was committed since the frame's first look: a
 * run whose steps go one after another says nothing here and keeps its bytes. `beganAt` is kept when
 * a commit did land since that first look: the step's reads are then dated there. `sawUntil` is kept
 * when the frame also looked at live state after such a commit: the commits from `beganAt` up to it
 * are the ones a read may have seen. A frame that only read what it saw when it began says
 * `beganAt` alone, and its reads stay exact however many siblings committed first.
 */
function seenOf(
  length: number | undefined,
  beganAt: number | undefined,
  sawUntil: number | undefined,
): Seen | undefined {
  if (length === undefined || beganAt === undefined || beganAt >= length) return undefined;
  return sawUntil !== undefined && sawUntil > beganAt ? { beganAt, sawUntil } : { beganAt };
}

/** THE bundle (law 3): the payload's four keys, the three names, then each optional name that has something to say. */
function bundleOf(
  overwrite: MemoryPatch,
  updates: MemoryPatch,
  redactedPaths: string[],
  trace: TraceEntry[],
  names: Names,
  seen: Seen | undefined,
): CommitBundle {
  const { stage, stageId, runtimeStageId, untrackedSources, tags, phase } = names;
  const bundle: CommitBundle = { overwrite, updates, redactedPaths, trace, stage, stageId, runtimeStageId };
  if (untrackedSources) bundle.untrackedSources = untrackedSources;
  if (tags) bundle.tags = tags;
  if (phase) bundle.phase = phase;
  if (seen) {
    bundle.beganAt = seen.beganAt;
    if (seen.sawUntil !== undefined) bundle.sawUntil = seen.sawUntil;
  }
  return bundle;
}

/** The names, read once — before anything moves (law 2). An optional one with nothing to say is `undefined`. */
function namesOf({ stage, stageId, runtimeStageId, untrackedSources, tags, phase }: CommitStamp): Names {
  return {
    stage,
    stageId,
    runtimeStageId,
    untrackedSources: !untrackedSources || untrackedSources.size === 0 ? undefined : [...untrackedSources],
    tags: !tags || tags.length === 0 ? undefined : tags,
    phase: phase || undefined,
  };
}
