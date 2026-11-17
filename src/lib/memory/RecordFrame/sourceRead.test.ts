import { describe, expect, it } from 'vitest';
import { createReadSourceRecord, EventLog, RecordFrame, SharedMemory } from '../../../write.js';

const CANONICAL = { commitValues: 'full', writeProvenance: 'reads-prefix', nestedReadTracking: true } as const;
const owner = { runtimeStageId: 'reader#0' };
const address = { logRunId: 'read-parity', drillPath: [] };
const kinds = ['tracked', 'source'] as const;
function fixture(initial: Record<string, unknown> = {}, namespace: string[] = []) {
  const state = new SharedMemory(undefined, initial);
  const log = new EventLog(state.getState());
  const frame = new RecordFrame(state, log, namespace);
  frame.useEncoding(CANONICAL);
  return { state, log, frame };
}
function read(kind: (typeof kinds)[number], frame: RecordFrame, path: string[], key: string): unknown {
  return kind === 'tracked' ? frame.readTracked(path, key) : frame.readWithSource(path, key, owner).value;
}
function commit(frame: RecordFrame) {
  frame.commit(() => ({ stage: 'Write', stageId: 'write', runtimeStageId: 'write#0' }));
  frame.release();
}
function sourceFixture(captured: boolean) {
  const state = new SharedMemory(undefined, { n: 1 });
  const record = captured ? createReadSourceRecord(state, address) : undefined;
  const frame = new RecordFrame(state, record?.log);
  return { state, record, frame };
}

describe('existing read doors retain their native behavior', () => {
  for (const kind of kinds) {
    it(`${kind} returns the original borrowed container without freezing it`, () => {
      const { state, frame } = fixture({ box: { n: 1 } });
      const borrowed = state.getState().box;
      expect(read(kind, frame, [], 'box')).toBe(borrowed);
      expect(Object.isFrozen(borrowed)).toBe(false);
      expect(Object.isFrozen(state.getState())).toBe(false);
    });

    it(`${kind} retains the winning local address and actual root fallback in canonical prefixes`, () => {
      const { frame, log } = fixture({ cfg: { fee: 5 }, runs: { item: { cfg: { amount: 30 } } } }, ['runs', 'item']);
      expect(read(kind, frame, ['cfg'], 'amount')).toBe(30);
      expect(read(kind, frame, ['cfg'], 'fee')).toBe(5);
      frame.write(frame.at([], 'total'), 35, 'set');
      commit(frame);
      expect(log.list()[0].trace[0].readKeys).toEqual(['runs\u001fitem\u001fcfg\u001famount', 'cfg\u001ffee']);
    });

    it(`${kind} preserves a getter's canonical prefix without another value read`, () => {
      const { state, frame, log } = fixture({}, ['runs', 'item']);
      frame.read([], 'absent');
      let calls = 0;
      Object.defineProperty(state.getState(), 'late', {
        configurable: true,
        get() {
          calls++;
          return 5;
        },
      });
      expect(read(kind, frame, [], 'late')).toBe(5);
      expect(calls).toBe(1);
      frame.write(frame.at([], 'total'), 5, 'set');
      commit(frame);
      expect(log.list()[0].trace[0].readKeys).toEqual(['late']);
    });

    it(`${kind} lets staged hard undefined mask the root fallback`, () => {
      const { frame, log } = fixture({ cfg: { amount: 99 } }, ['runs', 'item']);
      frame.write(frame.at([], 'cfg'), { amount: undefined }, 'set');
      expect(read(kind, frame, ['cfg'], 'amount')).toBeUndefined();
      frame.write(frame.at([], 'result'), 'missing', 'set');
      commit(frame);
      expect(log.list()[0].trace.at(-1)?.readKeys).toEqual(['runs\u001fitem\u001fcfg\u001famount']);
    });

    it(`${kind} preserves capture-off and its existing noncanonical notification behavior`, () => {
      const { frame, log } = fixture({ cfg: { n: 2 } });
      frame.useEncoding({ ...CANONICAL, writeProvenance: 'off' });
      expect(read(kind, frame, ['cfg'], 'n')).toBe(2);
      frame.write(['without'], 2, 'set');
      commit(frame);
      expect(log.list()[0].trace[0]).not.toHaveProperty('readKeys');
      frame.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix' });
      expect(read(kind, frame, ['cfg'], 'n')).toBe(2);
      frame.write(['legacy'], 2, 'set');
      commit(frame);
      // readWithSource historically leaves legacy noteRead to its caller.
      expect(log.list()[1].trace[0].readKeys).toEqual(kind === 'tracked' ? ['cfg.n'] : []);
    });

    it(`${kind} preserves an original getter failure and records no successful read`, () => {
      const { state, frame, log } = fixture();
      const failure = new Error('original read failure');
      let reads = 0,
        privacy = 0,
        caught: unknown;
      Object.defineProperty(state.getState(), 'bad', {
        get() {
          reads++;
          throw failure;
        },
      });
      try {
        if (kind === 'tracked') frame.readTracked([], 'bad');
        else
          frame.readWithSource([], 'bad', owner, () => {
            privacy++;
            return 'visible';
          });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
      expect(reads).toBe(1);
      expect(privacy).toBe(0);
      frame.write(['result'], 1, 'set');
      commit(frame);
      expect(log.list()[0].trace[0].readKeys).toEqual([]);
    });
  }
});

describe('existing readWithSource transaction ordering', () => {
  for (const captured of [false, true]) {
    it(`calls value-free privacy once after the native getter, capture=${captured}`, () => {
      const { state, frame } = sourceFixture(captured);
      const order: string[] = [];
      let privacyArguments: unknown[] = [];
      Object.defineProperty(state.getState(), 'n', {
        configurable: true,
        get() {
          order.push('read');
          return 7;
        },
      });
      const result = frame.readWithSource([], 'n', owner, (...args: unknown[]) => {
        privacyArguments = args;
        order.push('privacy');
        return 'visible';
      });
      expect(result.value).toBe(7);
      expect(order).toEqual(['read', 'privacy']);
      expect(privacyArguments).toEqual([]);
    });

    it(`preserves a privacy exception by identity after one read, capture=${captured}`, () => {
      const { state, frame, record } = sourceFixture(captured);
      const failure = new Error('original privacy failure');
      let reads = 0,
        privacy = 0,
        caught: unknown;
      Object.defineProperty(state.getState(), 'n', {
        configurable: true,
        get() {
          reads++;
          return 7;
        },
      });
      try {
        frame.readWithSource([], 'n', owner, () => {
          privacy++;
          throw failure;
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
      expect(reads).toBe(1);
      expect(privacy).toBe(1);
      if (record) {
        expect(record.snapshot()).toMatchObject({ status: 'failed', occurrences: [] });
        expect(JSON.stringify(record.snapshot())).not.toContain(failure.message);
      }
    });

    it(`does not turn a falsy or invalid owner into a value-only call, capture=${captured}`, () => {
      for (const invalidOwner of [undefined, null, false, 0, '', { runtimeStageId: 'invalid' }]) {
        const { frame, record } = sourceFixture(captured);
        let privacy = 0;
        const result = frame.readWithSource([], 'n', invalidOwner as never, () => {
          privacy++;
          return 'visible';
        });
        expect(result.value).toBe(1);
        expect(result.occurrence).toBeUndefined();
        expect(privacy).toBe(1);
        if (record) expect(record.snapshot().status).toBe('failed');
      }
    });
  }

  it('refuses an owner accessor without running it or skipping the value/privacy call', () => {
    const { frame, record } = sourceFixture(true);
    let ownerReads = 0,
      privacy = 0;
    const invalidOwner = Object.defineProperty({}, 'runtimeStageId', {
      get() {
        ownerReads++;
        return 'reader#0';
      },
    });
    const result = frame.readWithSource([], 'n', invalidOwner as never, () => {
      privacy++;
      return 'visible';
    });
    expect(result).toEqual({ value: 1, occurrence: undefined });
    expect(ownerReads).toBe(0);
    expect(privacy).toBe(1);
    expect(record!.snapshot().status).toBe('failed');
  });

  it('pins source and copied owner before privacy can mutate them and commit another value', () => {
    const { state, frame, record } = sourceFixture(true);
    const suppliedOwner = { runtimeStageId: 'reader#0', attemptId: 'reader#0@1' };
    let privacy = 0;
    const result = frame.readWithSource([], 'n', suppliedOwner, () => {
      privacy++;
      suppliedOwner.runtimeStageId = 'changed#1';
      suppliedOwner.attemptId = 'changed#1@2';
      const writer = new RecordFrame(state, record!.log);
      writer.write(['n'], 2, 'set');
      writer.commit(() => ({ stage: 'Other', stageId: 'other', runtimeStageId: 'other#1' }));
      writer.release();
      return 'visible';
    });
    expect(result).toMatchObject({
      value: 1,
      occurrence: {
        runtimeStageId: 'reader#0',
        attemptId: 'reader#0@1',
        source: { kind: 'base', base: 1 },
      },
    });
    expect(state.getState().n).toBe(2);
    expect(privacy).toBe(1);
  });
});
