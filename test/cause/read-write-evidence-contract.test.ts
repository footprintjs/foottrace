/**
 * Executable counterexamples for docs/design/read-write-evidence.md.
 * These witness the current public record contract; they do not implement a
 * new relation or assert that an observed read was used by an expression.
 */
import { describe, expect, it } from 'vitest';

import { createRecordGraph, explain } from '../../src/cause.js';
import type { RecordScope } from '../../src/cause.js';
import { createReadSourceRecord, RecordFrame, SharedMemory } from '../../src/write.js';
import type { ReadSourceOwner } from '../../src/write.js';

const address = { logRunId: 'read-write-witness', drillPath: [] };
const owner = { runtimeStageId: 'reader#1', attemptId: 'reader#1@1' };
const stamp = (runtimeStageId: string) => () => ({
  stage: runtimeStageId.split('#')[0],
  stageId: runtimeStageId.split('#')[0],
  runtimeStageId,
});

function fixture(input = 41) {
  const state = new SharedMemory(undefined, {});
  const record = createReadSourceRecord(state, address);
  const frame = () => {
    const next = new RecordFrame(state, record.log);
    next.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix' });
    return next;
  };
  const seed = frame();
  seed.write(['a'], input, 'set');
  seed.write(['b'], 7, 'set');
  seed.commit(stamp('seed#0'));
  seed.release();
  return { state, record, frame };
}

function read(frame: RecordFrame, key: string, execution: ReadSourceOwner = owner) {
  const observed = frame.readWithSource([], key, execution);
  frame.noteRead([], key);
  return observed;
}

function computation(kind: 'derived' | 'constant', input: number) {
  const source = fixture(input);
  const frame = source.frame();
  const value = read(frame, 'a').value;
  frame.write(['out'], kind === 'derived' ? Number(value) + 1 : 42, 'set');
  frame.commit(stamp(owner.runtimeStageId));
  frame.release();
  const result = {
    log: source.record.log.list(),
    sources: source.record.snapshot(),
    value: source.state.getState().out,
  };
  source.record.retire();
  return result;
}

describe('read/write evidence contract — existing facts and counterexamples', () => {
  it('cannot distinguish expression use from an ignored read using the same native record', () => {
    const derived = computation('derived', 41);
    const constant = computation('constant', 41);

    expect(derived.log).toEqual(constant.log);
    expect(derived.sources).toEqual(constant.sources);
    expect(derived.value).toBe(42);
    expect(constant.value).toBe(42);

    // The computations differ even though the preceding single-run observations
    // were identical. This is a counterexample, not a request to relabel a prefix.
    expect(computation('derived', 42).value).toBe(43);
    expect(computation('constant', 42).value).toBe(42);
  });

  it('retains unrelated earlier reads in a later write prefix', () => {
    const source = fixture();
    const frame = source.frame();
    frame.write(['x'], Number(read(frame, 'a').value) + 1, 'set');
    frame.write(['y'], Number(read(frame, 'b').value) + 1, 'set');
    frame.commit(stamp(owner.runtimeStageId));
    frame.release();

    const trace = source.record.log.list()[1].trace;
    expect(trace.find((row) => row.path === 'x')?.readKeys).toEqual(['a']);
    expect(trace.find((row) => row.path === 'y')?.readKeys).toEqual(['a', 'b']);
    expect(source.state.getState().y).toBe(8);
    source.record.retire();
  });

  it('distinguishes two source occurrences although both outputs have the same key prefix', () => {
    const source = fixture();
    const frame = source.frame();
    const earlier = read(frame, 'a');
    frame.write(['a'], 99, 'set');
    const later = read(frame, 'a');
    frame.write(['first'], earlier.value, 'set');
    frame.write(['second'], later.value, 'set');
    frame.commit(stamp(owner.runtimeStageId));
    frame.release();

    const trace = source.record.log.list()[1].trace;
    expect(earlier.occurrence?.source).toEqual({ kind: 'committed', commitIdx: 0 });
    expect(later.occurrence?.source.kind).toBe('staged');
    expect(earlier.occurrence?.ordinal).not.toBe(later.occurrence?.ordinal);
    expect(trace.find((row) => row.path === 'first')?.readKeys).toEqual(['a']);
    expect(trace.find((row) => row.path === 'second')?.readKeys).toEqual(['a']);
    expect(source.state.getState()).toMatchObject({ first: 41, second: 99 });
    source.record.retire();
  });

  it('does not add a later read to an earlier write prefix', () => {
    const source = fixture();
    const frame = source.frame();
    frame.write(['out'], 42, 'set');
    read(frame, 'a');
    frame.commit(stamp(owner.runtimeStageId));
    frame.release();

    expect(source.record.log.list()[1].trace.find((row) => row.path === 'out')?.readKeys).toEqual([]);
    expect(source.record.snapshot().occurrences).toHaveLength(1);
    source.record.retire();
  });

  it('does not transfer a discarded attempt prefix into its successor', () => {
    const source = fixture();
    const frame = source.frame();
    read(frame, 'a', owner);
    frame.write(['discarded'], 42, 'set');
    frame.discard();
    read(frame, 'b', { ...owner, attemptId: 'reader#1@2' });
    frame.write(['out'], 7, 'set');
    frame.commit(stamp(owner.runtimeStageId));
    frame.release();

    const bundle = source.record.log.list()[1];
    expect(bundle.trace.map((row) => row.path)).toEqual(['out']);
    expect(bundle.trace[0].readKeys).toEqual(['b']);
    expect(source.record.snapshot().occurrences).toEqual([
      expect.objectContaining({ key: 'a', attemptId: 'reader#1@1', disposition: 'discarded' }),
      expect.objectContaining({ key: 'b', attemptId: 'reader#1@2', disposition: 'released' }),
    ]);
    source.record.retire();
  });

  it('keeps prefixes local to interleaved frames instead of using a global last read', () => {
    const source = fixture();
    const left = source.frame();
    const right = source.frame();
    read(left, 'a', { runtimeStageId: 'left#1', attemptId: 'left#1@1' });
    read(right, 'b', { runtimeStageId: 'right#2', attemptId: 'right#2@1' });
    left.write(['left'], 41, 'set');
    right.write(['right'], 7, 'set');
    left.commit(stamp('left#1'));
    left.release();
    right.commit(stamp('right#2'));
    right.release();

    const log = source.record.log.list();
    expect(log[1].trace[0].readKeys).toEqual(['a']);
    expect(log[2].trace[0].readKeys).toEqual(['b']);
    expect(source.record.snapshot().occurrences.map((row) => [row.runtimeStageId, row.key])).toEqual([
      ['left#1', 'a'],
      ['right#2', 'b'],
    ]);
    source.record.retire();
  });

  it('can explain an execution read without promoting that read into output derivation', async () => {
    const result = computation('derived', 41);
    const scope: RecordScope = {
      address,
      commitLog: result.log,
      initialState: {},
      reads: { 'seed#0': [], 'reader#1': ['a'] },
      attention: {},
      controlDeps: {},
      complete: true,
      readSources: {
        record: result.sources,
        executions: [{ runtimeStageId: owner.runtimeStageId, stateAddress: [], attemptIds: [owner.attemptId] }],
      },
    };
    const graph = createRecordGraph([scope]);
    const execution = graph.nodeId(address, { runtimeStageId: owner.runtimeStageId, commitIdx: 1 });
    const output = graph.nodeId(address, { runtimeStageId: owner.runtimeStageId, commitIdx: 1, key: 'out' });
    const observed = await explain(graph, execution, { includeBackward: true });
    const candidate = await explain(graph, output, { includeBackward: true });

    expect(observed.backward?.confidence).toBe('complete');
    expect(observed.backward?.edges).toContainEqual(expect.objectContaining({ attribution: 'recorded-read' }));
    expect(candidate.backward?.edges).toContainEqual(expect.objectContaining({ attribution: 'stage' }));
    expect(candidate.backward?.gaps.map((gap) => gap.code)).toContain('conservative');
    expect(candidate.rootCause).toBeUndefined();
    // This healthy fixture contains no fault attention. Complete read adjacency
    // alone is not a reason to invent a fault or a root.
    expect(observed.rootCause).toBeUndefined();
  });
});
