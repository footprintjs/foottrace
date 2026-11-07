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
const context = () => ({ signal: new AbortController().signal });
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

function scopeFor(
  result: Pick<ReturnType<typeof computation>, 'log' | 'sources'>,
  attention: RecordScope['attention'] = {},
): RecordScope {
  return {
    address,
    commitLog: result.log,
    initialState: {},
    reads: { 'seed#0': [], 'reader#1': ['a'] },
    attention,
    controlDeps: {},
    complete: true,
    readSources: {
      record: result.sources,
      executions: [{ runtimeStageId: owner.runtimeStageId, stateAddress: [], attemptIds: [owner.attemptId] }],
    },
  };
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

  it('leaves both writes after both reads ambiguous even with distinguishable source occurrences', () => {
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
    const graph = createRecordGraph([scopeFor(result)]);
    const execution = graph.nodeId(address, { runtimeStageId: owner.runtimeStageId, commitIdx: 1 });
    const output = graph.nodeId(address, { runtimeStageId: owner.runtimeStageId, commitIdx: 1, key: 'out' });
    const observed = await explain(graph, execution, { includeBackward: true });
    const candidate = await explain(graph, output, { includeBackward: true });

    expect(observed.backward?.confidence).toBe('complete');
    expect(observed.backward?.edges).toContainEqual(expect.objectContaining({ attribution: 'recorded-read' }));
    expect(candidate.backward?.edges).toContainEqual(expect.objectContaining({ attribution: 'stage' }));
    expect(candidate.backward?.gaps.map((gap) => gap.code)).toContain('conservative');
    expect(candidate.rootCause).toBeUndefined();
    // This fixture contains no attention. Complete read adjacency alone does not
    // introduce a marked candidate or a root under the generic attention policy.
    expect(observed.rootCause).toBeUndefined();
  });

  it('shows the selected-output gap when a write separates two reads of the same committed key', async () => {
    const source = fixture();
    const frame = source.frame();
    const earlier = read(frame, 'a');
    frame.write(['x'], Number(earlier.value) + 1, 'set');
    const later = read(frame, 'a');
    frame.write(['y'], Number(later.value) + 1, 'set');
    frame.commit(stamp(owner.runtimeStageId));
    frame.release();
    const scope = scopeFor(
      { log: source.record.log.list(), sources: source.record.snapshot() },
      // This is a host-supplied selected-failure mark over a finite RecordScope.
      // It does not exercise or approve failed producer capture admission.
      { 'reader#1': [{ kind: 'error', reason: 'ERROR_RECORDED', evidence: ['failure:reader#1@1'] }] },
    );
    source.record.retire();
    const graph = createRecordGraph([scope], { maxCommits: 16, maxFields: 20000, maxEdges: 16, maxScopes: 1 });
    const x = graph.nodeId(address, { runtimeStageId: owner.runtimeStageId, commitIdx: 1, key: 'x' });
    const y = graph.nodeId(address, { runtimeStageId: owner.runtimeStageId, commitIdx: 1, key: 'y' });
    const execution = graph.nodeId(address, { runtimeStageId: owner.runtimeStageId, commitIdx: 1 });
    const options = { includeBackward: true, maxNodes: 16, maxDepth: 8, maxEdges: 32, maxCalls: 64, timeoutMs: 1000 };
    const readRefs = (edges: readonly { evidence: readonly string[] }[]) =>
      edges.map((edge) => edge.evidence.find((ref) => ref.startsWith('read:')));

    expect(earlier.occurrence?.source).toEqual({ kind: 'committed', commitIdx: 0 });
    expect(later.occurrence?.source).toEqual(earlier.occurrence?.source);
    expect(earlier.occurrence?.ordinal).toBe(1);
    expect(later.occurrence?.ordinal).toBe(2);
    // Direct public graph methods require GraphContext; explain creates its own
    // query context from options.signal. Neither API takes an occurrence selector.
    const xParents = await graph.parents(x, context());
    const yParents = await graph.parents(y, context());
    expect(readRefs(xParents.edges)).toEqual(['read:1', 'read:2']);
    expect(readRefs(yParents.edges)).toEqual(['read:1', 'read:2']);
    expect(xParents.edges.every((edge) => edge.attribution === 'stage')).toBe(true);
    expect(xParents.complete).toBe(false);
    const finding = await explain(graph, x, { ...options, signal: new AbortController().signal });
    expect(finding.attention).toEqual(scope.attention?.['reader#1']);
    expect(finding.rootCause).toBeUndefined();
    expect(finding.backward?.gaps.map((gap) => gap.code)).toContain('conservative');
    const observed = await explain(graph, execution, options);
    expect(observed.backward?.confidence).toBe('complete');
    expect(readRefs(observed.backward?.edges ?? [])).toEqual(['read:1', 'read:2']);
    expect(observed.backward?.edges.every((edge) => edge.attribution === 'recorded-read')).toBe(true);
    expect(observed.rootCause).toBe(execution);

    // Reopening detached plain evidence preserves today's output limitation.
    // This is RecordScope JSON, not a new saved-format or authentication claim.
    const reopened = createRecordGraph([JSON.parse(JSON.stringify(scope)) as RecordScope]);
    expect(await explain(reopened, x, options)).toEqual(finding);
  });

  it('keeps a later staged same-key source gap in the current earlier-output query', async () => {
    const source = fixture();
    const frame = source.frame();
    const earlier = read(frame, 'a');
    frame.write(['x'], Number(earlier.value) + 1, 'set');
    frame.write(['a'], 99, 'set');
    const later = read(frame, 'a');
    frame.write(['y'], Number(later.value) + 1, 'set');
    frame.commit(stamp(owner.runtimeStageId));
    frame.release();
    const graph = createRecordGraph([scopeFor({ log: source.record.log.list(), sources: source.record.snapshot() })]);
    source.record.retire();
    const x = graph.nodeId(address, { runtimeStageId: owner.runtimeStageId, commitIdx: 1, key: 'x' });
    const finding = await explain(graph, x, { includeBackward: true });

    expect(earlier.value).toBe(41);
    expect(later.value).toBe(99);
    expect(later.occurrence?.source.kind).toBe('staged');
    expect(finding.backward?.edges).toContainEqual(
      expect.objectContaining({ attribution: 'stage', evidence: ['commit:0', 'read:1', owner.attemptId] }),
    );
    expect(finding.backward?.gaps.map((gap) => gap.code)).toContain('unsupported');
    expect(finding.backward?.gaps.map((gap) => gap.code)).toContain('conservative');
    expect(finding.rootCause).toBeUndefined();
    // The future association may exclude read:2 from x. No current API records
    // that association, and resolving staged read:2 for y is a separate gate.
  });

  it('withholds a constant output root even when its ignored source carries attention', async () => {
    const scope = scopeFor(computation('constant', 41), {
      'seed#0': [{ kind: 'outlier', reason: 'OUTLIER_RECORDED', evidence: ['attention:seed'] }],
      'reader#1': [{ kind: 'error', reason: 'ERROR_RECORDED', evidence: ['failure:reader#1@1'] }],
    });
    const graph = createRecordGraph([scope]);
    const execution = graph.nodeId(address, { runtimeStageId: owner.runtimeStageId, commitIdx: 1 });
    const output = graph.nodeId(address, { runtimeStageId: owner.runtimeStageId, commitIdx: 1, key: 'out' });
    const seed = graph.nodeId(address, { runtimeStageId: 'seed#0', commitIdx: 0, key: 'a' });
    const candidate = await explain(graph, output, { includeBackward: true });
    const observed = await explain(graph, execution, { includeBackward: true });

    expect(candidate.rootCause).toBeUndefined();
    expect(candidate.alternatives).toEqual([seed]);
    expect(candidate.backward?.gaps.map((gap) => gap.code)).toContain('conservative');
    // Current generic localisation chooses earliest supported attention, including
    // outliers. This is observation ancestry, not a semantic cause of the error:
    // the computation deliberately ignored a and wrote a constant.
    expect(observed.rootCause).toBe(seed);
    expect(observed.backward?.confidence).toBe('complete');
  });

  it('reserves ordinal identity before a reentrant privacy callback completes the outer read', () => {
    // The public verdict must be pure/name-only. This deliberately impure
    // callback probes a robustness boundary; it is not supported usage.
    const source = fixture();
    const frame = source.frame();
    const completed: number[] = [];
    let privacyCalls = 0;
    const outer = frame.readWithSource([], 'a', owner, () => {
      privacyCalls++;
      const inner = read(frame, 'b');
      completed.push(inner.occurrence!.ordinal);
      frame.write(['x'], inner.value, 'set');
      // The outer read has reserved ordinal 1 but has not returned. Snapshot
      // ordinal ordering cannot supply a completion-aware prefix for this write.
      expect(source.record.snapshot().occurrences.map((row) => row.ordinal)).toEqual([2]);
      return 'visible';
    });
    completed.push(outer.occurrence!.ordinal);
    frame.noteRead([], 'a');
    frame.write(['y'], outer.value, 'set');
    frame.commit(stamp(owner.runtimeStageId));
    frame.release();

    expect(privacyCalls).toBe(1);
    expect(completed).toEqual([2, 1]);
    expect(source.record.snapshot().occurrences.map((row) => row.ordinal)).toEqual([1, 2]);
    const trace = source.record.log.list()[1].trace;
    expect(trace.find((row) => row.path === 'x')?.readKeys).toEqual(['b']);
    expect(trace.find((row) => row.path === 'y')?.readKeys).toEqual(['b', 'a']);
    source.record.retire();
  });

  it('preserves a thrown public privacy callback object without replaying it', () => {
    const source = fixture();
    const frame = source.frame();
    const failure = Object.assign(new Error('synthetic callback failure'), {
      code: 'SYNTHETIC',
      cause: new Error('cause'),
    });
    let calls = 0;
    let caught: unknown;
    try {
      frame.readWithSource([], 'a', owner, () => {
        calls++;
        throw failure;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(calls).toBe(1);
    expect(source.record.snapshot().occurrences).toEqual([]);
    expect(source.record.snapshot().status).toBe('failed');
    frame.discard();
    source.record.retire();
  });
});
