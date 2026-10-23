import { describe, expect, it } from 'vitest';
import * as writer from '../../../../src/write';
import { EventLog, RecordFrame, SharedMemory } from '../../../../src/write';

const owner = { runtimeStageId: 'reader#0' };
const address = { logRunId: 'leg-1', drillPath: [] };
const open = (state: SharedMemory, options?: writer.ReadSourceRecordOptions) =>
  writer.createReadSourceRecord(state, address, options);

function setup(seed: Record<string, unknown> = {}, options?: writer.ReadSourceRecordOptions) {
  const state = new SharedMemory(undefined, seed);
  const record = open(state, options);
  const frame = new RecordFrame(state, record.log);
  return { state, record, frame };
}
function commit(frame: RecordFrame, id = 'writer') {
  frame.commit(() => ({ stage: id, stageId: id, runtimeStageId: id + '#0' }));
  frame.release();
}
function read(
  frame: RecordFrame,
  key: string,
  who: { runtimeStageId: string; attemptId?: string } = owner,
  privacy?: 'visible' | 'redacted',
) {
  const result = frame.readWithSource([], key, who, privacy);
  return { ...result, occurrence: result.occurrence! };
}
function generation(result: ReturnType<typeof read>): number {
  if (result.occurrence.source.kind !== 'staged') throw new Error('expected staged source');
  return result.occurrence.source.generation;
}

describe('native exact root read sources', () => {
  it('records repeated base reads as separate ordered occurrences without values', () => {
    const { record, frame } = setup({ count: 7 });
    expect(read(frame, 'count').value).toBe(7);
    expect(read(frame, 'count').value).toBe(7);
    const snapshot = record.snapshot();
    expect(snapshot.version).toBe(1);
    expect(snapshot.address).toEqual(address);
    expect(snapshot.occurrences.map((o) => o.ordinal)).toEqual([1, 2]);
    expect(snapshot.occurrences.map((o) => o.source.kind)).toEqual(['base', 'base']);
    expect(snapshot.occurrences[0].attemptStatus).toBe('unavailable');
    expect(snapshot.occurrences[0]).not.toHaveProperty('value');
  });

  it('keeps the origin pinned at first touch while a fresh frame sees the new commit', () => {
    const { state, record, frame } = setup({ count: 1 });
    expect(read(frame, 'count').occurrence.source.kind).toBe('base');
    const other = new RecordFrame(state, record.log);
    other.write(['count'], 2, 'set');
    commit(other);
    expect(read(frame, 'count')).toMatchObject({ value: 1, occurrence: { source: { kind: 'base' } } });
    const fresh = read(new RecordFrame(state, record.log), 'count');
    expect(fresh).toMatchObject({ value: 2, occurrence: { source: { kind: 'committed', commitIdx: 0 } } });
  });

  it('uses the live origin for a first-touch-missing key', () => {
    const { state, record, frame } = setup({ seed: 1 });
    read(frame, 'seed');
    const other = new RecordFrame(state, record.log);
    other.write(['later'], 9, 'set');
    commit(other);
    expect(read(frame, 'later')).toMatchObject({
      value: 9,
      occurrence: { source: { kind: 'committed', commitIdx: 0 } },
    });
  });

  it('distinguishes intermediate staging generations even when no net write survives', () => {
    const { frame, record } = setup({ count: 1 });
    frame.write(['count'], 2, 'set');
    const first = read(frame, 'count');
    frame.write(['count'], 3, 'set');
    const second = read(frame, 'count');
    frame.write(['count'], 1, 'set');
    const third = read(frame, 'count');
    expect([first.value, second.value, third.value]).toEqual([2, 3, 1]);
    expect(first.occurrence.source.kind).toBe('staged');
    expect(generation(second)).toBeGreaterThan(generation(first));
    expect(generation(third)).toBeGreaterThan(generation(second));
    commit(frame);
    expect(record.log.list()[0].trace).toEqual([]);
    expect(record.snapshot().occurrences.every((o) => o.source.kind === 'staged')).toBe(true);
  });

  it.each(['full', 'delta'] as const)(
    'reports the actual old live source for the separate delete bug in %s',
    (mode) => {
      const { frame } = setup({ count: 1 });
      frame.useEncoding({ commitValues: mode, writeProvenance: 'off' });
      frame.write(['count'], undefined, 'delete');
      // Existing FootPrint #124 defect, not a new promise: the runtime falls back to live state.
      expect(read(frame, 'count')).toMatchObject({ value: 1, occurrence: { source: { kind: 'base' } } });
    },
  );

  it('never attributes an unlogged direct write to a nearby recorded commit', () => {
    const { state, record, frame } = setup({ count: 1 });
    frame.write(['other'], 3, 'set');
    commit(frame);
    state.setValue([], [], 'count', 99);
    expect(read(new RecordFrame(state, record.log), 'count')).toMatchObject({
      value: 99,
      occurrence: { source: { kind: 'unavailable', reason: 'untracked-write' } },
    });
  });

  it('records the chosen physical address on the namespaced-to-root fallback', () => {
    const { state, record } = setup({ count: 4, runs: { branch: { count: undefined } } });
    const frame = new RecordFrame(state, record.log, ['runs', 'branch']);
    const result = read(frame, 'count');
    expect(result.value).toBe(4);
    expect(result.occurrence.stateAddress).toEqual([]);
    expect(result.occurrence.source.kind).toBe('base');
  });

  it.each(['dot.key', 'slash/key', '', '鍵🌿'])('keeps the literal root key %s whole', (key) => {
    const { frame } = setup({ [key]: 8 });
    expect(read(frame, key)).toMatchObject({ value: 8, occurrence: { key, source: { kind: 'base' } } });
  });

  it.each([{}, [], new Date(0), new Map([['a', 1]])])(
    'withholds borrowed or composite container precision',
    (value) => {
      const { frame } = setup({ item: value });
      expect(read(frame, 'item').occurrence.source).toEqual({ kind: 'unavailable', reason: 'composite-unsupported' });
    },
  );

  it('keeps nested reads unsupported instead of borrowing a root writer', () => {
    const { frame } = setup({ item: { value: 1 } });
    expect(frame.readWithSource(['item'], 'value', owner)).toMatchObject({
      value: 1,
      occurrence: { source: { kind: 'unavailable', reason: 'composite-unsupported' } },
    });
  });

  it.each([{}, { count: undefined }])('does not turn undefined into proof of absence', (seed) => {
    const { frame } = setup(seed);
    expect(read(frame, 'count')).toMatchObject({
      value: undefined,
      occurrence: {
        source: { kind: 'unavailable', reason: 'undefined-presence-unknown' },
      },
    });
  });

  it('uses one getter invocation and preserves the original getter exception', () => {
    const { state, frame } = setup();
    let calls = 0;
    Object.defineProperty(state.getState(), 'computed', {
      enumerable: true,
      get() {
        calls++;
        return 8;
      },
    });
    expect(read(frame, 'computed')).toMatchObject({
      value: 8,
      occurrence: {
        source: { kind: 'unavailable', reason: 'untracked-write' },
      },
    });
    expect(calls).toBe(1);
    const error = new Error('private getter error');
    Object.defineProperty(state.getState(), 'broken', {
      get() {
        throw error;
      },
    });
    expect(() => read(frame, 'broken')).toThrow(error);
  });

  it('does not promote a copied accessor result to an admitted base after the first write', () => {
    const state = new SharedMemory();
    let calls = 0;
    Object.defineProperty(state.getState(), 'computed', {
      enumerable: true,
      get() {
        return ++calls;
      },
    });
    const record = open(state);
    const frame = new RecordFrame(state, record.log);
    frame.write(['other'], 1, 'set');
    expect(read(frame, 'computed').occurrence.source).toEqual({ kind: 'unavailable', reason: 'untracked-write' });
  });

  it('does not index private nested field names while admitting root keys', () => {
    const { record, frame } = setup({ box: { PRIVATE_NESTED_FIELD: 'secret' } });
    read(frame, 'box', owner, 'redacted');
    const index = (record.log as any).readSourceCapture.index;
    expect(JSON.stringify([...index.entries.keys()])).not.toContain('PRIVATE_NESTED_FIELD');
  });

  it('admits a frame namespace without indexing unrelated nested business fields', () => {
    const { state, record } = setup(
      { runs: { branch: { count: 4 } }, business: { PRIVATE_NESTED_FIELD: 'secret' } },
      { stateAddresses: [['runs', 'branch']] },
    );
    const frame = new RecordFrame(state, record.log, ['runs', 'branch']);
    expect(read(frame, 'count')).toMatchObject({
      value: 4,
      occurrence: { stateAddress: ['runs', 'branch'], source: { kind: 'base' } },
    });
    expect(JSON.stringify([...(record.log as any).readSourceCapture.index.entries.keys()])).not.toContain(
      'PRIVATE_NESTED_FIELD',
    );
  });

  it('preserves discarded occurrence evidence and allocates a fresh frame incarnation', () => {
    const { frame, record } = setup({ count: 1 });
    frame.write(['count'], 2, 'set');
    const previous = read(frame, 'count', { runtimeStageId: 'reader#0', attemptId: 'reader#0@1' });
    const before = record.snapshot();
    frame.discard();
    const next = read(frame, 'count', { runtimeStageId: 'reader#0', attemptId: 'reader#0@2' });
    expect(next.value).toBe(1);
    expect(next.occurrence.frame).not.toBe(previous.occurrence.frame);
    expect(record.snapshot().occurrences[0].disposition).toBe('discarded');
    expect(before.occurrences[0].disposition).toBe('active');
    expect(Object.isFrozen(before.occurrences[0])).toBe(true);
  });

  it('releases the pinned source view with the native frame', () => {
    const { state, frame, record } = setup({ count: 1 });
    const old = read(frame, 'count');
    state.setValue([], [], 'count', 4);
    frame.release();
    expect(read(frame, 'count')).toMatchObject({
      value: 4,
      occurrence: {
        source: { kind: 'unavailable', reason: 'untracked-write' },
      },
    });
    expect(record.snapshot().occurrences[1].frame).not.toBe(old.occurrence.frame);
  });

  it('keeps redacted metadata value-free and never invokes a privacy callback', () => {
    const { frame, record } = setup({ token: 'TOP_SECRET_SENTINEL' });
    expect(read(frame, 'token', owner, 'redacted').occurrence.source).toEqual({
      kind: 'unavailable',
      reason: 'redacted',
    });
    expect(JSON.stringify(record.snapshot())).not.toContain('TOP_SECRET_SENTINEL');
    expect(JSON.stringify(record.snapshot())).not.toContain('fingerprint');
  });

  it('keeps an unrelated constant write out of the exact read-source channel', () => {
    const { frame, record } = setup({ count: 1 });
    read(frame, 'count');
    frame.write(['unrelated'], 42, 'set');
    commit(frame);
    expect(record.snapshot().occurrences).toHaveLength(1);
    expect(JSON.stringify(record.snapshot())).not.toContain('wasDerivedFrom');
    expect(record.log.list()[0].trace[0]).not.toHaveProperty('readSources');
  });
});

describe('read-source limits and inert admission', () => {
  it.each([0, -1, 1.5, Infinity, NaN])('refuses an invalid host limit at setup: %s', (maxOccurrences) => {
    expect(() => setup({}, { limits: { maxOccurrences } })).toThrow('read sources: invalid limits');
  });

  it('bounds retained occurrences and preserves a named omission', () => {
    const { frame, record } = setup({ count: 1 }, { limits: { maxOccurrences: 2 } });
    for (let i = 0; i < 20; i++) expect(read(frame, 'count').value).toBe(1);
    const snapshot = record.snapshot();
    expect(snapshot.occurrences).toHaveLength(2);
    expect(snapshot.status).toBe('partial');
    expect(snapshot.gaps).toContainEqual({ reason: 'budget-exhausted', count: 18, exact: true });
  });

  it('never reuses stale origins after its index is saturated', () => {
    const { frame, state, record } = setup({ count: 1 }, { limits: { maxOrigins: 2 } });
    read(frame, 'count');
    for (let i = 0; i < 8; i++) state.setValue([], [], 'count', i + 2);
    expect(read(new RecordFrame(state, record.log), 'count').occurrence.source).toEqual({
      kind: 'unavailable',
      reason: 'budget-exhausted',
    });
    expect(read(frame, 'count').occurrence.source.kind).toBe('base');
  });

  it('retires source scope when the underlying log is cleared', () => {
    const { frame, record } = setup({ count: 1 });
    read(frame, 'count');
    record.log.clear();
    expect(read(frame, 'count').occurrence.source.kind).toBe('unavailable');
    expect(record.snapshot().status).toBe('retired');
  });

  it('roundtrips its value-free frozen schema and refuses stored accessors without invoking them', () => {
    const { frame, record } = setup({ count: 1 });
    read(frame, 'count');
    const decode = writer.decodeReadSourceSnapshot;
    expect(decode(JSON.parse(JSON.stringify(record.snapshot())))).toEqual(record.snapshot());
    let called = 0;
    const bad = {
      get version() {
        called++;
        return 1;
      },
    };
    expect(decode(bad)).toBeUndefined();
    expect(called).toBe(0);
    expect(decode({ ...record.snapshot(), occurrences: [{ value: 'private' }] })).toBeUndefined();
  });

  it('does not instrument ordinary reads or change default-off record bytes', () => {
    const state = new SharedMemory(undefined, { count: 1 });
    const log = new EventLog(state.getState());
    const frame = new RecordFrame(state, log);
    expect(frame.read([], 'count')).toBe(1);
    frame.write(['count'], 2, 'set');
    commit(frame);
    expect(JSON.stringify(log.list())).toBe(
      '[{"overwrite":{"count":2},"updates":{},"redactedPaths":[],"trace":[{"path":"count","verb":"set"}],"stage":"writer","stageId":"writer","runtimeStageId":"writer#0","idx":0}]',
    );
    expect(Object.keys(frame).some((key) => key.toLowerCase().includes('source'))).toBe(false);
  });
});
