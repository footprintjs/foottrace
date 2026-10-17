import type { LogAddress } from '../memory/eventPosition.js';
import { readStoredRecord } from '../time-travel/storedRecord.js';
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
} from './recordValidation.js';
import type { GraphContext, MaybePromise } from './types.js';
export interface StoredRecordScope extends Omit<RecordScope, 'address' | 'commitLog' | 'complete'> {
  readonly entries: readonly unknown[];
}
export interface StoredRecordHost {
  loadLog(address: LogAddress, context: GraphContext): MaybePromise<StoredRecordScope>;
}
/** Load one address only. The host owns auth/storage; cancellation is forwarded and waiting is independently bounded. */
export function createStoredRecordGraph(host: StoredRecordHost, options: RecordGraphOptions = {}): RecordCauseGraph {
  const limits = recordOptions(options);
  return createLazyRecordGraph(
    (address, context) =>
      projectLoaded(
        () => host.loadLog(address, context),
        (loaded) => {
          const max = limits.maxCommits,
            budget = { left: limits.maxFields };
          const raw = recordList(recordOwn(loaded, 'entries'), max * 4 + 16),
            entries: unknown[] = [];
          for (let i = 0; i < raw.length; i++) {
            if (context.signal.aborted) throw new RecordRefusal('cancelled');
            const entry = recordOwn(raw, String(i)),
              a = addressOf(recordOwn(entry, 'address'));
            if (addressKey(a) !== addressKey(address)) throw new RecordRefusal();
            const kind = recordOwn(entry, 'kind'),
              at = recordOwn(entry, 'at');
            if (typeof at !== 'number' || !Number.isFinite(at)) throw new RecordRefusal();
            if (kind === 'commit') {
              const b = recordOwn(entry, 'bundle'),
                idx = recordOwn(b, 'idx');
              if (!Number.isSafeInteger(idx) || (idx as number) < 0 || (idx as number) >= max)
                throw new RecordRefusal('node-limit');
              entries.push({ kind, address: a, at, bundle: bundleOf(b, idx as number, budget) });
            } else if (kind === 'opened')
              entries.push({ kind, address: a, at, initialState: dataCopy(recordOwn(entry, 'initialState'), budget) });
            else if (kind === 'closed')
              entries.push({
                kind,
                address: a,
                at,
                outcome: recordOwn(entry, 'outcome'),
                commits: recordOwn(entry, 'commits'),
              });
            else if (kind === 'note') {
              /* opaque note bodies never enter dependency projection */
            } else throw new RecordRefusal();
          }
          const record = readStoredRecord(entries, {
              entries: max * 4 + 16,
              missingCommits: max,
              drillDepth: 16,
              addressLength: 1536,
            }),
            log = record.log(address);
          if (!log) throw new RecordRefusal();
          if (log.gaps.length) throw new RecordRefusal('not-collected');
          return {
            scope: {
              address,
              commitLog: log.commitLog,
              reads: recordOwn(loaded, 'reads') as RecordScope['reads'],
              controlDeps: recordOwn(loaded, 'controlDeps') as RecordScope['controlDeps'],
              attention: recordOwn(loaded, 'attention') as RecordScope['attention'],
              complete: log.complete,
            },
            gaps: record.unread.length || log.gaps.length ? ['not-collected' as const] : [],
          };
        },
      ),
    limits,
  );
}
