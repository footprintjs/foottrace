import { decodeRecordCapture } from '../evidence/recordCapture/decode.js';
import { witness } from '../evidence/recordCapture/shape.js';
import type { CaptureObservation } from '../evidence/recordCapture/types.js';
import { addressOf, recordList, recordName, recordOwn, spend } from '../evidence/recordData.js';
import { DELIM } from '../record-paths/codec.js';
import { lastWriterPosition } from './commitLogUtils.js';
import type { LogAddress } from './eventPosition.js';
import { between, lowerBound, relation, rootOf } from './keyPaths.js';
import { trackedReadNames } from './stageReadNames.js';
import type { CommitBundle, TraceEntry } from './types.js';
import type {
  UnchangedWrite,
  UnchangedWriteGap,
  UnchangedWriteGapReason,
  UnchangedWriteRecording,
  UnchangedWriteResult,
} from './unchangedWriteTypes.js';
import { isVerb } from './verbs.js';

const MAX_RECORD_FIELDS = 1_000_000;
const EMPTY_RESULT: UnchangedWriteResult = Object.freeze({ writes: Object.freeze([]), gaps: Object.freeze([]) });
const GAP_CODES = {
  'ambiguous-key': 'invalid-data',
  'child-namespace': 'scope-mismatch',
  'repeated-stage': 'invalid-data',
  'scope-mismatch': 'scope-mismatch',
  redacted: 'redacted',
  'tracking-unverified': 'not-collected',
  'write-bag-missing': 'not-collected',
  'tracking-disabled': 'not-collected',
  malformed: 'invalid-data',
  'commit-gap': 'incomplete-record',
  'window-incomplete': 'incomplete-record',
  'undefined-write': 'not-collected',
} as const satisfies Record<UnchangedWriteGapReason, UnchangedWriteGap['code']>;

type Budget = { left: number };
type Positions = Map<string, number[]>;
type Stage = { readonly node: object; readonly id: unknown; readonly child: boolean };
type Prepared = { read(key: string, beforeIdx?: number): UnchangedWriteResult };

function gap(reason: UnchangedWriteGapReason, commitIdx?: number): UnchangedWriteGap {
  return Object.freeze({ code: GAP_CODES[reason], reason, ...(commitIdx === undefined ? {} : { commitIdx }) });
}

function missing(reason: UnchangedWriteGapReason, commitIdx?: number): UnchangedWriteResult {
  return Object.freeze({ writes: EMPTY_RESULT.writes, gaps: Object.freeze([gap(reason, commitIdx)]) });
}

function unavailable(reason: UnchangedWriteGapReason): Prepared {
  const result = missing(reason);
  return { read: () => result };
}

function list(value: unknown, budget: Budget): readonly unknown[] {
  const items = recordList(value, budget.left);
  spend(budget, items.length);
  return items;
}

function admitLog(raw: unknown, budget: Budget): readonly CommitBundle[] {
  const emptyPatch = Object.freeze({});
  return Object.freeze(
    list(raw, budget).map((item, position) => {
      const idx = recordOwn(item, 'idx');
      if (idx !== undefined && idx !== position) throw new TypeError();
      const runtimeStageId = recordName(recordOwn(item, 'runtimeStageId'));
      const stageId = recordName(recordOwn(item, 'stageId'));
      const phase = recordOwn(item, 'phase');
      if (phase !== undefined && phase !== 'repeat' && phase !== 'exit') throw new TypeError();
      const trace = list(recordOwn(item, 'trace'), budget).map((row): TraceEntry => {
        const path = recordName(recordOwn(row, 'path'), true);
        const verb = recordOwn(row, 'verb');
        if (!isVerb(verb)) throw new TypeError();
        return Object.freeze({ path, verb });
      });
      const redactedPaths = list(recordOwn(item, 'redactedPaths') ?? [], budget).map((path) => recordName(path, true));
      Object.freeze(trace);
      Object.freeze(redactedPaths);
      // The top-level writer rule uses trace paths only. Value payloads never enter this reader.
      return Object.freeze({
        idx,
        runtimeStageId,
        stageId,
        stage: stageId,
        phase,
        trace,
        redactedPaths,
        overwrite: emptyPatch,
        updates: emptyPatch,
      });
    }),
  );
}

function admitStages(tree: unknown, budget: Budget): ReadonlyMap<string, Stage | null> {
  const stages = new Map<string, Stage | null>();
  if (tree === undefined) return stages;
  const pending: Array<{ node: unknown; child: boolean }> = [];
  const push = (items: readonly unknown[], child: boolean) => {
    for (const node of items) pending.push({ node, child });
  };
  push(Array.isArray(tree) ? list(tree, budget) : [tree], false);
  const seen = new Set<object>();
  while (pending.length) {
    const { node, child } = pending.pop()!;
    spend(budget, 1);
    if (node === null || typeof node !== 'object' || Array.isArray(node) || seen.has(node)) throw new TypeError();
    seen.add(node);
    const runtimeStageId = recordOwn(node, 'runtimeStageId');
    if (runtimeStageId !== undefined) {
      const id = recordName(runtimeStageId);
      const stage = { node, id: recordOwn(node, 'id'), child: child || recordOwn(node, 'subflowId') !== undefined };
      stages.set(id, stages.has(id) ? null : stage);
    }
    const next = recordOwn(node, 'next');
    const children = recordOwn(node, 'children');
    const branches = recordOwn(node, 'branches');
    if (next !== undefined) pending.push({ node: next, child });
    if (children !== undefined) push(list(children, budget), true);
    if (branches !== undefined) for (const chain of list(branches, budget)) push(list(chain, budget), true);
  }
  return stages;
}

function captureOf(
  recording: unknown,
  address: LogAddress,
  runId: string,
  log: readonly CommitBundle[],
): CaptureObservation | undefined {
  try {
    const reference = witness(recordOwn(recording, 'captureWitness'));
    if (reference?.runId !== runId) return undefined;
    return decodeRecordCapture({ captureWitness: reference, capture: recordOwn(recording, 'capture') }, address, log);
  } catch {
    return undefined;
  }
}

function addPosition<K extends string>(index: Map<K, number[]>, key: K, position: number): void {
  const entries = index.get(key);
  if (entries) entries.push(position);
  else index.set(key, [position]);
}

function ownKeys(value: unknown, budget: Budget): readonly string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError();
  const keys = Object.getOwnPropertyNames(value);
  spend(budget, keys.length);
  return keys;
}

function storedReads(node: object, budget: Budget): readonly string[] {
  const bag = recordOwn(node, 'stageReads');
  const names: Record<string, null> | undefined = bag === undefined ? undefined : Object.create(null);
  if (names)
    for (const name of ownKeys(bag, budget)) {
      const slot = Object.getOwnPropertyDescriptor(bag, name);
      if (!slot || !Object.hasOwn(slot, 'value')) throw new TypeError();
      if (slot.enumerable) names[name] = null;
    }
  return Object.freeze(trackedReadNames(node, names, (count) => spend(budget, count)));
}

function stageGap(
  stage: Stage | null | undefined,
  bundle: CommitBundle,
  stageCount: number | undefined,
  treeMissing: boolean,
): UnchangedWriteGapReason | undefined {
  if (bundle.phase !== undefined || stageCount !== 1 || stage === null) return 'repeated-stage';
  if (treeMissing) return 'write-bag-missing';
  if (stage === undefined || stage.id !== bundle.stageId) return 'scope-mismatch';
  if (stage.child) return 'child-namespace';
  return undefined;
}

function indexRecording(
  log: readonly CommitBundle[],
  stages: ReadonlyMap<string, Stage | null>,
  capture: CaptureObservation | undefined,
  treeMissing: boolean,
  budget: Budget,
): Prepared {
  const counts = new Map<string, number>();
  for (const bundle of log) counts.set(bundle.runtimeStageId, (counts.get(bundle.runtimeStageId) ?? 0) + 1);
  const writes: Positions = new Map();
  const undefinedWrites: Positions = new Map();
  const redactions: Positions = new Map();
  const observations = new Map<number, UnchangedWrite>();
  const stageGaps = new Map<UnchangedWriteGapReason, number[]>();
  for (const [position, bundle] of log.entries()) {
    for (const path of bundle.redactedPaths) addPosition(redactions, rootOf(path), position);
    const channel =
      capture && position >= capture.commits.from && position < capture.commits.to
        ? capture.channels.writes
        : undefined;
    const stage = stages.get(bundle.runtimeStageId);
    const reason = channel?.reasons.includes('redacted')
      ? 'redacted'
      : channel?.status === 'disabled'
      ? 'tracking-disabled'
      : stageGap(stage, bundle, counts.get(bundle.runtimeStageId), treeMissing);
    if (reason !== undefined) {
      addPosition(stageGaps, reason, position);
      continue;
    }
    try {
      const node = stage!.node;
      const bag = recordOwn(node, 'stageWrites');
      const tracked = channel?.status === 'collected' && capture?.boundary === 'completed';
      if (!tracked) {
        addPosition(
          stageGaps,
          channel && capture?.boundary !== 'completed'
            ? 'window-incomplete'
            : bag === undefined
            ? 'write-bag-missing'
            : 'tracking-unverified',
          position,
        );
      }
      if (bag === undefined) continue;
      const present: string[] = [];
      const omitted: string[] = [];
      for (const name of ownKeys(bag, budget)) {
        const slot = Object.getOwnPropertyDescriptor(bag, name);
        if (!slot || !Object.hasOwn(slot, 'value') || !slot.enumerable) throw new TypeError();
        if (name.includes(DELIM) || name.includes('.')) continue;
        if (slot.value !== undefined) present.push(name);
        // Bare JSON drops these slots. Neither bare form establishes they were retained.
        else if (tracked) omitted.push(name);
      }
      if (present.length) {
        const readKeys = storedReads(node, budget);
        observations.set(
          position,
          Object.freeze({
            commitIdx: position,
            runtimeStageId: bundle.runtimeStageId,
            stageId: bundle.stageId,
            readKeys,
          }),
        );
        for (const name of present) addPosition(writes, name, position);
      }
      for (const name of omitted) addPosition(undefinedWrites, name, position);
    } catch {
      addPosition(stageGaps, 'malformed', position);
    }
  }

  return {
    read(key, beforeIdx = log.length) {
      if (typeof key !== 'string' || !Number.isSafeInteger(beforeIdx) || beforeIdx < 0 || beforeIdx > log.length) {
        return missing('malformed');
      }
      if (key.includes(DELIM) || key.includes('.')) return missing('ambiguous-key');
      const lastChange = lastWriterPosition(log, key, beforeIdx);
      const redacted = redactions.get(key) ?? [];
      const redactedAt = redacted[lowerBound(redacted, lastChange)];
      if (redactedAt !== undefined && redactedAt < beforeIdx) {
        return missing('redacted', redactedAt);
      }
      const omitted = between(undefinedWrites.get(key) ?? [], lastChange, beforeIdx);
      const observed = between(writes.get(key) ?? [], lastChange, beforeIdx);
      const hasEvidence = new Set([...observed, ...omitted]);
      const gaps: UnchangedWriteGap[] = omitted.length ? [gap('undefined-write', omitted[0])] : [];
      for (const [reason, positions] of stageGaps) {
        let i = lowerBound(positions, lastChange + 1);
        if (reason === 'tracking-unverified') while (hasEvidence.has(positions[i])) i++;
        const pos = positions[i];
        if (pos !== undefined && pos < beforeIdx) gaps.push(gap(reason, pos));
      }
      gaps.sort((a, b) => (a.commitIdx ?? -1) - (b.commitIdx ?? -1));
      const examples = gaps.some((entry) => entry.reason === 'redacted')
        ? []
        : observed
            .filter((at) => !log[at].trace.some((row) => relation(row.path, key) !== undefined))
            .map((at) => observations.get(at)!);
      return examples.length || gaps.length
        ? Object.freeze({ writes: Object.freeze(examples), gaps: Object.freeze(gaps) })
        : EMPTY_RESULT;
    },
  };
}

/** Prepare one same-scope tree/log join for all questions in an opt-in causal walk. */
export function prepareUnchangedWrites(recording: unknown, expectedLog?: readonly CommitBundle[]): Prepared {
  try {
    const rawLog = recordOwn(recording, 'commitLog');
    if (expectedLog !== undefined && rawLog !== expectedLog) return unavailable('scope-mismatch');
    const runId = recordName(recordOwn(recording, 'runId'));
    const address = addressOf(recordOwn(recording, 'logAddress'));
    if (address.drillPath.length) return unavailable('child-namespace');
    if (address.logRunId !== runId) return unavailable('scope-mismatch');
    const budget = { left: MAX_RECORD_FIELDS };
    let log: readonly CommitBundle[];
    try {
      log = admitLog(rawLog, budget);
    } catch {
      return unavailable('commit-gap');
    }
    const tree = recordOwn(recording, 'executionTree');
    return indexRecording(
      log,
      admitStages(tree, budget),
      captureOf(recording, address, runId, log),
      tree === undefined,
      budget,
    );
  } catch {
    return unavailable('malformed');
  }
}

/** Find retained writes after the last recorded change and strictly before the given commit position. */
export function findUnchangedWrites(
  recording: UnchangedWriteRecording,
  key: string,
  beforeIdx?: number,
): UnchangedWriteResult {
  return prepareUnchangedWrites(recording).read(key, beforeIdx);
}
