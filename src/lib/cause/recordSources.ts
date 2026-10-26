import { parseAttemptId } from '../ids/attemptId.js';
import { commitValueAtWithBasis } from '../memory/commitLogUtils.js';
import type { LogAddress } from '../memory/eventPosition.js';
import { relation } from '../memory/keyPaths.js';
import { nativeGet, nativeHas } from '../memory/pathOps.js';
import { normaliseStateKey, pathSegments } from '../memory/paths.js';
import type { CommitBundle } from '../memory/types.js';
import { nativeExecution } from '../prov/ids.js';
import { decodeReadSourceSnapshot } from '../read-sources/codec.js';
import type { ReadSourceGap, ReadSourceOccurrence, ReadSourceSnapshot } from '../read-sources/types.js';
import {
  addressKey,
  dataCopy,
  names,
  recordList,
  recordName,
  recordOwn,
  RecordRefusal,
  spend,
} from './recordValidation.js';
import type { GapCode } from './types.js';

/** Authorized host bindings, never a model-selected source, storage locator or receipt. */
export interface ReadSourceExecution {
  readonly runtimeStageId: string;
  readonly stateAddress: readonly string[];
  readonly attemptIds?: readonly string[];
}
/** The host first admits its native observation or saved receipt. This seam grants no authority. */
export interface RecordReadSources {
  readonly record: ReadSourceSnapshot;
  readonly executions: readonly ReadSourceExecution[];
}
export interface ExactRecordRead {
  readonly occurrence: ReadSourceOccurrence;
  readonly path: string;
  readonly commitIdx?: number;
  readonly rowIdx?: number;
  readonly readerCommitIdx: number;
}
export interface PreparedReadSources {
  readonly observations: readonly ExactRecordRead[];
  readonly owners: ReadonlySet<string>;
  readonly byOwner: ReadonlyMap<string, readonly ExactRecordRead[]>;
  readonly byCommit: ReadonlyMap<number, readonly ExactRecordRead[]>;
  readonly gaps: readonly GapCode[];
}
const sourceGapCodes: Readonly<Record<ReadSourceGap, GapCode>> = {
  'composite-unsupported': 'unsupported',
  redacted: 'redacted',
  'untracked-write': 'untracked-input',
  'undefined-presence-unknown': 'unavailable',
  'budget-exhausted': 'truncated',
  'capture-failed': 'unavailable',
  'scope-retired': 'unavailable',
};
const scalar = (value: unknown): boolean =>
  value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number';
const samePath = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((part, index) => part === right[index]);

/** One bounded consumer admission for cause and PROV. The codec and value reader retain their own laws. */
export function prepareReadSources(
  value: unknown,
  address: LogAddress,
  log: CommitBundle[],
  initialState: unknown,
  budget: { left: number },
): PreparedReadSources | undefined {
  if (value === undefined) return undefined;
  const gaps: GapCode[] = [],
    addGap = (code: GapCode) => {
      if (!gaps.includes(code)) gaps.push(code);
    };
  try {
    const rawRecord = recordOwn(value, 'record');
    // The native snapshot may share frozen descriptors. Its codec owns inert copying; generic cycle refusal would reject valid sharing.
    const occurrences = recordList(recordOwn(rawRecord, 'occurrences'), Math.min(65536, Math.floor(budget.left / 12)));
    spend(budget, occurrences.length * 12 + 1);
    const record = decodeReadSourceSnapshot(rawRecord);
    if (!record || addressKey(record.address) !== addressKey(address)) throw new RecordRefusal();
    if (address.drillPath.length) throw new RecordRefusal('scope-boundary');
    if (record.segment !== 1) throw new RecordRefusal('unsupported');
    const base = initialState === undefined ? undefined : dataCopy(initialState, budget);
    const firstCommits = new Map<string, number>();
    spend(budget, log.length);
    log.forEach((bundle, index) => {
      if (!firstCommits.has(bundle.runtimeStageId)) firstCommits.set(bundle.runtimeStageId, index);
    });
    const bindings = new Map<string, { stateAddress: string[]; attempts: Set<string> }>();
    for (const raw of recordList(recordOwn(value, 'executions'), log.length)) {
      const id = recordName(recordOwn(raw, 'runtimeStageId'));
      if (!nativeExecution(id) || bindings.has(id) || !firstCommits.has(id)) throw new RecordRefusal();
      const stateAddress = names(recordOwn(raw, 'stateAddress'), 64, true);
      spend(budget, stateAddress.length + 1);
      const attempts = names(recordOwn(raw, 'attemptIds') ?? [], 16384);
      spend(budget, attempts.length);
      if (
        new Set(attempts).size !== attempts.length ||
        attempts.some((idValue) => parseAttemptId(idValue)?.runtimeStageId !== id)
      )
        throw new RecordRefusal();
      bindings.set(id, { stateAddress, attempts: new Set(attempts) });
    }
    const observations: ExactRecordRead[] = [],
      confirmed = new Map<string, boolean>();
    const privacy = new Map<string, boolean>();
    const redactions = log.flatMap((bundle) => bundle.redactedPaths);
    const privacyCost = redactions.reduce((n, path) => n + path.length + 1, 1);
    // Precharge each distinct canonical value query. No unbounded per-occurrence replay or source reconstruction.
    const queryCost = log.reduce(
      (cost, bundle) =>
        cost + 1 + bundle.trace.reduce((n, row) => n + (row.path.length + 1) * pathSegments(row.path).length, 0),
      1,
    );
    for (const occurrence of record.occurrences) {
      spend(budget, occurrence.stateAddress.length + occurrence.key.length + 1);
      const readerCommitIdx = firstCommits.get(occurrence.runtimeStageId)!;
      const binding = bindings.get(occurrence.runtimeStageId);
      if (
        !binding ||
        !samePath(binding.stateAddress, occurrence.stateAddress) ||
        !occurrence.attemptId ||
        !binding.attempts.has(occurrence.attemptId)
      )
        throw new RecordRefusal();
      const parts = [...occurrence.stateAddress, occurrence.key],
        path = normaliseStateKey(parts);
      if (!samePath(pathSegments(path), parts)) {
        addGap('unsupported');
        continue;
      }
      let hidden = privacy.get(path);
      if (hidden === undefined) {
        spend(budget, privacyCost + path.length * Math.max(1, redactions.length));
        hidden = redactions.some((mark) => relation(mark, path) !== undefined);
        privacy.set(path, hidden);
      }
      if (hidden) {
        addGap('redacted');
        continue;
      }
      const source = occurrence.source;
      if (source.kind === 'unavailable') {
        addGap(sourceGapCodes[source.reason]);
        continue;
      }
      if (source.kind === 'staged') {
        addGap('unsupported');
        continue;
      }
      if (source.kind === 'base') {
        if (!base || typeof base !== 'object' || !nativeHas(base, parts) || !scalar(nativeGet(base, parts))) {
          addGap('unavailable');
          continue;
        }
        observations.push({ occurrence, path, readerCommitIdx });
        continue;
      }
      const index = source.commitIdx,
        bundle = log[index],
        first = firstCommits.get(occurrence.runtimeStageId);
      if (!bundle || first === undefined || index >= first) throw new RecordRefusal();
      let rowIdx = -1;
      for (let index = 0; index < bundle.trace.length; index++) if (bundle.trace[index].path === path) rowIdx = index;
      if (rowIdx < 0) throw new RecordRefusal();
      const cacheKey = JSON.stringify([index, path]);
      let exact = confirmed.get(cacheKey);
      if (exact === undefined) {
        spend(budget, queryCost + path.length + 1);
        const result = commitValueAtWithBasis(log, index, path, {
          initialState: base as Record<string, unknown> | undefined,
        });
        exact = scalar(result.value) && !result.basis.includes('redacted');
        confirmed.set(cacheKey, exact);
      }
      if (!exact) {
        addGap('unsupported');
        continue;
      }
      observations.push({ occurrence, path, commitIdx: index, rowIdx, readerCommitIdx });
    }
    for (const gap of record.gaps) addGap(sourceGapCodes[gap.reason]);
    if (record.status === 'failed' || record.status === 'retired') addGap('unavailable');
    if (record.status !== 'captured' || record.gaps.length) addGap('not-collected');
    const byOwner = new Map<string, ExactRecordRead[]>(),
      byCommit = new Map<number, ExactRecordRead[]>();
    for (const read of observations) {
      const owner = byOwner.get(read.occurrence.runtimeStageId) ?? [];
      owner.push(read);
      byOwner.set(read.occurrence.runtimeStageId, owner);
      if (read.commitIdx !== undefined) {
        const writes = byCommit.get(read.commitIdx) ?? [];
        writes.push(read);
        byCommit.set(read.commitIdx, writes);
      }
    }
    // An optional binding without a known authorized attempt cannot establish empty execution coverage.
    const owners = new Set([...bindings].filter(([, binding]) => binding.attempts.size > 0).map(([id]) => id));
    return { observations, owners, byOwner, byCommit, gaps };
  } catch (error) {
    return {
      observations: [],
      owners: new Set(),
      byOwner: new Map(),
      byCommit: new Map(),
      gaps: [error instanceof RecordRefusal ? error.code : 'invalid-data'],
    };
  }
}
