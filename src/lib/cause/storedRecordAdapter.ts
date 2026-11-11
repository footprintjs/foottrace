import type { LogAddress } from '../memory/eventPosition.js';
import { RUN_EVIDENCE_LIMITS } from '../run-evidence/kinds.js';
import { foldRunEvidence } from '../run-evidence/read.js';
import type { RunEvidence } from '../run-evidence/rows.js';
import { readStoredRecord, type StoredRecord } from '../time-travel/storedRecord.js';
import {
  createLazyRecordGraph,
  recordOptions,
  type RecordCauseGraph,
  type RecordGraphOptions,
  type RecordScope,
} from './recordAdapter.js';
import {
  addressKey,
  addressOf,
  bundleOf,
  dataCopy,
  recordList,
  recordOwn,
  projectLoaded,
  RecordRefusal,
  spend,
} from './recordValidation.js';
import type { Attention, Gap, GraphContext, MaybePromise } from './types.js';
export interface StoredRecordScope extends Omit<RecordScope, 'address' | 'commitLog' | 'complete' | 'initialState'> {
  readonly entries: readonly unknown[];
}
export interface StoredRecordHost {
  loadLog(address: LogAddress, context: GraphContext): MaybePromise<StoredRecordScope>;
}

/** The three maps a scope can take from its own file, and what that file could not vouch for. */
interface ScopeEvidence {
  reads?: Record<string, readonly string[]>;
  controlDeps?: Record<string, { readonly deciderId: string }>;
  attention?: Record<string, readonly Attention[]>;
  gaps: readonly Gap['code'][];
}

/** A gap of a channel, if it has any. */
const gapsIn = (channel: RunEvidence[keyof Pick<RunEvidence, 'reads' | 'attention' | 'stages' | 'decisions'>]) =>
  channel.status === 'partial' ? channel.gaps : [];

/**
 * What a scope's own file holds, as the graph's maps, keyed on null-prototype objects: an id is data, never a field name.
 * `undefined` when the file holds no evidence: an omitted map stays "not collected", exactly as without this. Only this
 * log is read, so a chain that leaves it says `scope-boundary`, and every partial answer reaches the scope's coverage: a
 * missing control entry must never read as ungoverned. `untracked-input` is left to each bundle's own coverage.
 */
function scopeEvidence(
  record: StoredRecord,
  address: LogAddress,
  commitIds: readonly string[],
  budget: { left: number },
): ScopeEvidence | undefined {
  const evidence = foldRunEvidence(record, address.logRunId, RUN_EVIDENCE_LIMITS, budget);
  if (evidence.stages.status === 'not-collected') return undefined;
  const gaps = new Set<Gap['code']>([
    ...gapsIn(evidence.decisions),
    ...gapsIn(evidence.stages),
    ...gapsIn(evidence.attention),
    ...gapsIn(evidence.reads),
  ]);
  gaps.delete('untracked-input');
  const controlDeps = Object.create(null) as Record<string, { readonly deciderId: string }>;
  for (const id of commitIds) {
    const answer = evidence.control(id);
    if (answer.decider !== undefined) controlDeps[id] = { deciderId: answer.decider };
    if (answer.status === 'partial') for (const code of answer.gaps) gaps.add(code);
  }
  const attention = Object.create(null) as Record<string, readonly Attention[]>;
  for (const row of evidence.attention.rows) attention[row.id] = row.marks;
  const projected: ScopeEvidence = { controlDeps, attention, gaps: [...gaps] };
  if (evidence.reads.status !== 'not-collected') {
    const reads = Object.create(null) as Record<string, readonly string[]>;
    for (const row of evidence.reads.rows) reads[row.id] = row.keys;
    projected.reads = reads;
  }
  return projected;
}

/**
 * Load one address only. The host owns auth/storage; cancellation is forwarded and waiting is independently bounded.
 *
 * A file that holds its own evidence fills `reads`, `controlDeps` and `attention` where the host omits them; a host's map
 * always wins. The commit cap counts commits, not notes: every row spends one field, so the row count stays bounded.
 */
export function createStoredRecordGraph(host: StoredRecordHost, options: RecordGraphOptions = {}): RecordCauseGraph {
  const limits = recordOptions(options);
  return createLazyRecordGraph(
    (address, context) =>
      projectLoaded(
        () => host.loadLog(address, context),
        (loaded) => {
          const max = limits.maxCommits,
            commitCap = max * 4 + 16,
            budget = { left: limits.maxFields };
          const raw = recordList(recordOwn(loaded, 'entries'), limits.maxFields),
            entries: unknown[] = [];
          let commits = 0;
          for (let i = 0; i < raw.length; i++) {
            if (context.signal.aborted) throw new RecordRefusal('cancelled');
            spend(budget, 1);
            const entry = recordOwn(raw, String(i)),
              a = addressOf(recordOwn(entry, 'address'));
            if (addressKey(a) !== addressKey(address)) throw new RecordRefusal();
            const kind = recordOwn(entry, 'kind'),
              at = recordOwn(entry, 'at');
            if (typeof at !== 'number' || !Number.isFinite(at)) throw new RecordRefusal();
            if (kind === 'commit') {
              const b = recordOwn(entry, 'bundle'),
                idx = recordOwn(b, 'idx');
              if (!Number.isSafeInteger(idx) || (idx as number) < 0 || (idx as number) >= max || ++commits > commitCap)
                throw new RecordRefusal('node-limit');
              // `about`, `collects` and `runNotes` go on unread: `run-evidence/admit` is their one admission.
              const about = recordOwn(entry, 'about');
              entries.push({
                kind,
                address: a,
                at,
                bundle: bundleOf(b, idx as number, budget),
                ...(about === undefined ? {} : { about }),
              });
            } else if (kind === 'opened') {
              const collects = recordOwn(entry, 'collects');
              entries.push({
                kind,
                address: a,
                at,
                initialState: dataCopy(recordOwn(entry, 'initialState'), budget),
                ...(collects === undefined ? {} : { collects }),
              });
            } else if (kind === 'closed') {
              const runNotes = recordOwn(entry, 'runNotes');
              entries.push({
                kind,
                address: a,
                at,
                outcome: recordOwn(entry, 'outcome'),
                commits: recordOwn(entry, 'commits'),
                ...(runNotes === undefined ? {} : { runNotes }),
              });
            } else if (kind === 'note') {
              // A writer's own note stays opaque and never enters dependency projection; a run note is evidence.
              const note = recordOwn(entry, 'note');
              if (typeof note === 'string' && note.startsWith('run.')) {
                entries.push({ kind, address: a, at, note, data: recordOwn(entry, 'data') });
              }
            } else throw new RecordRefusal();
          }
          const record = readStoredRecord(entries, {
              entries: entries.length,
              missingCommits: max,
              drillDepth: 16,
              addressLength: 1536,
            }),
            log = record.log(address);
          if (!log) throw new RecordRefusal();
          if (log.gaps.length) throw new RecordRefusal('not-collected');
          const hostReads = recordOwn(loaded, 'reads') as RecordScope['reads'],
            hostControl = recordOwn(loaded, 'controlDeps') as RecordScope['controlDeps'],
            hostMarks = recordOwn(loaded, 'attention') as RecordScope['attention'];
          const own =
            hostReads !== undefined && hostControl !== undefined && hostMarks !== undefined
              ? undefined
              : scopeEvidence(
                  record,
                  address,
                  log.commitLog.map((bundle) => bundle.runtimeStageId),
                  budget,
                );
          const stored: Gap['code'][] = record.unread.length ? ['not-collected'] : [];
          return {
            scope: {
              address,
              commitLog: log.commitLog,
              initialState: log.initialState,
              readSources: recordOwn(loaded, 'readSources') as RecordScope['readSources'],
              reads: hostReads ?? own?.reads,
              controlDeps: hostControl ?? own?.controlDeps,
              attention: hostMarks ?? own?.attention,
              complete: log.complete,
            },
            gaps: [...new Set([...stored, ...(own?.gaps ?? [])])],
          };
        },
      ),
    limits,
  );
}
