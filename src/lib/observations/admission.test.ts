import { describe, expect, it, vi } from 'vitest';
import { ObservationError, OBSERVATION_LIMITS, readObservationRecord, readStoredRecord } from '../../index.js';
import { createObservationRecord, memorySink } from '../../write.js';
import type { StoredRecord } from '../../index.js';
import type { ObservationRecordOptions } from '../../write.js';
import { address, observation, reopen, saved, subject } from '../../../test/lib/observations/fixtures.js';

const create = (input: unknown) => createObservationRecord(input as ObservationRecordOptions);
const gapCodes = (entries: unknown[]) => reopen(entries).gaps.map((gap) => gap.code);

describe('observation admission, bounds and immutable owned data', () => {
  it.each([
    { maxRows: 0 },
    { maxRows: 257 },
    { maxRows: Infinity },
    { maxRows: 1.5 },
    { maxBytes: 131073 },
    { maxRowBytes: 4097 },
    { maxFacts: 17 },
    { maxBytes: -1 },
    { maxBytes: '42' },
    null,
  ])('refuses invalid public limits before dispatch', (limits) => {
    const sink = { opened: vi.fn(), commit: vi.fn(), note: vi.fn(), closed: vi.fn() };
    expect(() => create({ sink, address, subject, limits })).toThrow(ObservationError);
    expect(sink.opened).not.toHaveBeenCalled();
  });
  it('exports fixed frozen policy ceilings and accepts only smaller positive limits', () => {
    expect(OBSERVATION_LIMITS).toEqual({ maxRows: 256, maxBytes: 131072, maxRowBytes: 4096 });
    expect(Object.isFrozen(OBSERVATION_LIMITS)).toBe(true);
    expect(() =>
      create({ sink: memorySink(), address, subject, limits: { maxRows: 1, maxBytes: 100, maxRowBytes: 50 } }),
    ).not.toThrow();
  });
  it('rejects accessor options and unknown options without invoking callbacks', () => {
    const getter = vi.fn(() => 1),
      sink = { opened: vi.fn(), commit: vi.fn(), note: vi.fn(), closed: vi.fn() };
    const limits = Object.defineProperty({}, 'maxRows', { enumerable: true, get: getter });
    expect(() => create({ sink, address, subject, limits })).toThrow('invalid-options');
    expect(() => create({ sink, address, subject, trust: true })).toThrow('invalid-options');
    expect(getter).not.toHaveBeenCalled();
    expect(sink.opened).not.toHaveBeenCalled();
  });
  it('rejects accessors in subject, sink and address without executing them', () => {
    const getter = vi.fn(() => 'secret');
    for (const slot of ['subject', 'address', 'sink']) {
      const bad = Object.defineProperty({}, slot === 'sink' ? 'opened' : slot === 'address' ? 'logRunId' : 'runId', {
        enumerable: true,
        get: getter,
      });
      expect(() => create({ sink: memorySink(), address, subject, [slot]: bad })).toThrow('invalid-options');
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it('requires an independent host log and a well-formed attempt bound to its stage', () => {
    expect(() => create({ sink: memorySink(), address: subject.nativeAddress, subject })).toThrow('invalid-options');
    expect(() => create({ sink: memorySink(), address, subject: { ...subject, attemptId: 'other#0@1.1@1' } })).toThrow(
      'invalid-options',
    );
    expect(() => readObservationRecord(readStoredRecord([]), { address, subject, limits: { maxRows: 257 } })).toThrow(
      'invalid-options',
    );
  });
  it('does not call input getters, iterators or toJSON during schema admission', () => {
    const hook = vi.fn(() => 'secret'),
      sink = memorySink();
    const writer = createObservationRecord({ sink, address, subject });
    const getter = Object.defineProperty({}, 'event', { enumerable: true, get: hook });
    const iterator = { event: 'service.response', [Symbol.iterator]: hook };
    const toJSON = { event: 'service.response', toJSON: hook };
    for (const input of [getter, iterator, toJSON])
      expect(writer.note(input)).toEqual({ status: 'omitted', reason: 'invalid-data' });
    writer.close();
    expect(hook).not.toHaveBeenCalled();
    expect(gapCodes([...sink.entries])).toContain('omitted');
  });
  it.each([
    { event: 'bad event' },
    { event: 'run.something', extra: true },
    { event: 'x', facts: { secret: { nested: true } } },
    { event: 'x', facts: { text: 'x'.repeat(257) } },
    { event: 'x', facts: { value: undefined } },
    { event: 'x', facts: { value: NaN } },
    { event: 'x', observedAt: { clock: 'host', elapsedMs: -1 } },
    { event: 'x', observedAt: { clock: 'host', elapsedMs: Infinity } },
    { event: 'x', facts: Object.fromEntries(Array.from({ length: 17 }, (_, i) => ['key' + i, i])) },
  ])('omits unsupported schemas as whole rows', (input) => {
    const sink = memorySink(),
      writer = createObservationRecord({ sink, address, subject });
    expect(writer.note(input)).toEqual({ status: 'omitted', reason: 'invalid-data' });
    writer.close();
    expect(reopen([...sink.entries])).toMatchObject({ status: 'partial', rows: [] });
  });
  it('keeps caller mutations out of stored rows and freezes returned facts', () => {
    const sink = memorySink(),
      mutable = observation(),
      original = structuredClone(mutable);
    const writer = createObservationRecord({ sink, address, subject });
    writer.note(mutable);
    mutable.event = 'edited';
    mutable.facts.status = 200;
    mutable.observedAt.elapsedMs = 999;
    writer.close();
    const evidence = reopen([...sink.entries]);
    expect(evidence.rows[0]).toMatchObject(original);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.rows[0].facts)).toBe(true);
  });
  it('never calls an arbitrary StoredRecord lookup callback or overwritten map.get', () => {
    const stored = readStoredRecord(saved()),
      call = vi.fn();
    const maps = new Map(stored.logs);
    Object.defineProperty(maps, 'get', { get: call });
    const substitute = { ...stored, logs: maps, log: call } as StoredRecord;
    expect(readObservationRecord(substitute, { address, subject }).status).toBe('collected');
    expect(call).not.toHaveBeenCalled();
  });
  it('refuses accessors in parsed stored note data without executing them', () => {
    const entries = saved(),
      note = entries.find((entry) => entry.kind === 'note');
    if (!note || note.kind !== 'note') throw new Error('fixture');
    const call = vi.fn(() => 'service.response');
    Object.defineProperty(note.data, 'event', { enumerable: true, get: call });
    const evidence = reopen(entries);
    expect(evidence.status).toBe('partial');
    expect(call).not.toHaveBeenCalled();
  });
});
