import { describe, expect, it, vi } from 'vitest';
import { createObservationRecord, EventLog, memorySink } from '../../write.js';
import type { RecordSink } from '../../write.js';
import { address, observation, reopen, subject } from '../../../test/lib/observations/fixtures.js';

class ClassSink implements RecordSink {
  #inner = memorySink();
  #calls = 0;
  get entries() {
    return this.#inner.entries;
  }
  get calls() {
    return this.#calls;
  }
  opened(entry: Parameters<RecordSink['opened']>[0]) {
    this.#calls++;
    this.#inner.opened(entry);
  }
  commit(entry: Parameters<RecordSink['commit']>[0]) {
    this.#calls++;
    this.#inner.commit(entry);
  }
  note(entry: Parameters<RecordSink['note']>[0]) {
    this.#calls++;
    this.#inner.note(entry);
  }
  closed(entry: Parameters<RecordSink['closed']>[0]) {
    this.#calls++;
    this.#inner.closed(entry);
  }
}

describe('trusted RecordSink callback ports', () => {
  it('supports ordinary class methods accepted by EventLog, preserving the original private-field receiver', () => {
    const native = new ClassSink();
    new EventLog({}, { sink: native, address: subject.nativeAddress }).close('failed');
    expect(native.calls).toBe(2);
    const sink = new ClassSink(),
      writer = createObservationRecord({ sink, address, subject });
    writer.note(observation());
    writer.close();
    expect(sink.calls).toBe(3);
    expect(reopen([...sink.entries]).status).toBe('collected');
  });
  it('uses the nearest inherited override and preserves its receiver', () => {
    class OverrideSink extends ClassSink {
      #notes = 0;
      get notes() {
        return this.#notes;
      }
      override note(entry: Parameters<RecordSink['note']>[0]) {
        this.#notes++;
        super.note(entry);
      }
    }
    const sink = new OverrideSink(),
      writer = createObservationRecord({ sink, address, subject });
    writer.note(observation());
    writer.close();
    expect(sink.notes).toBe(1);
    expect(sink.calls).toBe(3);
    expect(reopen([...sink.entries]).status).toBe('collected');
  });
  it('rejects own and inherited method accessors without executing them or dispatching opened', () => {
    const getter = vi.fn(() => () => {});
    for (const property of ['note', 'onFailure', 'flush']) {
      const parent = Object.create(ClassSink.prototype);
      Object.defineProperty(parent, property, { get: getter });
      const sink = new ClassSink();
      Object.setPrototypeOf(sink, parent);
      expect(() => createObservationRecord({ sink, address, subject })).toThrow('invalid-options');
      expect(sink.calls).toBe(0);
      const own = new ClassSink();
      Object.defineProperty(own, property, { get: getter });
      expect(() => createObservationRecord({ sink: own, address, subject })).toThrow('invalid-options');
      expect(own.calls).toBe(0);
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it('dispatches failure callbacks on their original private-field receiver', () => {
    class FailingSink extends ClassSink {
      #failures = 0;
      get failures() {
        return this.#failures;
      }
      override note() {
        throw new Error('withheld');
      }
      onFailure() {
        this.#failures++;
      }
    }
    const sink = new FailingSink(),
      writer = createObservationRecord({ sink, address, subject });
    expect(writer.note(observation()).status).toBe('noted');
    writer.close();
    expect(sink.failures).toBe(1);
    expect(reopen([...sink.entries]).status).toBe('partial');
  });
  it('captures admitted data methods once, rather than later evaluating a replacement accessor', () => {
    const sink = new ClassSink(),
      writer = createObservationRecord({ sink, address, subject }),
      getter = vi.fn();
    Object.defineProperty(sink, 'note', { get: getter });
    writer.note(observation());
    writer.close();
    expect(getter).not.toHaveBeenCalled();
    expect(reopen([...sink.entries]).status).toBe('collected');
  });
  it('uses Reflect.apply rather than a caller-owned Function.call property', () => {
    const sink = new ClassSink(),
      call = vi.fn(() => {
        throw new Error('must not run');
      });
    Object.defineProperty(sink.note, 'call', { value: call, configurable: true });
    try {
      const writer = createObservationRecord({ sink, address, subject });
      writer.note(observation());
      writer.close();
    } finally {
      Reflect.deleteProperty(sink.note, 'call');
    }
    expect(call).not.toHaveBeenCalled();
    expect(reopen([...sink.entries]).status).toBe('collected');
  });
  it('refuses an over-deep callback prototype path and a cyclic Proxy path without unbounded traversal', () => {
    const opened = vi.fn();
    let prototype: object = { opened, commit() {}, note() {}, closed() {} };
    for (let index = 0; index < 32; index++) prototype = Object.create(prototype);
    expect(() => createObservationRecord({ sink: prototype as RecordSink, address, subject })).toThrow(
      'invalid-options',
    );
    let reflections = 0;
    const loop: object = new Proxy(
      {},
      {
        getPrototypeOf() {
          reflections++;
          return loop;
        },
      },
    );
    expect(() => createObservationRecord({ sink: loop as RecordSink, address, subject })).toThrow('invalid-options');
    expect(reflections).toBeLessThanOrEqual(16);
    expect(opened).not.toHaveBeenCalled();
  });
});
