import fc from 'fast-check';
import { stateAt } from '../../../../src/index';
import { captureFor } from '../../../../src/lib/read-sources/bindings';
import { READ_SOURCE_DEFAULTS } from '../../../../src/lib/read-sources/admission';
import { READ_SOURCE_V1_CEILINGS } from '../../../../src/lib/read-sources/format';
import { describe, expect, it } from 'vitest';
import { createReadSourceRecord, decodeReadSourceSnapshot, RecordFrame, SharedMemory } from '../../../../src/write';

const address = { logRunId: 'run', drillPath: [] };
const owner = { runtimeStageId: 'read#1' };
const stamp = () => ({ stage: 'Write', stageId: 'write', runtimeStageId: 'write#1' });

describe('reviewed native source boundaries', () => {
  it('does not expose capture selectors or binders on the public heap/log/frame', () => {
    const state = new SharedMemory(undefined, { n: 1 });
    const record = createReadSourceRecord(state, address);
    const frame = new RecordFrame(state, record.log);
    for (const target of [state, record.log, frame])
      for (const name of [
        'readSourceCapture',
        'attachReadSources',
        'nextReadSourceSegment',
        'registerReadSourceAddress',
        'sourceFrame',
      ])
        expect(name in target, name).toBe(false);
    expect(frame.readWithSource([], 'n', owner).occurrence?.source.kind).toBe('base');
    expect(decodeReadSourceSnapshot(record.snapshot())).toEqual(record.snapshot());
  });

  it('ignores forged public capture properties instead of trusting their labels', () => {
    const state = new SharedMemory(undefined, { n: 1 });
    const record = createReadSourceRecord(state, address);
    Object.defineProperty(state, 'readSourceCapture', {
      value: { select: () => ({ kind: 'committed', commitIdx: 999 }) },
    });
    expect(new RecordFrame(state, record.log).readWithSource([], 'n', owner).occurrence?.source).toEqual({
      kind: 'base',
      base: 1,
    });
  });

  it('reclaims ended frame, staging and origin capacity across 5000 committed writes', () => {
    const state = new SharedMemory(undefined, { n: 0 });
    const record = createReadSourceRecord(state, address, { limits: { maxOrigins: 16, maxStaging: 2 } });
    for (let n = 1; n <= 5000; n++) {
      const frame = new RecordFrame(state, record.log);
      frame.write(['n'], n, 'set');
      frame.commit(stamp);
      frame.release();
    }
    const read = new RecordFrame(state, record.log).readWithSource([], 'n', owner);
    expect(read).toMatchObject({ value: 5000, occurrence: { source: { kind: 'committed', commitIdx: 4999 } } });
    expect(record.snapshot().status).toBe('captured');
  });

  it('keeps an active reader pinned while sibling writes advance, then reclaims after release', () => {
    const state = new SharedMemory(undefined, { n: 0 });
    const record = createReadSourceRecord(state, address, { limits: { maxOrigins: 32 } });
    const reader = new RecordFrame(state, record.log);
    reader.readWithSource([], 'n', owner);
    for (let n = 1; n <= 5; n++) {
      const writer = new RecordFrame(state, record.log);
      writer.write(['n'], n, 'set');
      writer.commit(stamp);
      writer.release();
    }
    expect(reader.readWithSource([], 'n', owner)).toMatchObject({ value: 0, occurrence: { source: { kind: 'base' } } });
    reader.release();
    for (let n = 6; n <= 5000; n++) {
      const writer = new RecordFrame(state, record.log);
      writer.write(['n'], n, 'set');
      writer.commit(stamp);
      writer.release();
    }
    expect(new RecordFrame(state, record.log).readWithSource([], 'n', owner).occurrence?.source).toEqual({
      kind: 'committed',
      commitIdx: 4999,
    });
  });

  it('chooses privacy once after the actual read, with the value source pinned before callback writes', () => {
    const order: string[] = [];
    const state = new SharedMemory(undefined, { n: 1 });
    const record = createReadSourceRecord(state, address);
    const frame = new RecordFrame(state, record.log);
    const result = frame.readWithSource([], 'n', owner, (() => {
      order.push('privacy');
      const writer = new RecordFrame(state, record.log);
      writer.write(['n'], 2, 'set');
      writer.commit(stamp);
      writer.release();
      return 'visible';
    }) as any);
    expect(order).toEqual(['privacy']);
    expect(result).toMatchObject({ value: 1, occurrence: { source: { kind: 'base', base: 1 } } });
  });

  it('propagates a post-read privacy exception unchanged and never retries the native getter', () => {
    const state = new SharedMemory();
    let reads = 0;
    const original = new Error('private');
    const record = createReadSourceRecord(state, address);
    Object.defineProperty(state.getState(), 'n', {
      get() {
        reads++;
        return 1;
      },
    });
    const frame = new RecordFrame(state, record.log);
    expect(() =>
      frame.readWithSource([], 'n', owner, (() => {
        throw original;
      }) as any),
    ).toThrow(original);
    expect(reads).toBe(1);
    expect(JSON.stringify(record.snapshot())).not.toContain('private');
    expect(record.snapshot()).toMatchObject({ status: 'failed', occurrences: [] });
    expect(record.snapshot().gaps).toContainEqual({ reason: 'capture-failed', count: 1, exact: false });
  });

  it('calls post-read privacy even on an ordinary unbound frame', () => {
    const frame = new RecordFrame(new SharedMemory(undefined, { n: 1 }));
    let calls = 0;
    expect(
      frame.readWithSource([], 'n', owner, (() => {
        calls++;
        return 'visible';
      }) as any).value,
    ).toBe(1);
    expect(calls).toBe(1);
  });
  it('does not let an aggregate ancestor marker shadow an untouched sibling namespace', () => {
    const state = new SharedMemory(undefined, { runs: { b: { count: 2 }, c: { count: 3 } } });
    const record = createReadSourceRecord(state, address, {
      stateAddresses: [
        ['runs', 'b'],
        ['runs', 'c'],
      ],
    });
    const writer = new RecordFrame(state, record.log, ['runs', 'c']);
    writer.write(['count'], 4, 'set');
    writer.commit(stamp);
    writer.release();
    const result = new RecordFrame(state, record.log, ['runs', 'b']).readWithSource([], 'count', owner);
    expect(result).toMatchObject({ value: 2, occurrence: { source: { kind: 'base', base: 1 } } });
  });

  it('does not revive old descendant precision after an entire namespace is replaced', () => {
    const state = new SharedMemory(undefined, { runs: { b: { count: 2 }, c: { count: 3 } } });
    const record = createReadSourceRecord(state, address, {
      stateAddresses: [
        ['runs', 'b'],
        ['runs', 'c'],
      ],
    });
    const writer = new RecordFrame(state, record.log);
    writer.write(['runs', 'c'], { count: 99 }, 'set');
    writer.commit(stamp);
    writer.release();
    const result = new RecordFrame(state, record.log, ['runs', 'c']).readWithSource([], 'count', owner);
    expect(result).toMatchObject({ value: 99, occurrence: { source: { kind: 'unavailable' } } });
  });

  it('preserves an older replacement barrier beneath later aggregate updates and compaction', () => {
    const state = new SharedMemory(undefined, { runs: { branch: { n: 1, m: 0 } } });
    const record = createReadSourceRecord(state, address, {
      stateAddresses: [['runs'], ['runs', 'branch']],
      limits: { maxOrigins: 32 },
    });
    state.setValue(['runs'], [], 'branch', { n: 2, m: 0 });
    for (let m = 1; m <= 100; m++) {
      const writer = new RecordFrame(state, record.log, ['runs', 'branch']);
      writer.write(['m'], m, 'set');
      writer.commit(stamp);
      writer.release();
    }
    const result = new RecordFrame(state, record.log, ['runs', 'branch']).readWithSource([], 'n', owner);
    expect(result).toMatchObject({
      value: 2,
      occurrence: { source: { kind: 'unavailable', reason: 'untracked-write' } },
    });
  });

  it('remembers an attempt discarded while its first read verdict was pending', () => {
    const state = new SharedMemory(undefined, { n: 1 });
    const record = createReadSourceRecord(state, address);
    const frame = new RecordFrame(state, record.log);
    const attempt = { runtimeStageId: 'reader#0', attemptId: 'reader#0@1' };
    frame.readWithSource([], 'n', attempt, () => {
      frame.discard();
      return 'visible';
    });
    expect(frame.readWithSource([], 'n', attempt)).toMatchObject({
      occurrence: { disposition: 'discarded', source: { kind: 'unavailable', reason: 'scope-retired' } },
    });
  });

  it('does not retain abandoned owner IDs for rows refused by the byte budget', () => {
    const state = new SharedMemory(undefined, { n: 1 });
    const record = createReadSourceRecord(state, address, { limits: { maxBytes: 2048 } });
    const frame = new RecordFrame(state, record.log);
    for (let count = 0; count < 200; count++) {
      const runtimeStageId = `reader${count}#0`;
      frame.readWithSource([], 'n', { runtimeStageId, attemptId: `${runtimeStageId}@1` }, () => {
        frame.discard();
        return 'visible';
      });
    }
    const book = captureFor(state)! as any;
    expect(book.abandoned.size).toBeLessThanOrEqual(record.snapshot().occurrences.length);
    expect(record.snapshot().gaps.some((gap) => gap.reason === 'budget-exhausted')).toBe(true);
  });

  it('quarantines attempt precision when a discarded pending read cannot fit', () => {
    const long = 'x'.repeat(900);
    const state = new SharedMemory(undefined, { [long]: 1, n: 1 });
    const record = createReadSourceRecord(state, address, { limits: { maxBytes: 2048 } });
    const frame = new RecordFrame(state, record.log);
    const attempt = { runtimeStageId: 'reader#0', attemptId: 'reader#0@1' };
    expect(
      frame.readWithSource([], long, attempt, () => {
        frame.discard();
        return 'visible';
      }).occurrence,
    ).toBeUndefined();
    expect(frame.readWithSource([], 'n', attempt).occurrence!.source).toEqual({
      kind: 'unavailable',
      reason: 'budget-exhausted',
    });
  });

  it('quarantines a discarded tagged read refused by pending-pin saturation', () => {
    const state = new SharedMemory(undefined, { n: 1 });
    const record = createReadSourceRecord(state, address, { limits: { maxOrigins: 1 } });
    const frame = new RecordFrame(state, record.log);
    const attempt = { runtimeStageId: 'reader#0', attemptId: 'reader#0@1' };
    frame.readWithSource([], 'n', { runtimeStageId: 'outer#0' }, () => {
      expect(
        frame.readWithSource([], 'n', attempt, () => {
          frame.discard();
          return 'visible';
        }).occurrence,
      ).toBeUndefined();
      return 'visible';
    });
    expect(frame.readWithSource([], 'n', attempt).occurrence!.source).toEqual({
      kind: 'unavailable',
      reason: 'budget-exhausted',
    });
  });

  it('quarantines a discarded successful read whose key metadata was refused before retain', () => {
    const state = new SharedMemory(undefined, { n: 1 });
    const record = createReadSourceRecord(state, address);
    const frame = new RecordFrame(state, record.log);
    const key = 'x'.repeat(1025);
    const attempt = { runtimeStageId: 'reader#0', attemptId: 'reader#0@1' };
    frame.write([key], 2, 'set');
    expect(
      frame.readWithSource([], key, attempt, () => {
        frame.discard();
        return 'visible';
      }),
    ).toEqual({ value: 2, occurrence: undefined });
    expect(frame.readWithSource([], 'n', attempt).occurrence!.source).toEqual({
      kind: 'unavailable',
      reason: 'budget-exhausted',
    });
  });

  it.each(['visible', 'redacted'] as const)('withholds a frame-refused read even when privacy is %s', (privacy) => {
    const state = new SharedMemory(undefined, { n: 1 });
    const record = createReadSourceRecord(state, address, { limits: { maxOrigins: 1 } });
    const held = new RecordFrame(state, record.log);
    held.readWithSource([], 'n', owner);
    const other = new RecordFrame(state, record.log);
    const attempt = { runtimeStageId: 'reader#0', attemptId: 'reader#0@1' };
    expect(
      other.readWithSource([], 'n', attempt, () => {
        other.discard();
        return privacy;
      }).occurrence,
    ).toBeUndefined();
    held.release();
    expect(other.readWithSource([], 'n', attempt).occurrence!.source).toEqual({
      kind: 'unavailable',
      reason: 'budget-exhausted',
    });
    expect(record.snapshot().status).toBe('partial');
  });

  it('keeps bounded live staging credits reusable without reusing generation IDs', () => {
    const state = new SharedMemory(undefined, { n: 0 });
    const record = createReadSourceRecord(state, address, { limits: { maxStaging: 1 } });
    const frame = new RecordFrame(state, record.log);
    frame.write(['n'], 1, 'set');
    const first = frame.readWithSource([], 'n', owner).occurrence!.source;
    frame.write(['n'], 2, 'set');
    const second = frame.readWithSource([], 'n', owner).occurrence!.source;
    expect(second).toMatchObject({ kind: 'staged', generation: 2 });
    expect(first).toMatchObject({ kind: 'staged', generation: 1 });
    frame.discard();
    frame.discard();
    frame.write(['n'], 3, 'set');
    expect(frame.readWithSource([], 'n', owner).occurrence!.source).toMatchObject({ kind: 'staged', generation: 3 });
  });

  it('admits stored wire-v1 limits above writer defaults and refuses above fixed ceilings', () => {
    const state = new SharedMemory(undefined, { n: 0 });
    const record = createReadSourceRecord(state, address, {
      limits: { maxOccurrences: 16000, maxBytes: 8 * 1024 * 1024 },
    });
    expect(record.snapshot().limits.maxOccurrences).toBeGreaterThan(READ_SOURCE_DEFAULTS.maxOccurrences);
    expect(decodeReadSourceSnapshot(JSON.parse(JSON.stringify(record.snapshot())))).toEqual(record.snapshot());
    expect(
      decodeReadSourceSnapshot({
        ...record.snapshot(),
        limits: { ...record.snapshot().limits, maxOccurrences: READ_SOURCE_V1_CEILINGS.maxOccurrences + 1 },
      }),
    ).toBeUndefined();
  });

  it('never lets an old retired log detach the new segment', () => {
    const state = new SharedMemory(undefined, { n: 0 });
    const old = createReadSourceRecord(state, address);
    old.retire();
    const fresh = createReadSourceRecord(state, { logRunId: 'new', drillPath: [] });
    old.retire();
    old.log.clear();
    expect(new RecordFrame(state, fresh.log).readWithSource([], 'n', owner).occurrence?.source).toEqual({
      kind: 'base',
      base: 2,
    });
  });

  it('keeps the selected owner and frame when a privacy callback releases and reanchors', () => {
    const state = new SharedMemory(undefined, { n: 1 });
    const record = createReadSourceRecord(state, address);
    const frame = new RecordFrame(state, record.log);
    const identity = { ...owner };
    const result = frame.readWithSource([], 'n', identity, () => {
      frame.discard();
      identity.runtimeStageId = 'other#1';
      frame.write(['n'], 9, 'set');
      expect(record.snapshot().status).toBe('partial');
      return 'visible';
    });
    expect(result).toMatchObject({
      value: 1,
      occurrence: {
        runtimeStageId: owner.runtimeStageId,
        frame: 1,
        disposition: 'discarded',
        source: { kind: 'base' },
      },
    });
  });

  it('checks every exact label against an independent recorded-state oracle', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ op: fc.integer({ min: 0, max: 4 }), value: fc.integer({ min: -1000, max: 1000 }) }), {
          minLength: 10,
          maxLength: 70,
        }),
        (operations) => {
          const state = new SharedMemory(undefined, { n: 0, x: 1 });
          const record = createReadSourceRecord(state, address);
          const pinned = new RecordFrame(state, record.log);
          const check = (frame: RecordFrame) => {
            const result = frame.readWithSource([], 'n', owner);
            const row = result.occurrence!;
            if (row.source.kind === 'base' || row.source.kind === 'committed') {
              const snapshot =
                row.source.kind === 'base'
                  ? record.log.getInitialState()
                  : stateAt(
                      { initialState: record.log.getInitialState(), commitLog: record.log.list() },
                      row.source.commitIdx,
                    ).state;
              let value: any = snapshot;
              for (const part of [...row.stateAddress, row.key]) value = value?.[part];
              expect(result.value).toEqual(value);
            }
          };
          check(pinned);
          for (const operation of operations) {
            if (operation.op === 0) state.updateValue([], [], 'n', operation.value);
            else if (operation.op === 1) state.setValue([], [], 'n', operation.value);
            else if (operation.op === 2) {
              Object.defineProperty(state.getState(), 'n', {
                configurable: true,
                enumerable: true,
                get: () => operation.value,
              });
              check(new RecordFrame(state, record.log));
              delete state.getState().n;
              state.setValue([], [], 'n', operation.value);
            } else {
              const writer = new RecordFrame(state, record.log);
              writer.write(['n'], operation.value, 'set');
              writer.commit(stamp);
              writer.release();
            }
            check(pinned);
            const fresh = new RecordFrame(state, record.log);
            check(fresh);
            fresh.release();
            if (operation.op === 4) pinned.release();
          }
          expect(captureFor(state)!.index.size).toBeLessThanOrEqual(record.snapshot().limits.maxOrigins);
        },
      ),
      { seed: 23125, numRuns: 180 },
    );
  });
});
