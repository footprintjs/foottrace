import { describe, expect, it } from 'vitest';
import { createReadSourceRecord, EventLog, RecordFrame, SharedMemory, type LocatedRead } from '../../../write.js';

const owner = { runtimeStageId: 'reader#0' };
const address = { logRunId: 'located-read', drillPath: [] };
const canonical = { commitValues: 'full', writeProvenance: 'reads-prefix', nestedReadTracking: true } as const;
function setup(initial: Record<string, unknown>, namespace: string[] = []) {
  const state = new SharedMemory(undefined, initial);
  const log = new EventLog(state.getState());
  return { state, log, frame: new RecordFrame(state, log, namespace) };
}
function sourceSetup(captured: boolean) {
  const state = new SharedMemory(undefined, { n: 7 });
  const record = captured ? createReadSourceRecord(state, address) : undefined;
  return { state, record, frame: new RecordFrame(state, record?.log) };
}
function omitted(result: LocatedRead) {
  expect(Object.hasOwn(result, 'location')).toBe(false);
  expect(Object.isFrozen(result)).toBe(true);
}
function nested(segments: readonly string[]): Record<string, unknown> {
  let value: unknown = 7;
  for (let index = segments.length - 1; index >= 0; index--) value = { [segments[index]!]: value };
  return value as Record<string, unknown>;
}
function readSegments(segments: string[], namespaceLength = 0) {
  const namespace = segments.slice(0, namespaceLength);
  const { frame } = setup(nested(segments), namespace);
  return frame.readWithLocation(segments.slice(namespaceLength, -1), segments.at(-1)!);
}

describe('a located read describes one native selection', () => {
  for (const key of ['a.b', 'a/b', 'a\u001fb', '', '0', '01']) {
    it(`keeps literal key ${JSON.stringify(key)} and literal parent segments`, () => {
      const parent = 'cfg.part/inner\u001f';
      const { frame } = setup({ [parent]: { [key]: 7 } });
      const result = frame.readWithLocation([parent], key);
      expect(result.value).toBe(7);
      expect(result.location).toEqual([parent, key]);
      expect(result.occurrence).toBeUndefined();
    });
  }

  it('returns a borrowed keyed container with only an owned frozen holder and location', () => {
    const path = ['cfg'];
    const { state, frame } = setup({ cfg: { box: { n: 1 } } });
    const borrowed = (state.getState().cfg as { box: object }).box;
    const result = frame.readWithLocation(path, 'box');
    expect(result.value).toBe(borrowed);
    expect(result.location).toEqual(['cfg', 'box']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.location)).toBe(true);
    expect(Object.hasOwn(result, 'occurrence')).toBe(true);
    expect(Object.isFrozen(borrowed)).toBe(false);
    expect(Object.isFrozen(state.getState())).toBe(false);
    expect(Object.isFrozen(path)).toBe(false);
    path[0] = 'changed';
    expect(result.location).toEqual(['cfg', 'box']);
  });

  it('names the winning namespace or root fallback rather than the requested namespace', () => {
    const { frame } = setup({ cfg: { fee: 5 }, runs: { item: { cfg: { amount: 30 } } } }, ['runs', 'item']);
    const local = frame.readWithLocation(['cfg'], 'amount');
    const fallback = frame.readWithLocation(['cfg'], 'fee');
    expect(local.value).toBe(30);
    expect(local.location).toEqual(['runs', 'item', 'cfg', 'amount']);
    expect(fallback.value).toBe(5);
    expect(fallback.location).toEqual(['cfg', 'fee']);
  });

  it('keeps the intentional first-touch value while owning each receipt independently', () => {
    const { state, frame } = setup({ n: 1 });
    const first = frame.readWithLocation([], 'n');
    state.setValue([], [], 'n', 2);
    const second = frame.readWithLocation([], 'n');
    expect(first.value).toBe(1);
    expect(second.value).toBe(1);
    expect(state.getState().n).toBe(2);
    expect(first.location).toEqual(['n']);
    expect(second.location).toEqual(['n']);
    expect(second).not.toBe(first);
    expect(second.location).not.toBe(first.location);
  });

  it('omits undefined metadata while retaining the existing local hard-write prefix', () => {
    const { frame, log } = setup({ cfg: { amount: 99 } }, ['runs', 'item']);
    frame.useEncoding(canonical);
    frame.write(frame.at([], 'cfg'), { amount: undefined }, 'set');
    const result = frame.readWithLocation(['cfg'], 'amount');
    expect(result.value).toBeUndefined();
    omitted(result);
    frame.write(frame.at([], 'result'), 'missing', 'set');
    frame.commit(() => ({ stage: 'Write', stageId: 'write', runtimeStageId: 'write#0' }));
    expect(log.list()[0].trace.at(-1)?.readKeys).toEqual(['runs\u001fitem\u001fcfg\u001famount']);
  });

  it('omits accessor location without replaying the getter or erasing its canonical prefix', () => {
    const { state, frame, log } = setup({}, ['runs', 'item']);
    frame.useEncoding(canonical);
    frame.read([], 'absent');
    let calls = 0;
    Object.defineProperty(state.getState(), 'late', {
      configurable: true,
      get() {
        calls++;
        return 7;
      },
    });
    const result = frame.readWithLocation([], 'late');
    expect(result.value).toBe(7);
    omitted(result);
    expect(calls).toBe(1);
    frame.write(frame.at([], 'result'), 7, 'set');
    frame.commit(() => ({ stage: 'Write', stageId: 'write', runtimeStageId: 'write#0' }));
    expect(log.list()[0].trace[0].readKeys).toEqual(['late']);
  });

  for (const captured of [false, true]) {
    it(`runs source privacy once and withholds nonvisible location, capture=${captured}`, () => {
      for (const verdict of ['visible', 'redacted'] as const) {
        const { frame } = sourceSetup(captured);
        let calls = 0;
        let supplied: unknown[] = [];
        const result = frame.readWithLocation([], 'n', owner, (...args: unknown[]) => {
          calls++;
          supplied = args;
          return verdict;
        });
        expect(result.value).toBe(7);
        expect(calls).toBe(1);
        expect(supplied).toEqual([]);
        if (verdict === 'visible') expect(result.location).toEqual(['n']);
        else omitted(result);
        if (!captured) expect(result.occurrence).toBeUndefined();
        else
          expect(result.occurrence?.source).toEqual(
            verdict === 'visible' ? { kind: 'base', base: 1 } : { kind: 'unavailable', reason: 'redacted' },
          );
      }
    });
  }

  it('does not begin a source transaction when the third argument is absent', () => {
    const { frame, record } = sourceSetup(true);
    const before = frame.readWithSource([], 'n', owner).occurrence!;
    const result = frame.readWithLocation([], 'n');
    expect(result.value).toBe(7);
    expect(result.location).toEqual(['n']);
    expect(result.occurrence).toBeUndefined();
    const after = frame.readWithSource([], 'n', owner).occurrence!;
    expect(after.ordinal).toBe(before.ordinal + 1);
    expect(record!.snapshot().occurrences).toHaveLength(2);
  });

  it('uses third-argument presence rather than falsy-owner truthiness', () => {
    for (const captured of [false, true]) {
      for (const invalidOwner of [undefined, null, false, 0, '', { runtimeStageId: 'invalid' }]) {
        const { frame, record } = sourceSetup(captured);
        let privacy = 0;
        const result = frame.readWithLocation([], 'n', invalidOwner as never, () => {
          privacy++;
          return 'visible';
        });
        expect(result.value).toBe(7);
        expect(result.occurrence).toBeUndefined();
        expect(privacy).toBe(1);
        if (record) expect(record.snapshot().status).toBe('failed');
      }
    }
  });

  it('propagates the original privacy error after one native read without a retry', () => {
    for (const captured of [false, true]) {
      const { state, frame } = sourceSetup(captured);
      const failure = new Error('original privacy failure');
      let reads = 0,
        calls = 0,
        caught: unknown;
      Object.defineProperty(state.getState(), 'n', {
        configurable: true,
        get() {
          reads++;
          return 7;
        },
      });
      try {
        frame.readWithLocation([], 'n', owner, () => {
          calls++;
          throw failure;
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
      expect(reads).toBe(1);
      expect(calls).toBe(1);
    }
  });

  it('omits keyless and missing reads rather than assigning a wildcard location', () => {
    const { frame } = setup({ box: { n: 7 } });
    const expected = frame.readTracked(['box']);
    const keyless = frame.readWithLocation(['box']);
    expect(keyless.value).toBe(expected);
    omitted(keyless);
    const missing = frame.readWithLocation([], 'missing');
    expect(missing.value).toBeUndefined();
    omitted(missing);
  });

  it('keeps native numeric accesses but omits unsupported numeric metadata segments', () => {
    const first = setup({ items: [{ n: 7 }] }).frame;
    const path = ['items', 0] as unknown as string[];
    const fromPath = first.readWithLocation(path, 'n');
    expect(fromPath.value).toBe(7);
    omitted(fromPath);
    const second = setup({ items: [7] }).frame;
    const fromKey = second.readWithLocation(['items'], 0 as never);
    expect(fromKey.value).toBe(7);
    omitted(fromKey);
  });

  it('counts the actual namespace in the 64-total-segment boundary', () => {
    const within = Array.from({ length: 64 }, (_, index) => `p${index}`);
    const admitted = readSegments(within, 1);
    expect(admitted.value).toBe(7);
    expect(admitted.location).toEqual(within);
    const overflow = readSegments([...within, 'extra'], 1);
    expect(overflow.value).toBe(7);
    omitted(overflow);
  });

  it('admits 1024 units per segment and omits the whole 1025-unit location', () => {
    const exact = 'k'.repeat(1024);
    expect(readSegments([exact]).location).toEqual([exact]);
    const overflow = readSegments([exact + 'x']);
    expect(overflow.value).toBe(7);
    omitted(overflow);
  });

  it('admits 4096 aggregate units and refuses 4097 without any per-segment overflow', () => {
    const exact = ['a', 'b', 'c', 'd'].map((part) => part.repeat(1024));
    expect(readSegments(exact).location).toEqual(exact);
    const overflow = readSegments([...exact, 'n']);
    expect(overflow.value).toBe(7);
    omitted(overflow);
  });

  it('bounds the winning root fallback instead of rejecting a long losing namespace', () => {
    const namespace = Array.from({ length: 65 }, (_, index) => `missing${index}`);
    const { frame } = setup({ n: 7 }, namespace);
    const result = frame.readWithLocation([], 'n');
    expect(result.value).toBe(7);
    expect(result.location).toEqual(['n']);
  });

  it('owns the actual selection before privacy can mutate caller path and namespace arrays', () => {
    const namespace = ['runs', 'item'];
    const path = ['cfg'];
    const { frame } = setup({ runs: { item: { cfg: { n: 7 } } } }, namespace);
    const result = frame.readWithLocation(path, 'n', owner, () => {
      namespace[1] = 'changed';
      path[0] = 'changed';
      return 'visible';
    });
    expect(result.value).toBe(7);
    expect(result.location).toEqual(['runs', 'item', 'cfg', 'n']);
    expect(Object.isFrozen(namespace)).toBe(false);
    expect(Object.isFrozen(path)).toBe(false);
  });

  it('keeps independent local receipts across a reentrant read', () => {
    const { frame } = setup({ outer: { n: 7 }, inner: { n: 9 } });
    let inner: LocatedRead | undefined;
    const outer = frame.readWithLocation(['outer'], 'n', owner, () => {
      inner = frame.readWithLocation(['inner'], 'n');
      return 'visible';
    });
    expect(outer.value).toBe(7);
    expect(outer.location).toEqual(['outer', 'n']);
    expect(inner?.value).toBe(9);
    expect(inner?.location).toEqual(['inner', 'n']);
    expect(outer.location).not.toBe(inner?.location);
  });

  it('does not reconstruct a location after a field getter mutates the original address inputs', () => {
    const namespace = ['runs', 'item'];
    const path = ['box'];
    const { state, frame } = setup({ runs: { item: { box: {} } } }, namespace);
    const raw = state.getState() as { runs: { item: { box: Record<string, unknown> } } };
    let calls = 0;
    Object.defineProperty(raw.runs.item.box, 'n', {
      get() {
        calls++;
        namespace[1] = 'changed';
        path[0] = 'changed';
        return 7;
      },
    });
    const result = frame.readWithLocation(path, 'n');
    expect(result.value).toBe(7);
    expect(calls).toBe(1);
    omitted(result);
  });
});
