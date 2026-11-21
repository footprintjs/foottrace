import { describe, expect, it, vi } from 'vitest';
import { readRunEvidence, readStoredRecord } from '../../index.js';
import {
  createReadSourceRecord,
  memorySink,
  RecordFrame,
  SharedMemory,
  type ReadSourceRecordOptions,
} from '../../write.js';
import { captureFor } from '../read-sources/bindings.js';

const address = { logRunId: 'leg-1', drillPath: [] };

function stamped() {
  return { stage: 'step', stageId: 'step', runtimeStageId: 'step#0', tags: [], about: {} };
}

function untrustedOptions(sink: ReturnType<typeof memorySink>, collects: unknown): ReadSourceRecordOptions {
  return { sink, collects } as ReadSourceRecordOptions;
}

describe('read-source record collection', () => {
  it('serves the same writer manifest, about, note sequence and final count to the public reader', () => {
    const state = new SharedMemory(undefined, { count: 1 });
    const sink = memorySink();
    const record = createReadSourceRecord(state, address, {
      sink,
      collects: { reads: 'keys' },
    });
    const frame = new RecordFrame(state, record.log);
    frame.readWithSource([], 'count', { runtimeStageId: 'step#0' });
    record.log.noteRun('run.stage', { id: 'step#0' });
    frame.write(['count'], 2, 'set');
    frame.commit(() => ({
      stage: 'step',
      stageId: 'step',
      runtimeStageId: 'step#0',
      tags: [],
      about: { reads: ['count'] },
    }));
    frame.release();
    record.log.noteRun('run.stop', { id: 'step#0', by: 'break' });
    record.log.close('ok');

    expect(record.log.keepsEvidence).toBe(true);
    expect(sink.entries[0]).toMatchObject({ kind: 'opened', collects: { v: 2, reads: 'keys' } });
    expect(sink.entries.flatMap((entry) => (entry.kind === 'note' ? [entry.data.seq] : []))).toEqual([0, 1]);
    expect(sink.entries.at(-1)).toMatchObject({ kind: 'closed', runNotes: 2 });
    const evidence = readRunEvidence(readStoredRecord(sink.entries), address.logRunId);
    expect(evidence.reads).toMatchObject({ status: 'collected', rows: [{ id: 'step#0', keys: ['count'] }] });
    expect(evidence.stops).toMatchObject({ status: 'collected', rows: [{ id: 'step#0', by: 'break' }] });
    expect(state.getState()).toEqual({ count: 2 });
    expect(record.snapshot().occurrences[0].source.kind).toBe('base');
  });

  it('keeps run evidence enabled when read names are explicitly off', () => {
    const state = new SharedMemory(undefined, {});
    const sink = memorySink();
    const record = createReadSourceRecord(state, address, { sink, collects: { reads: 'off' } });
    new RecordFrame(state, record.log).commit(stamped);
    record.log.noteRun('run.stop', { id: 'step#0', by: 'break' });
    record.log.close('ok');

    const evidence = readRunEvidence(readStoredRecord(sink.entries), address.logRunId);
    expect(record.log.keepsEvidence).toBe(true);
    expect(sink.entries[0]).toMatchObject({ collects: { v: 2, reads: 'off' } });
    expect(evidence.reads).toEqual({ status: 'not-collected', rows: [], why: 'reads-off' });
    expect(evidence.stops).toMatchObject({ status: 'collected', rows: [{ by: 'break' }] });
    expect(sink.entries.at(-1)).toMatchObject({ runNotes: 1 });
  });

  it('leaves omitted and explicit undefined collection byte-equivalent and inert', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(123);
    try {
      const run = (explicit: boolean) => {
        const state = new SharedMemory(undefined, {});
        const sink = memorySink();
        const record = createReadSourceRecord(state, address, explicit ? { sink, collects: undefined } : { sink });
        new RecordFrame(state, record.log).commit(stamped);
        record.log.noteRun('run.stage', { id: 'step#0' });
        record.log.close('ok');
        expect(record.log.keepsEvidence).toBe(false);
        expect(Object.hasOwn(record.log, 'collects')).toBe(false);
        expect(Object.hasOwn(record.log, 'runNotes')).toBe(false);
        expect(sink.entries.map((entry) => entry.kind)).toEqual(['opened', 'commit', 'closed']);
        expect(sink.entries[0]).not.toHaveProperty('collects');
        expect(sink.entries[1]).not.toHaveProperty('about');
        expect(sink.entries[2]).not.toHaveProperty('runNotes');
        return sink.entries;
      };
      expect(run(true)).toEqual(run(false));
      const plain = createReadSourceRecord(new SharedMemory(undefined, {}), address);
      expect(plain.log.keepsEvidence).toBe(false);
      expect(Object.hasOwn(plain.log, 'collects')).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it('does not turn an inherited collecting option into an own declaration', () => {
    const sink = memorySink();
    const options = Object.assign(Object.create({ collects: { reads: 'keys' } }), { sink });
    const record = createReadSourceRecord(new SharedMemory(undefined, {}), address, options);

    expect(record.log.keepsEvidence).toBe(false);
    expect(sink.entries[0]).not.toHaveProperty('collects');
  });

  it('preserves the canonical explicit zero run-note count', () => {
    const sink = memorySink();
    const record = createReadSourceRecord(new SharedMemory(undefined, {}), address, {
      sink,
      collects: { reads: 'keys' },
    });
    record.log.close('ok');

    expect(sink.entries.at(-1)).toMatchObject({ kind: 'closed', runNotes: 0 });
  });

  it.each([null, true, 'keys', 1, [], Object.assign([], { reads: 'keys' }), {}, { reads: 'all' }])(
    'refuses invalid declarations without storing a manifest or leaving active capture: %j',
    (collects) => {
      const state = new SharedMemory(undefined, {});
      const sink = memorySink();

      expect(() => createReadSourceRecord(state, address, untrustedOptions(sink, collects))).toThrow(TypeError);
      expect(sink.entries).toEqual([]);
      expect(captureFor(state)?.retired).not.toBe(false);
      const retry = createReadSourceRecord(state, address, { sink, collects: { reads: 'keys' } });
      expect(retry.log.keepsEvidence).toBe(true);
    },
  );

  it('refuses inherited reads instead of borrowing the prototype value', () => {
    const sink = memorySink();
    expect(() =>
      createReadSourceRecord(
        new SharedMemory(undefined, {}),
        address,
        untrustedOptions(sink, Object.create({ reads: 'keys' })),
      ),
    ).toThrow("collects.reads must be 'keys' or 'off'");
    expect(sink.entries).toEqual([]);
  });

  it('refuses a collecting request without a sink before capture is allocated', () => {
    const state = new SharedMemory(undefined, {});
    expect(() => createReadSourceRecord(state, address, { collects: { reads: 'off' } })).toThrow(
      'collects requires a sink',
    );
    expect(captureFor(state)).toBeUndefined();
  });

  it('refuses top-level and nested accessors without invoking them', () => {
    const getter = vi.fn(() => ({ reads: 'keys' }));
    const sink = memorySink();
    const options = Object.defineProperty({ sink }, 'collects', { get: getter });
    expect(() => createReadSourceRecord(new SharedMemory(undefined, {}), address, options)).toThrow(TypeError);
    const nested = Object.defineProperty({}, 'reads', { get: getter });
    expect(() =>
      createReadSourceRecord(new SharedMemory(undefined, {}), address, untrustedOptions(sink, nested)),
    ).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
    expect(sink.entries).toEqual([]);
  });

  it('reads named descriptors once, ignores unknown getters and never uses a get trap', () => {
    let reads = 0;
    let declarations = 0;
    const unknown = vi.fn(() => {
      throw new Error('not data');
    });
    const target = Object.defineProperty({}, 'v', { get: unknown });
    const given = new Proxy(target, {
      get() {
        throw new Error('no ordinary access');
      },
      getOwnPropertyDescriptor(_target, key) {
        if (key !== 'reads') throw new Error('only the named field');
        reads++;
        return { configurable: true, enumerable: true, value: reads === 1 ? 'keys' : 'off' };
      },
    });
    const sink = memorySink();
    const options = new Proxy(Object.defineProperty({ sink, collects: given }, 'other', { get: unknown }), {
      get() {
        throw new Error('no ordinary option access');
      },
      getOwnPropertyDescriptor(target, key) {
        if (key === 'collects') declarations++;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const record = createReadSourceRecord(
      new SharedMemory(undefined, {}),
      address,
      options as unknown as ReadSourceRecordOptions,
    );

    expect(record.log.keepsEvidence).toBe(true);
    expect(sink.entries[0]).toMatchObject({ collects: { v: 2, reads: 'keys' } });
    expect(reads).toBe(1);
    expect(declarations).toBe(1);
    expect(unknown).not.toHaveBeenCalled();
  });

  it('translates throwing descriptor traps and revoked proxies without opening a log', () => {
    const sink = memorySink();
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('private trap message');
        },
      },
    );
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const given of [hostile, revoked.proxy]) {
      const state = new SharedMemory(undefined, {});
      expect(() => createReadSourceRecord(state, address, untrustedOptions(sink, given))).toThrow(TypeError);
      expect(() => createReadSourceRecord(state, address, untrustedOptions(sink, given))).not.toThrow(
        'private trap message',
      );
      expect(captureFor(state)).toBeUndefined();
    }
    expect(sink.entries).toEqual([]);
  });

  it('retires capture and preserves a constructor failure, allowing a later valid opening', () => {
    const state = new SharedMemory(undefined, {});
    const sink = memorySink();
    const failure = new Error('constructor failed');
    const clone = vi.spyOn(globalThis, 'structuredClone').mockImplementationOnce(() => {
      throw failure;
    });
    let caught: unknown;
    try {
      createReadSourceRecord(state, address, { sink, collects: { reads: 'keys' } });
    } catch (error) {
      caught = error;
    } finally {
      clone.mockRestore();
    }
    expect(caught).toBe(failure);
    expect(captureFor(state)?.retired).toBe(true);
    expect(sink.entries).toEqual([]);
    expect(createReadSourceRecord(state, address, { sink, collects: { reads: 'keys' } }).log.keepsEvidence).toBe(true);
  });

  it('reserves heap ownership before the collecting sink can reenter', () => {
    const state = new SharedMemory(undefined, {});
    const sink = memorySink();
    const opened = sink.opened;
    let refused: unknown;
    sink.opened = (entry) => {
      opened(entry);
      try {
        createReadSourceRecord(state, address, { sink: memorySink(), collects: { reads: 'keys' } });
      } catch (error) {
        refused = error;
      }
    };
    const record = createReadSourceRecord(state, address, { sink, collects: { reads: 'keys' } });

    expect(refused).toBeInstanceOf(TypeError);
    expect(String(refused)).toContain('heap already bound');
    expect(record.log.sinkFailures).toBe(0);
    expect(captureFor(record.log)).toBe(captureFor(state));
    expect(sink.entries).toHaveLength(1);
  });

  it('still poisons exact capture when an opened callback changes the heap', () => {
    const state = new SharedMemory(undefined, { count: 1 });
    const sink = memorySink();
    sink.opened = () => state.setValue([], [], 'count', 2);
    const record = createReadSourceRecord(state, address, { sink, collects: { reads: 'keys' } });
    const selected = new RecordFrame(state, record.log).readWithSource([], 'count', { runtimeStageId: 'step#0' });

    expect(selected.value).toBe(2);
    expect(selected.occurrence?.source.kind).toBe('unavailable');
    expect(record.snapshot().status).toBe('failed');
    expect(record.log.keepsEvidence).toBe(true);
  });

  it('keeps the canonical spent sequence and reader gap after a sink loses a note', () => {
    const state = new SharedMemory(undefined, {});
    const sink = memorySink();
    const note = sink.note;
    let first = true;
    sink.note = (entry) => {
      if (first) {
        first = false;
        throw new Error('sink failed');
      }
      note(entry);
    };
    const record = createReadSourceRecord(state, address, { sink, collects: { reads: 'keys' } });
    new RecordFrame(state, record.log).commit(stamped);
    record.log.noteRun('run.stage', { id: 'step#0' });
    record.log.noteRun('run.stop', { id: 'step#0', by: 'break' });
    record.log.close('ok');

    expect(record.log.length).toBe(1);
    expect(record.log.sinkFailures).toBe(1);
    expect(sink.entries.flatMap((entry) => (entry.kind === 'note' ? [entry.data.seq] : []))).toEqual([1]);
    expect(sink.entries.at(-1)).toMatchObject({ runNotes: 2 });
    const evidence = readRunEvidence(readStoredRecord(sink.entries), address.logRunId);
    expect(evidence.stops.status).toBe('partial');
    if (evidence.stops.status === 'partial') expect(evidence.stops.gaps.length).toBeGreaterThan(0);
  });

  it('keeps a rejected sink promise from reaching the collecting writer', async () => {
    const sink = memorySink();
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, rejected) => {
      reject = rejected;
    });
    sink.note = () => pending;
    const record = createReadSourceRecord(new SharedMemory(undefined, {}), address, {
      sink,
      collects: { reads: 'keys' },
    });
    record.log.noteRun('run.stage', { id: 'step#0' });
    reject(new Error('sink rejected'));
    await Promise.resolve();
    await Promise.resolve();
    record.log.close('ok');

    expect(record.log.sinkFailures).toBe(1);
    expect(sink.entries.at(-1)).toMatchObject({ runNotes: 1 });
  });
});
