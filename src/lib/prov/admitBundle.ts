import { readAttemptWindow } from '../evidence/readAttempts.js';
import { parseAttemptId } from '../ids/attemptId.js';
import { admitStamps } from '../memory/readWindow.js';
import type { CommitBundle, CommitPhase, TraceEntry, UntrackedSource } from '../memory/types.js';
import { bundleRefusal, isCommitBundle } from '../time-travel/bundles.js';
import {
  dataField,
  dataList,
  dataNames,
  dataPath,
  dataPaths,
  dataString,
  ProvBudget,
  ProvDataRefusal,
  requireSpend,
  refusalCode,
} from './budget.js';
import type { AdmittedCommit, AdmittedRow } from './types.js';

/** A private gap placeholder preserves indexes for readers; it never becomes emitted activity. */
export function gapBundle(): CommitBundle {
  return { runtimeStageId: '', stage: '', stageId: '', trace: [], redactedPaths: [], overwrite: {}, updates: {} };
}

function patchEnvelope(value: unknown): object | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProvDataRefusal();
  return {}; // Values are opaque; an own getter beneath this envelope must never be inspected.
}

function admittedVerb(value: unknown): TraceEntry['verb'] {
  if (value !== 'set' && value !== 'merge' && value !== 'append' && value !== 'delete') throw new ProvDataRefusal();
  return value;
}

/** Project only the fields canonical replay sees, with no payload walk or accessor evaluation. */
export function admitBundle(
  raw: unknown,
  commitIdx: number,
  redactions: readonly string[],
  budget: ProvBudget,
  /** The index of the copy before this row in the log (-1 for the first): this copy's own rises past it. */
  after: number,
): AdmittedCommit | undefined {
  try {
    // Preserve the canonical primitive-envelope refusal without touching any untrusted property.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      budget.addGap({ code: 'invalid-data', commitIdx, reason: bundleRefusal(raw) });
      return undefined;
    }
    const runtime = dataField(raw, 'runtimeStageId', budget);
    const runtimeStageId = typeof runtime === 'string' ? dataString(runtime, budget) : runtime;
    const rawTrace = dataField(raw, 'trace', budget);
    const projected: Record<string, unknown> = { runtimeStageId, trace: rawTrace === undefined ? undefined : [] };
    const overwrite = dataField(raw, 'overwrite', budget),
      updates = dataField(raw, 'updates', budget);
    projected.overwrite = patchEnvelope(overwrite);
    projected.updates = patchEnvelope(updates);
    const rows: AdmittedRow[] = [];
    if (Array.isArray(rawTrace)) {
      const trace = dataList(rawTrace, budget.limits.maxRows, budget);
      requireSpend(budget, 'rows', trace.length);
      for (let rowIdx = 0; rowIdx < trace.length; rowIdx++) {
        const rawRow = trace[rowIdx],
          verb = admittedVerb(dataField(rawRow, 'verb', budget));
        const path = dataPath(dataField(rawRow, 'path', budget), budget);
        const rawReads = dataField(rawRow, 'readKeys', budget);
        const readKeys = rawReads === undefined ? undefined : dataPaths(rawReads, budget);
        const rawAttempts = dataField(rawRow, 'readAttempts', budget);
        const window = readAttemptWindow(
          rawRow,
          rawAttempts,
          (value, key) => dataField(value, key, budget),
          () => new ProvDataRefusal(),
        );
        const readAttemptsOmitted = window.omitted;
        let readAttempts: string[] | undefined;
        if (rawAttempts !== undefined) {
          const attempts = dataList(rawAttempts, budget.limits.maxReads, budget, window.expectedLength);
          requireSpend(budget, 'reads', attempts.length);
          readAttempts = [];
          for (const id of attempts) {
            if (typeof id !== 'string') throw new ProvDataRefusal();
            const admitted = dataString(id, budget);
            if (!parseAttemptId(admitted)) throw new ProvDataRefusal();
            readAttempts.push(admitted);
          }
          if (attempts.length) {
            // This value-free native projection has no external-operation translator.
            budget.addGap({ code: 'conservative', commitIdx, rowIdx });
            budget.addGap({ code: 'not-collected', commitIdx, rowIdx });
          }
        }
        // The writer's mark on a `set` row it built on the step's view (`TraceEntry.builtOnView`). Kept,
        // never dropped: without it the row reads as a replacement. Anything else in its place, or the
        // mark on another verb, refuses the bundle.
        const builtOnView = dataField(rawRow, 'builtOnView', budget);
        if (builtOnView !== undefined && (builtOnView !== true || verb !== 'set')) throw new ProvDataRefusal();
        rows.push({
          commitIdx,
          rowIdx,
          path,
          verb,
          ...(readKeys === undefined ? {} : { readKeys }),
          ...(readAttempts?.length ? { readAttempts } : {}),
          ...(readAttemptsOmitted === undefined ? {} : { readAttemptsOmitted }),
          ...(builtOnView === true ? { builtOnView: true as const } : {}),
        });
      }
      projected.trace = rows.map(({ path, verb, readKeys, readAttempts, readAttemptsOmitted, builtOnView }) => ({
        path,
        verb,
        ...(readKeys === undefined ? {} : { readKeys }),
        ...(readAttempts?.length ? { readAttempts } : {}),
        ...(readAttemptsOmitted === undefined ? {} : { readAttemptsOmitted }),
        ...(builtOnView === true ? { builtOnView: true as const } : {}),
      }));
    } else projected.trace = rawTrace;
    if (!isCommitBundle(projected)) {
      budget.addGap({ code: 'invalid-data', commitIdx, reason: bundleRefusal(projected) });
      return undefined;
    }
    const stage = dataField(raw, 'stage', budget),
      stageId = dataField(raw, 'stageId', budget);
    const tags = dataField(raw, 'tags', budget),
      phase = dataField(raw, 'phase', budget),
      untracked = dataField(raw, 'untrackedSources', budget);
    if (phase !== undefined && phase !== 'exit' && phase !== 'repeat') throw new ProvDataRefusal();
    // A read is dated by its step's stamps, read against each bundle's own `idx` (`memory/readWindow.ts`).
    // The copy keeps both; stamps that cannot be stamps refuse the bundle.
    const placed = admitStamps(
      dataField(raw, 'beganAt', budget),
      dataField(raw, 'sawUntil', budget),
      dataField(raw, 'idx', budget),
      after,
    );
    if (!placed) {
      // Said apart from a bundle that cannot be read: this one reads, but its stamps count against an index
      // that cannot be its own (not a whole number, or not past the row before it, whichever of the two is
      // the damaged one). The row is left out, never dated by guess.
      budget.addGap({ code: 'invalid-data', commitIdx, reason: 'read stamps do not fit the commit index' });
      return undefined;
    }
    const untrackedSources = untracked === undefined ? undefined : dataNames(untracked, budget, 'fields');
    if (untrackedSources?.some((source) => source !== 'args' && source !== 'env' && source !== 'silent'))
      throw new ProvDataRefusal();
    const bundle: CommitBundle = {
      runtimeStageId: projected.runtimeStageId as string,
      stage: typeof stage === 'string' ? dataString(stage, budget) : '',
      stageId: typeof stageId === 'string' ? dataString(stageId, budget) : '',
      trace: projected.trace as TraceEntry[],
      overwrite: {},
      updates: {},
      redactedPaths: [...redactions],
      ...(tags === undefined ? {} : { tags: dataNames(tags, budget, 'fields') }),
      ...(phase === undefined ? {} : { phase: phase as CommitPhase }),
      ...(untrackedSources === undefined ? {} : { untrackedSources: untrackedSources as UntrackedSource[] }),
      ...placed,
    };
    return { commitIdx, bundle, rows };
  } catch (error) {
    budget.addGap({ code: refusalCode(error), commitIdx, reason: 'unreadable commit bundle' });
    return undefined;
  }
}
