import { describe, expect, it, vi } from 'vitest';

import {
  causalChain,
  commitValueAt,
  findLastWriter,
  findReadSources,
  findUnchangedWrites,
  keysReadFromExecutionTree,
  stateAt,
  type CommitBundle,
} from '../../../src/index.js';
import { normaliseStateKey } from '../../../src/paths.js';
import { recordRun } from '../../helpers/recordRun.js';

type Recording = Parameters<typeof findUnchangedWrites>[0];
type TreeStage = {
  id: string;
  runtimeStageId: string;
  stageReads?: Record<string, unknown>;
  stageWrites?: Record<string, unknown>;
  undefinedReadKeys?: readonly string[];
  next?: TreeStage;
  children?: readonly TreeStage[];
  branches?: readonly (readonly TreeStage[])[];
};

const complete = 'complete';
const reader = 'decide#2';
const address = { logRunId: 'run', drillPath: [] };
const auditWrite = { commitIdx: 1, stageId: 'audit', runtimeStageId: 'audit#1', readKeys: ['manifest'] };
const noBag = { code: 'not-collected', reason: 'write-bag-missing', commitIdx: 1 };
const unknownChannel = { mode: 'unknown', status: 'unknown', reasons: ['unverified'] };
const channels = [
  'reads',
  'writes',
  'commitWrites',
  'writePrefixes',
  'nestedReads',
  'readSources',
  'inputHandoff',
  'outputHandoff',
  'fanoutHandoff',
  'attention',
  'control',
] as const;

function capture(recording: Recording, mode: 'full' | 'summary' | 'off', from = 0, to = recording.commitLog.length) {
  const commits = { from, to };
  const boundary = 'completed' as const;
  return {
    capture: {
      version: 3,
      scope: 'log',
      runId: recording.runId,
      logAddress: recording.logAddress,
      commits,
      boundary: { status: boundary },
      persistence: 'memory-only',
      channels: {
        ...Object.fromEntries(channels.map((channel) => [channel, unknownChannel])),
        writes: { mode, status: mode === 'off' ? 'disabled' : 'collected', reasons: [] },
      },
    },
    captureWitness: {
      runId: recording.runId,
      logAddress: recording.logAddress,
      commits,
      boundary,
      source: 'live' as const,
    },
  };
}

function stage(commit: CommitBundle, fields: Partial<TreeStage> = {}): TreeStage {
  return { id: commit.stageId, runtimeStageId: commit.runtimeStageId, ...fields };
}

function paired(commitLog: readonly CommitBundle[], executionTree: unknown): Recording {
  return { runId: 'run', logAddress: address, commitLog, executionTree };
}

function sample(
  commitValues: 'full' | 'delta' = 'full',
  writeTracking: 'full' | 'summary' | 'off' = 'full',
  audit: 'same-value' | 'revert' | 'no-write' = 'same-value',
) {
  const run = recordRun({}, { commitValues, writeProvenance: 'reads-prefix' });
  const seed = run.step('seed', (scope) => {
    scope.set(complete, true);
    scope.set('manifest', ['known']);
    scope.set('history', [0]);
  });
  const audited = run.step('audit', (scope) => {
    scope.read('manifest');
    if (audit === 'revert') scope.set(complete, false);
    if (audit !== 'no-write') scope.set(complete, true);
  });
  const decision = run.step('decide', (scope) => {
    scope.read(complete);
    scope.set('history', [0, 1]);
  });
  const { commitLog, initialState } = run.snapshot();
  // RecordFrame provides the real effect log. These fields are the tree view retained by the engine.
  const tracking = writeTracking !== 'off';
  const stages = [
    stage(seed, tracking ? { stageWrites: { complete: true, manifest: ['known'], history: [0] } } : {}),
    stage(audited, {
      stageReads: { manifest: ['known'] },
      ...(tracking && audit !== 'no-write'
        ? {
            stageWrites: {
              complete: writeTracking === 'summary' ? { __writeSummary: true, type: 'boolean', preview: 'true' } : true,
            },
          }
        : {}),
    }),
    stage(decision, { stageReads: { complete: true }, ...(tracking ? { stageWrites: { history: [0, 1] } } : {}) }),
  ];
  return { recording: paired(Object.freeze(commitLog), stages), initialState, stages };
}

function walk(recording: Recording, optIn = true) {
  // The public walk accepts a mutable array type but never mutates the recording.
  const log = recording.commitLog as CommitBundle[];
  const keys = keysReadFromExecutionTree(recording.executionTree);
  return causalChain(log, reader, keys.lookup, { ...(optIn && { unchangedWrites: recording }) });
}

function edgeFacts(edges: NonNullable<ReturnType<typeof walk>>['parentEdges']) {
  return edges.map(({ kind, key, parent }) => [kind, key, parent.runtimeStageId]);
}

describe('unchanged writes and value provenance', () => {
  it.each([
    ['full', 'full'],
    ['full', 'summary'],
    ['full', 'off'],
    ['delta', 'full'],
    ['delta', 'summary'],
    ['delta', 'off'],
  ] as const)('reads the %s encoding with %s write tracking', (encoding, tracking) => {
    const fixture = sample(encoding, tracking);
    const recorded = fixture.recording;
    const log = recorded.commitLog as CommitBundle[];
    const bundle = log[1];
    expect(bundle.trace).toEqual([]);
    expect(log[2].trace.map(({ verb }) => verb)).toEqual([encoding === 'delta' ? 'append' : 'set']);

    const recording = tracking === 'off' ? { ...recorded, ...capture(recorded, 'off') } : recorded;
    const baseline = JSON.stringify(walk(recording, false));
    const valueSources = JSON.stringify(findReadSources(log, 2, complete));
    const bytes = JSON.stringify(recording);
    const withWrites = walk(recording);
    expect(withWrites).toBeDefined();
    expect(JSON.stringify(walk(recording, false))).toBe(baseline);
    expect(JSON.stringify(recording)).toBe(bytes);
    expect(findLastWriter(log, complete, 2)?.runtimeStageId).toBe('seed#0');
    expect(findReadSources(log, 2, complete)).toMatchObject({ before: 0, during: [] });
    expect(JSON.stringify(findReadSources(log, 2, complete))).toBe(valueSources);
    expect(commitValueAt(log, 2, complete)).toBe(true);
    expect(stateAt({ initialState: fixture.initialState, commitLog: log }, 2).state).toEqual({
      complete: true,
      history: [0, 1],
      manifest: ['known'],
    });

    const valueEdge = ['data', complete, 'seed#0'];
    expect(edgeFacts(walk(recording, false)!.parentEdges)).toEqual([valueEdge]);
    if (tracking === 'off') {
      const disabled = { code: 'not-collected', reason: 'tracking-disabled', commitIdx: 1 };
      expect(findUnchangedWrites(recording, complete, 2)).toEqual({ writes: [], gaps: [disabled] });
      expect(edgeFacts(withWrites!.parentEdges)).toEqual([valueEdge]);
      expect(withWrites?.unchangedWriteGaps).toContainEqual({ key: complete, ...disabled });
    } else {
      const held = ['unchanged-write', complete, 'audit#1'];
      expect(findUnchangedWrites(recording, complete, 2)).toEqual({ writes: [auditWrite], gaps: [] });
      expect(edgeFacts(withWrites!.parentEdges)).toEqual([valueEdge, held]);
      expect(withWrites?.unchangedWriteGaps).toBeUndefined();
      const audit = withWrites?.parents.find((item) => item.runtimeStageId === 'audit#1');
      expect(audit?.keysWritten).toEqual([]);
      expect(edgeFacts(audit!.parentEdges)).toEqual([['data', 'manifest', 'seed#0']]);
    }
  });

  it.each(['linked', 'list'] as const)('uses the same observed names before and after JSON with a %s tree', (shape) => {
    const { recording, stages } = sample('delta', 'summary');
    stages[1].stageReads = { ...stages[1].stageReads, unset: undefined };
    stages[1].undefinedReadKeys = ['unset'];
    const [first, middle, last] = stages;
    const executionTree = shape === 'linked' ? { ...first, next: { ...middle, next: last } } : stages;
    const live = { ...recording, executionTree };
    const reopened = JSON.parse(JSON.stringify(live)) as Recording;
    const expected = { writes: [{ ...auditWrite, readKeys: ['manifest', 'unset'] }], gaps: [] };
    expect(findUnchangedWrites(live, complete, 2)).toEqual(expected);
    expect(findUnchangedWrites(reopened, complete, 2)).toEqual(expected);
    expect(walk(reopened)).toEqual(walk(live));
  });

  it('makes the same claim when a real stage writes and reverts', () => {
    const once = sample('full', 'full', 'same-value').recording;
    const reverted = sample('full', 'full', 'revert').recording;
    expect(reverted.commitLog[1].trace).toEqual([]);
    expect(findUnchangedWrites(reverted, complete, 2)).toEqual(findUnchangedWrites(once, complete, 2));
    expect(walk(reverted)).toEqual(walk(once));
  });

  it('uses the unchanged stage’s retained reads under per-write attribution', () => {
    const { recording } = sample();
    const keys = keysReadFromExecutionTree(recording.executionTree);
    const result = causalChain(recording.commitLog as CommitBundle[], reader, keys.lookup, {
      edgeAttribution: 'per-write',
      rootLinkKeys: ['history'],
      unchangedWrites: recording,
    });
    const audit = result?.parents.find((item) => item.runtimeStageId === 'audit#1');
    expect(edgeFacts(audit!.parentEdges)).toEqual([['data', 'manifest', 'seed#0']]);
    expect(audit?.keysWritten).toEqual([]);
  });

  it('does not reuse tracking evidence for another tree with the same frozen log', () => {
    const { recording, stages } = sample();
    const without = { ...recording, executionTree: stages.map(({ stageWrites: _, ...item }) => item) };
    expect(findUnchangedWrites(recording, complete, 2)).toEqual({ writes: [auditWrite], gaps: [] });
    expect(findUnchangedWrites(without, complete, 2)).toEqual({ writes: [], gaps: [noBag] });
    expect(findUnchangedWrites(recording, complete, 2)).toEqual({ writes: [auditWrite], gaps: [] });
  });

  it('keeps a nested changer in the value walk only', () => {
    const run = recordRun({}, { commitValues: 'delta' });
    const seed = run.step('seed', (scope) => scope.set(complete, { part: 1 }));
    const changer = run.step('audit', (scope) => scope.set('part', 2, undefined, [complete]));
    const decide = run.step('decide', (scope) => scope.read(complete));
    const log = run.snapshot().commitLog;
    const tree = [
      stage(seed),
      stage(changer, { stageWrites: { complete: { part: 2 } } }),
      stage(decide, { stageReads: { complete: { part: 2 } } }),
    ];
    const recording = paired(log, tree);
    expect(changer.trace.map((row) => row.path)).toEqual([normaliseStateKey([complete, 'part'])]);
    expect(findLastWriter(log, complete, 2)?.runtimeStageId).toBe('audit#1');
    expect(findUnchangedWrites(recording, complete, 2)).toEqual({ writes: [], gaps: [] });
    expect(edgeFacts(walk(recording)!.parentEdges)).toEqual([['data', complete, 'audit#1']]);
  });

  it('bounds repeated loop stages by the requested cutoff and the most recent change', () => {
    const run = recordRun();
    const values = [true, true, true, false, false];
    const stages = values.map((value, index) => {
      const commit = run.step(index === 0 ? 'seed' : 'audit', (scope) => scope.set(complete, value));
      return stage(commit, { stageWrites: { complete: value } });
    });
    const recording = paired(run.snapshot().commitLog, stages);
    expect(findUnchangedWrites(recording, complete, 3)).toEqual({
      writes: [1, 2].map((commitIdx) => ({
        commitIdx,
        stageId: 'audit',
        runtimeStageId: 'audit#' + commitIdx,
        readKeys: [],
      })),
      gaps: [],
    });
    expect(findUnchangedWrites(recording, complete)).toEqual({
      writes: [{ commitIdx: 4, stageId: 'audit', runtimeStageId: 'audit#4', readKeys: [] }],
      gaps: [],
    });
  });

  it('does not name a retained write beyond a pinned read or attach it as a certain in-window source', () => {
    const { recording } = sample();
    const [seed, audit, decide] = recording.commitLog;
    const pinned = { ...recording, commitLog: [seed, audit, { ...decide, beganAt: 1 }] };
    const wide = { ...recording, commitLog: [seed, audit, { ...decide, beganAt: 1, sawUntil: 2 }] };
    const valueEdge = ['data', complete, 'seed#0'];
    expect(edgeFacts(walk(pinned)!.parentEdges)).toEqual([valueEdge]);
    expect(walk(pinned)?.unchangedWriteGaps).toBeUndefined();
    expect(edgeFacts(walk(wide)!.parentEdges)).toEqual([valueEdge]);
    expect(walk(wide)?.unchangedWriteGaps).toContainEqual(
      expect.objectContaining({ key: complete, code: 'concurrent-write', reason: 'window-incomplete' }),
    );
  });
});

describe('unchanged-write scope and capture evidence', () => {
  it.each(['full', 'summary'] as const)(
    'recognises a tracked empty stage from a verified %s capture interval',
    (mode) => {
      const { recording } = sample('full', 'full', 'no-write');
      expect(findUnchangedWrites(recording, complete, 2)).toEqual({ writes: [], gaps: [noBag] });
      const tracked = { ...recording, ...capture(recording, mode) };
      expect(findUnchangedWrites(tracked, complete, 2)).toEqual({ writes: [], gaps: [] });
      expect(walk(tracked)?.unchangedWriteGaps).toBeUndefined();
    },
  );

  it.each(['no witness', 'wrong run', 'outside interval', 'saved witness'])(
    'does not certify a tracked empty stage with %s',
    (reason) => {
      const { recording } = sample('full', 'full', 'no-write');
      const evidence = reason === 'outside interval' ? capture(recording, 'full', 2) : capture(recording, 'full');
      const captureWitness =
        reason === 'no witness'
          ? undefined
          : reason === 'wrong run'
          ? { ...evidence.captureWitness, runId: 'other' }
          : reason === 'saved witness'
          ? { ...evidence.captureWitness, source: 'saved' }
          : evidence.captureWitness;
      const input = { ...recording, ...evidence, captureWitness };
      expect(findUnchangedWrites(input, complete, 2)).toEqual({ writes: [], gaps: [noBag] });
    },
  );

  it.each([
    'stable id',
    'runtime id',
    'wrong log',
    'child scope',
    'child stage',
    'repeat phase',
    'exit phase',
  ] as const)('refuses an unproven %s join', (which) => {
    const { recording, stages } = sample();
    const [seed, audit, decide] = stages;
    const [seedCommit, auditCommit, decideCommit] = recording.commitLog;
    let input = recording;
    let reason = 'scope-mismatch';
    switch (which) {
      case 'stable id':
        input = { ...recording, executionTree: [seed, { ...audit, id: 'other' }, decide] };
        break;
      case 'runtime id':
        input = { ...recording, executionTree: [seed, { ...audit, runtimeStageId: 'audit#9' }, decide] };
        break;
      case 'wrong log':
        input = { ...recording, logAddress: { logRunId: 'other', drillPath: [] } };
        break;
      case 'child scope':
        input = { ...recording, logAddress: { ...address, drillPath: ['mount#1'] } };
        reason = 'child-namespace';
        break;
      case 'child stage':
        input = { ...recording, executionTree: [{ ...seed, branches: [[audit]] }, decide] };
        reason = 'child-namespace';
        break;
      case 'repeat phase':
      case 'exit phase': {
        const phase = which === 'repeat phase' ? 'repeat' : 'exit';
        input = {
          ...recording,
          commitLog: [seedCommit, auditCommit, { ...auditCommit, idx: 2, phase }, { ...decideCommit, idx: 3 }],
        };
        reason = 'repeated-stage';
        break;
      }
    }
    const result = findUnchangedWrites(input, complete);
    expect(result.writes).toEqual([]);
    expect(result.gaps).toContainEqual(expect.objectContaining({ reason }));
  });

  it('does not match another array into the causal walk even when its commit bytes match', () => {
    const { recording } = sample();
    const log = [...recording.commitLog];
    const keys = keysReadFromExecutionTree(recording.executionTree);
    const result = causalChain(log, reader, keys.lookup, { unchangedWrites: recording });
    expect(edgeFacts(result!.parentEdges)).toEqual([['data', complete, 'seed#0']]);
    expect(result?.unchangedWriteGaps).toContainEqual(
      expect.objectContaining({ key: complete, reason: 'scope-mismatch' }),
    );
  });

  it.each(['config.value', normaliseStateKey(['config', 'value'])])(
    'does not guess the canonical path for %j',
    (key) => {
      const { recording, stages } = sample();
      stages[1].stageWrites = { 'config.value': 1 };
      expect(findUnchangedWrites(recording, key, 2)).toEqual({
        writes: [],
        gaps: [expect.objectContaining({ code: 'invalid-data', reason: 'ambiguous-key' })],
      });
    },
  );

  it('keeps a redacted path unknown even with a write bag for that stage', () => {
    const { recording } = sample();
    const [seed, audit, decide] = recording.commitLog;
    const input = { ...recording, commitLog: [seed, { ...audit, redactedPaths: [complete] }, decide] };
    expect(findUnchangedWrites(input, complete, 2)).toEqual({
      writes: [],
      gaps: [expect.objectContaining({ code: 'redacted', reason: 'redacted', commitIdx: 1 })],
    });
  });

  it.each(['write bag', 'write value', 'capture note'])('does not invoke an accessor on the %s', (target) => {
    const { recording, stages } = sample();
    const get = vi.fn(() => {
      throw new Error('foreign evidence accessor');
    });
    let input = recording;
    if (target === 'write bag') Object.defineProperty(stages[1], 'stageWrites', { get });
    else if (target === 'write value') Object.defineProperty(stages[1].stageWrites!, complete, { get });
    else {
      delete stages[1].stageWrites;
      input = { ...recording, ...capture(recording, 'full') };
      Object.defineProperty(input.capture as object, 'channels', { get });
    }
    const result = findUnchangedWrites(input, complete, 2);
    expect(result.writes).toEqual([]);
    expect(result.gaps.length).toBeGreaterThan(0);
    expect(get).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('foreign evidence accessor');
  });

  it('refuses an accessor at the opt-in boundary without reading it', () => {
    const { recording } = sample();
    const get = vi.fn(() => recording);
    const options = Object.defineProperty({}, 'unchangedWrites', { get });
    const keys = keysReadFromExecutionTree(recording.executionTree);
    const result = causalChain(recording.commitLog as CommitBundle[], reader, keys.lookup, options);
    expect(edgeFacts(result!.parentEdges)).not.toContainEqual(['unchanged-write', complete, 'audit#1']);
    expect(result?.unchangedWriteGaps).toContainEqual(expect.objectContaining({ key: complete, reason: 'malformed' }));
    expect(get).not.toHaveBeenCalled();
  });

  it('reports an unverified undefined retained slot consistently across bare JSON', () => {
    const { recording, stages } = sample();
    stages[1].stageWrites = { complete: undefined };
    const live = findUnchangedWrites(recording, complete, 2);
    const saved = findUnchangedWrites(JSON.parse(JSON.stringify(recording)), complete, 2);
    expect(live).toEqual(saved);
    expect(live.writes).toEqual([]);
    expect(live.gaps).toContainEqual(expect.objectContaining({ reason: 'tracking-unverified' }));
  });
});
