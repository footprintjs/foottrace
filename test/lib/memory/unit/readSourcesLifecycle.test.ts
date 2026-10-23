import { describe, expect, it, vi } from 'vitest';
import {
  createReadSourceRecord,
  decodeReadSourceSnapshot,
  EventLog,
  memorySink,
  RecordFrame,
  SharedMemory,
  type RecordSink,
} from '../../../../src/write';
import * as origins from '../../../../src/lib/read-sources/originIndex';
import { recordCommit } from '../../../../src/lib/memory/recordCommit';
import { DELIM } from '../../../../src/lib/memory/paths';

const address = { logRunId: 'leg', drillPath: [] };
const owner = { runtimeStageId: 'step#0' };
const stamp = () => ({ stage: 'step', stageId: 'step', runtimeStageId: 'step#0' });
const sink = (handlers: Partial<RecordSink>): RecordSink => Object.assign(memorySink(), handlers);

describe('read-source lifetime and native reentrancy', () => {
  it('does not call or allocate an origin book, resolve a promise or await for default-off reads', () => {
    const create = vi.spyOn(origins, 'createOriginIndex');
    const resolve = vi.spyOn(Promise, 'resolve');
    const then = vi.spyOn(Promise.prototype, 'then');
    try {
      const state = new SharedMemory(undefined, { count: 1 });
      const log = new EventLog(state.getState());
      const frame = new RecordFrame(state, log);
      for (let i = 0; i < 1000; i++) expect(frame.read([], 'count')).toBe(1);
      expect(create).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      expect(then).not.toHaveBeenCalled();
      expect(Object.hasOwn(state, 'sourceCapture')).toBe(false);
      expect(Object.hasOwn(log, 'readCapture')).toBe(false);
      expect(Object.hasOwn(frame, 'sourceFrame')).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('withholds an exact base if opening the sink changes the heap', () => {
    const state = new SharedMemory(undefined, { count: 1 });
    const record = createReadSourceRecord(state, address, {
      sink: sink({
        opened() {
          state.setValue([], [], 'count', 2);
        },
      }),
    });
    const result = new RecordFrame(state, record.log).readWithSource([], 'count', owner);
    expect(result.value).toBe(2);
    expect(result.occurrence?.source.kind).toBe('unavailable');
    expect(record.snapshot().status).toBe('failed');
  });

  it('does not claim an exact committed source during an unconfirmed sink callback', () => {
    const state = new SharedMemory(undefined, { count: 1 });
    let observed: unknown;
    const record = createReadSourceRecord(state, address, {
      sink: sink({
        commit() {
          observed = new RecordFrame(state, record.log).readWithSource([], 'count', owner);
        },
      }),
    });
    const frame = new RecordFrame(state, record.log);
    frame.write(['count'], 2, 'set');
    frame.commit(stamp);
    expect(observed).toMatchObject({
      value: 2,
      occurrence: { source: { kind: 'unavailable', reason: 'untracked-write' } },
    });
    expect(new RecordFrame(state, record.log).readWithSource([], 'count', owner)).toMatchObject({
      value: 2,
      occurrence: { source: { kind: 'committed', commitIdx: 0 } },
    });
  });

  it('never upgrades a newer unlogged sink write to the earlier committed row', () => {
    const state = new SharedMemory(undefined, { count: 1 });
    const record = createReadSourceRecord(state, address, {
      sink: sink({
        commit() {
          state.setValue([], [], 'count', 99);
        },
      }),
    });
    const frame = new RecordFrame(state, record.log);
    frame.write(['count'], 2, 'set');
    frame.commit(stamp);
    expect(new RecordFrame(state, record.log).readWithSource([], 'count', owner)).toMatchObject({
      value: 99,
      occurrence: { source: { kind: 'unavailable', reason: 'untracked-write' } },
    });
  });

  it('confirms the actual bundle index when a sink appends a second unrelated row', () => {
    const state = new SharedMemory(undefined, { count: 1 });
    let nested = false;
    const record = createReadSourceRecord(state, address, {
      sink: sink({
        commit() {
          if (nested) return;
          nested = true;
          record.log.record({ ...stamp(), overwrite: {}, updates: {}, trace: [], redactedPaths: [] });
        },
      }),
    });
    const frame = new RecordFrame(state, record.log);
    frame.write(['count'], 2, 'set');
    frame.commit(stamp);
    expect(record.log.length).toBe(2);
    expect(new RecordFrame(state, record.log).readWithSource([], 'count', owner).occurrence?.source).toEqual({
      kind: 'committed',
      commitIdx: 0,
    });
  });

  it('preserves the original commit error and leaves unrecorded writes unknown', () => {
    const state = new SharedMemory(undefined, { count: 1 });
    const record = createReadSourceRecord(state, address);
    const error = new Error('native commit error');
    vi.spyOn(record.log, 'record').mockImplementation(() => {
      throw error;
    });
    const frame = new RecordFrame(state, record.log);
    frame.write(['count'], 2, 'set');
    expect(() => frame.commit(stamp)).toThrow(error);
    expect(new RecordFrame(state, record.log).readWithSource([], 'count', owner)).toMatchObject({
      value: 2,
      occurrence: { source: { kind: 'unavailable', reason: 'untracked-write' } },
    });
  });

  it('never retrofits a frame that pinned its state before capture began', () => {
    const state = new SharedMemory(undefined, { count: 1 });
    const old = new RecordFrame(state);
    old.read([], 'count');
    const record = createReadSourceRecord(state, address);
    expect(old.readWithSource([], 'count', owner).occurrence).toBeUndefined();
    expect(new RecordFrame(state, record.log).readWithSource([], 'count', owner).occurrence?.source.kind).toBe('base');
  });

  it('retired and fresh segments never share a base ordinal or occurrence sequence', () => {
    const state = new SharedMemory(undefined, { count: 1 });
    const old = createReadSourceRecord(state, address);
    const oldFrame = new RecordFrame(state, old.log);
    oldFrame.readWithSource([], 'count', owner);
    expect(() => createReadSourceRecord(state, address)).toThrow('heap already bound');
    old.log.clear();
    const fresh = createReadSourceRecord(state, { logRunId: 'new-leg', drillPath: [] });
    const result = new RecordFrame(state, fresh.log).readWithSource([], 'count', owner);
    expect(result.occurrence?.ordinal).toBe(1);
    expect(fresh.snapshot().segment).toBeGreaterThan(old.snapshot().segment);
    expect(oldFrame.readWithSource([], 'count', owner).occurrence).toBeUndefined();
  });

  it('does not invent nested occurrences or expose a hidden nested field name', () => {
    const state = new SharedMemory(undefined, { box: { PRIVATE_FIELD: 7 } });
    const record = createReadSourceRecord(state, address);
    const frame = new RecordFrame(state, record.log);
    expect(frame.readWithSource(['box'], 'PRIVATE_FIELD', owner).value).toBe(7);
    expect(record.snapshot().occurrences).toHaveLength(1);
    expect(record.snapshot().occurrences[0].key).toBe('box');
    expect(JSON.stringify(record.snapshot())).not.toContain('PRIVATE_FIELD');
  });

  it('keeps a late abandoned attempt read unknown instead of assigning the new frame to it', () => {
    const state = new SharedMemory(undefined, { count: 1 });
    const record = createReadSourceRecord(state, address);
    const frame = new RecordFrame(state, record.log);
    const old = { ...owner, attemptId: 'step#0@1' };
    frame.readWithSource([], 'count', old);
    frame.discard();
    expect(frame.readWithSource([], 'count', old)).toMatchObject({
      value: 1,
      occurrence: { disposition: 'discarded', source: { kind: 'unavailable', reason: 'scope-retired' } },
    });
    expect(frame.readWithSource([], 'count', { ...owner, attemptId: 'step#0@2' }).occurrence?.source.kind).toBe('base');
  });
});

describe('read-source independent budgets and admission', () => {
  it('counts versions, not just distinct indexed keys', () => {
    const index = origins.createOriginIndex(3, 1);
    index.seed({ count: 1 });
    index.write(['count'], { kind: 'committed', commitIdx: 0 });
    index.write(['count'], { kind: 'committed', commitIdx: 1 });
    const pinned = index.clock;
    index.write(['count'], { kind: 'committed', commitIdx: 2 });
    expect(index.size).toBe(3);
    expect(index.resolve(['count'], pinned)).toEqual({ kind: 'committed', commitIdx: 1 });
    expect(index.resolve(['count'], index.clock)).toEqual({ kind: 'unavailable', reason: 'budget-exhausted' });
  });

  it('keeps final snapshots within byte limits after release/discard and multiple gap kinds', () => {
    const state = new SharedMemory(undefined, { a: 1, box: { x: 1 } });
    const record = createReadSourceRecord(state, address, { limits: { maxBytes: 2048 } });
    const frame = new RecordFrame(state, record.log);
    for (let i = 0; i < 100; i++) {
      frame.readWithSource(
        [],
        i % 3 === 0 ? 'a' : i % 3 === 1 ? 'box' : 'missing',
        owner,
        i % 4 === 0 ? 'redacted' : 'visible',
      );
    }
    frame.discard();
    const snapshot = record.snapshot();
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(2048);
    expect(snapshot.gaps.some((gap) => gap.reason === 'budget-exhausted')).toBe(true);
    expect(decodeReadSourceSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });

  it('withholds staged precision when its independent generation budget is exhausted', () => {
    const state = new SharedMemory(undefined, { count: 1 });
    const record = createReadSourceRecord(state, address, { limits: { maxStaging: 1 } });
    const frame = new RecordFrame(state, record.log);
    frame.write(['count'], 2, 'set');
    expect(frame.readWithSource([], 'count', owner).occurrence?.source.kind).toBe('staged');
    frame.write(['count'], 3, 'set');
    expect(frame.readWithSource([], 'count', owner)).toMatchObject({
      value: 3,
      occurrence: { source: { kind: 'unavailable', reason: 'budget-exhausted' } },
    });
  });

  it('scopes execution limits across attempts without making up an attempt zero', () => {
    const state = new SharedMemory(undefined, { count: 1 });
    const record = createReadSourceRecord(state, address, { limits: { maxPerExecution: 1 } });
    const frame = new RecordFrame(state, record.log);
    frame.readWithSource([], 'count', { ...owner, attemptId: 'step#0@1' });
    frame.discard();
    frame.readWithSource([], 'count', { ...owner, attemptId: 'step#0@2' });
    expect(record.snapshot().occurrences).toHaveLength(1);
    expect(record.snapshot().gaps).toContainEqual({ reason: 'budget-exhausted', count: 1, exact: true });
  });
});

describe('read-source callback and untrusted-input ordering', () => {
  it('reserves the outer occurrence before a getter starts a nested read', () => {
    const state = new SharedMemory(undefined, { inner: 1 });
    const record = createReadSourceRecord(state, address);
    const frame = new RecordFrame(state, record.log);
    let pendingStatus: unknown;
    Object.defineProperty(state.getState(), 'outer', {
      enumerable: true,
      get() {
        frame.readWithSource([], 'inner', owner);
        pendingStatus = record.snapshot().status;
        return 2;
      },
    });
    expect(frame.readWithSource([], 'outer', owner).value).toBe(2);
    expect(record.snapshot().occurrences.map((row) => row.key)).toEqual(['outer', 'inner']);
    expect(record.snapshot().occurrences.map((row) => row.ordinal)).toEqual([1, 2]);
    expect(pendingStatus).not.toBe('captured');
  });

  it('stops stored admission while an oversized address is being read, before later rows', () => {
    const state = new SharedMemory(undefined, { count: 1 });
    const record = createReadSourceRecord(state, address, { limits: { maxBytes: 2048 } });
    new RecordFrame(state, record.log).readWithSource([], 'count', owner);
    const wire = JSON.parse(JSON.stringify(record.snapshot()));
    let visited = 0;
    wire.occurrences = Array.from(
      { length: 10 },
      (_, index) =>
        new Proxy(
          {
            ...wire.occurrences[0],
            ordinal: index + 1,
            stateAddress: Array.from({ length: 64 }, () => 'x'.repeat(1000)),
          },
          {
            getOwnPropertyDescriptor(target, key) {
              if (key === 'ordinal') visited++;
              return Reflect.getOwnPropertyDescriptor(target, key);
            },
          },
        ),
    );
    expect(decodeReadSourceSnapshot(wire)).toBeUndefined();
    expect(visited).toBe(1);
  });

  it('fails closed for invalid privacy without changing the native read', () => {
    const state = new SharedMemory(undefined, { count: 1 });
    const record = createReadSourceRecord(state, address);
    expect(new RecordFrame(state, record.log).readWithSource([], 'count', owner, 'invalid' as never)).toMatchObject({
      value: 1,
      occurrence: { source: { kind: 'unavailable', reason: 'capture-failed' } },
    });
  });
});

it.each(['reader', 'reader#0junk', 'reader#01', '#0', 'reader#-1'])(
  'does not invent a canonical execution for %s',
  (runtimeStageId) => {
    const state = new SharedMemory(undefined, { count: 1 });
    const record = createReadSourceRecord(state, address);
    expect(new RecordFrame(state, record.log).readWithSource([], 'count', { runtimeStageId })).toEqual({
      value: 1,
      occurrence: undefined,
    });
    expect(record.snapshot().status).toBe('failed');
  },
);

it('retains no hidden nested names after staged and committed nested writes', () => {
  const state = new SharedMemory(undefined, { box: { PRIVATE_NESTED_KEY: 1 } });
  const record = createReadSourceRecord(state, address);
  const frame = new RecordFrame(state, record.log);
  frame.write(['box', 'PRIVATE_NESTED_KEY'], 2, 'set', { whole: true });
  frame.readWithSource(['box'], 'PRIVATE_NESTED_KEY', owner);
  frame.commit(stamp);
  const index = state.readSourceCapture!.index as unknown as { entries: Map<string, unknown> };
  expect([...index.entries.keys()].join()).not.toContain('PRIVATE_NESTED_KEY');
  expect(JSON.stringify(record.snapshot())).not.toContain('PRIVATE_NESTED_KEY');
});

it('never upgrades a copied namespaced getter result to base', () => {
  const state = new SharedMemory(undefined, { runs: { branch: {} } });
  let calls = 0;
  Object.defineProperty((state.getState().runs as any).branch, 'count', { enumerable: true, get: () => ++calls });
  const record = createReadSourceRecord(state, address);
  const frame = new RecordFrame(state, record.log, ['runs', 'branch']);
  frame.write(['runs', 'branch', 'other'], 1, 'set');
  expect(frame.readWithSource([], 'count', owner).value).toBe(2);
  expect(record.snapshot().occurrences[0].source.kind).toBe('unavailable');
});

it('keeps an ancestor redaction over a later staged scalar descendant', () => {
  const state = new SharedMemory(undefined, { runs: { branch: { count: 1 } } });
  const record = createReadSourceRecord(state, address);
  const frame = new RecordFrame(state, record.log, ['runs', 'branch']);
  frame.write(['runs', 'branch'], { count: 2 }, 'set', { whole: true });
  frame.write(['runs', 'branch', 'count'], 3, 'set');
  expect(frame.readWithSource([], 'count', owner)).toMatchObject({
    value: 3,
    occurrence: { source: { kind: 'unavailable', reason: 'redacted' } },
  });
});

it('withholds a committed scalar below a redacted ancestor', () => {
  const state = new SharedMemory(undefined, { runs: { branch: { count: 1 } } });
  const record = createReadSourceRecord(state, address);
  new RecordFrame(state, record.log, ['runs', 'branch']).read([], 'count');
  recordCommit(
    {
      overwrite: { runs: { branch: { count: 2 } } },
      updates: {},
      trace: [{ path: ['runs', 'branch', 'count'].join(DELIM), verb: 'set' }],
      redactedPaths: new Set(['runs']),
    },
    stamp(),
    { state, log: record.log },
  );
  expect(new RecordFrame(state, record.log, ['runs', 'branch']).readWithSource([], 'count', owner)).toMatchObject({
    value: 2,
    occurrence: { source: { kind: 'unavailable', reason: 'redacted' } },
  });
});

it('does not trust a late namespace base, but can precisely read its later native commit', () => {
  const state = new SharedMemory(undefined, { runs: { branch: { count: 1 } } });
  const record = createReadSourceRecord(state, address);
  const frame = new RecordFrame(state, record.log, ['runs', 'branch']);
  expect(frame.readWithSource([], 'count', owner).occurrence?.source.kind).toBe('unavailable');
  frame.write(['runs', 'branch', 'count'], 2, 'set');
  frame.commit(stamp);
  frame.release();
  expect(frame.readWithSource([], 'count', owner)).toMatchObject({
    value: 2,
    occurrence: { source: { kind: 'committed', commitIdx: 0 } },
  });
});

it('keeps an explicitly declared namespace accessor unknown before base cloning', () => {
  const state = new SharedMemory(undefined, { runs: { branch: {} } });
  let calls = 0;
  Object.defineProperty((state.getState().runs as any).branch, 'count', { enumerable: true, get: () => ++calls });
  const record = createReadSourceRecord(state, address, { stateAddresses: [['runs', 'branch']] });
  const frame = new RecordFrame(state, record.log, ['runs', 'branch']);
  frame.write(['runs', 'branch', 'other'], 1, 'set');
  expect(frame.readWithSource([], 'count', owner)).toMatchObject({
    value: 2,
    occurrence: { source: { kind: 'unavailable', reason: 'untracked-write' } },
  });
});

it('bounds declared namespace components before inspecting any native base', () => {
  const state = new SharedMemory(undefined, { count: 1 });
  expect(() =>
    createReadSourceRecord(state, address, { limits: { maxOrigins: 1 }, stateAddresses: [['a', 'b']] }),
  ).toThrow('read sources: invalid namespaces');
  expect(Object.hasOwn(state, 'sourceCapture')).toBe(false);
});

it.each([false, true])(
  'withholds an abandoned buffer lineage after constructor reentrancy/reanchor: %s',
  (reanchor) => {
    const state = new SharedMemory(undefined, { count: 1 });
    let frame: RecordFrame | undefined,
      fired = false;
    Object.defineProperty(state.getState(), 'trigger', {
      enumerable: true,
      get() {
        if (frame && !fired) {
          fired = true;
          if (reanchor) frame.release();
          frame.write(['count'], 2, 'set');
        }
        return 0;
      },
    });
    const record = createReadSourceRecord(state, address);
    frame = new RecordFrame(state, record.log);
    frame.write(['other'], 3, 'set');
    // Native behavior: the outer constructor replaces the reentrant inner buffer.
    expect(frame.readWithSource([], 'count', owner)).toMatchObject({
      value: 1,
      occurrence: { source: { kind: 'unavailable', reason: 'capture-failed' } },
    });
  },
);

it.each([false, true])('withholds partially applied merge sources in callbacks and after errors: %s', (throws) => {
  const state = new SharedMemory(undefined, { runs: { branch: { count: 1 } } });
  const record = createReadSourceRecord(state, address, { stateAddresses: [['runs', 'branch']] });
  const frame = new RecordFrame(state, record.log, ['runs', 'branch']);
  frame.write(['runs', 'branch', 'other'], 3, 'set');
  let calls = 0,
    during: unknown;
  const error = new Error('original native merge error');
  const input = Object.defineProperty({}, 'count', {
    enumerable: true,
    get() {
      if (++calls === 2) {
        during = frame.readWithSource([], 'count', owner);
        if (throws) throw error;
      }
      return 2;
    },
  });
  if (throws) expect(() => frame.write(['runs', 'branch'], input, 'merge')).toThrow(error);
  else frame.write(['runs', 'branch'], input, 'merge');
  expect(during).toMatchObject({ value: 2, occurrence: { source: { kind: 'unavailable', reason: 'capture-failed' } } });
  const after = frame.readWithSource([], 'count', owner);
  expect(after.value).toBe(2);
  expect(after.occurrence?.source.kind).toBe('unavailable');
  if (throws) expect(after.occurrence?.source).toEqual({ kind: 'unavailable', reason: 'capture-failed' });
});

it('does not borrow an inner committed origin when a reentrant heap fold replaces its generation', () => {
  const state = new SharedMemory(undefined, { count: 1 });
  const record = createReadSourceRecord(state, address);
  let fired = false;
  const input = Object.defineProperty({}, 'trigger', {
    enumerable: true,
    get() {
      if (!fired) {
        fired = true;
        const inner = new RecordFrame(state, record.log);
        inner.write(['count'], 2, 'set');
        inner.commit(stamp);
        inner.release();
      }
      return 0;
    },
  });
  recordCommit(
    { overwrite: { other: input }, updates: {}, redactedPaths: new Set(), trace: [{ path: 'other', verb: 'set' }] },
    stamp(),
    { state, log: record.log },
  );
  // Preserve native behavior: the outer fold replaces the inner generation.
  expect(new RecordFrame(state, record.log).readWithSource([], 'count', owner)).toMatchObject({
    value: 1,
    occurrence: { source: { kind: 'unavailable', reason: 'capture-failed' } },
  });
});
