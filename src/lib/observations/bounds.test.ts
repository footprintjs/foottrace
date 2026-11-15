import { describe, expect, it, vi } from 'vitest';
import { EventLog, createObservationRecord, memorySink } from '../../write.js';
import { readObservationRecord, readStoredRecord } from '../../index.js';
import { address, observation, reopen, saved, subject } from '../../../test/lib/observations/fixtures.js';

describe('bounded observation cuts and sink failures', () => {
  it('seals once and never reads late or row-limited input', () => {
    const sink = memorySink(),
      writer = createObservationRecord({ sink, address, subject, limits: { maxRows: 1 } });
    expect(writer.note(observation()).status).toBe('noted');
    const getter = vi.fn(() => 'x'),
      late = Object.defineProperty({}, 'event', { enumerable: true, get: getter });
    expect(writer.note(late)).toEqual({ status: 'omitted', reason: 'row-limit' });
    writer.close();
    writer.close();
    expect(writer.note(late)).toEqual({ status: 'omitted', reason: 'closed' });
    expect(getter).not.toHaveBeenCalled();
    expect(sink.entries.filter((entry) => entry.kind === 'closed')).toHaveLength(1);
    expect(reopen([...sink.entries])).toMatchObject({ status: 'partial', rows: [{ sequence: 1 }] });
  });
  it('enforces the fixed 256-row ceiling and reports the omitted attempt', () => {
    const sink = memorySink(),
      writer = createObservationRecord({ sink, address, subject });
    for (let index = 1; index <= 256; index++)
      expect(writer.note({ event: 'queue.sample' })).toEqual({ status: 'noted', sequence: index });
    expect(writer.note({ event: 'queue.sample' })).toEqual({ status: 'omitted', reason: 'row-limit' });
    writer.close();
    expect(reopen([...sink.entries])).toMatchObject({ status: 'partial' });
    expect(reopen([...sink.entries]).rows).toHaveLength(256);
  });
  it('enforces per-row and total byte limits without silently truncating facts', () => {
    const sink = memorySink(),
      writer = createObservationRecord({ sink, address, subject, limits: { maxRowBytes: 100 } });
    expect(writer.note(observation())).toEqual({ status: 'omitted', reason: 'byte-limit' });
    writer.close();
    expect(reopen([...sink.entries]).gaps.map((gap) => gap.code)).toContain('omitted');
    const total = memorySink(),
      bounded = createObservationRecord({ sink: total, address, subject, limits: { maxBytes: 160 } });
    expect(bounded.note(observation()).status).toBe('noted');
    expect(bounded.note(observation())).toEqual({ status: 'omitted', reason: 'byte-limit' });
    bounded.close();
    expect(reopen([...total.entries]).rows).toHaveLength(1);
  });
  it('stops at smaller reader limits and declares a partial result', () => {
    const entries = saved();
    expect(reopen(entries, { maxRows: 1 })).toMatchObject({ status: 'partial', rows: [{ sequence: 1 }] });
    expect(reopen(entries, { maxBytes: 160 }).gaps.map((gap) => gap.code)).toContain('byte-limit');
    expect(reopen(entries, { maxRowBytes: 100 }).gaps.map((gap) => gap.code)).toContain('byte-limit');
  });
  it('dispatch acceptance is not durability: a throwing sink leaves a detectable missing tail', () => {
    const sink = memorySink(),
      originalNote = sink.note;
    let calls = 0;
    sink.note = (entry) => {
      if (++calls === 2) throw new Error('private provider failure');
      originalNote(entry);
    };
    const writer = createObservationRecord({ sink, address, subject });
    writer.note(observation());
    expect(writer.note(observation()).status).toBe('noted');
    writer.close();
    expect(reopen([...sink.entries])).toMatchObject({ status: 'partial', rows: [{ sequence: 1 }] });
    expect(JSON.stringify(reopen([...sink.entries]))).not.toContain('private provider failure');
  });
  it('handles a rejected asynchronous sink note without an unhandled rejection', async () => {
    const sink = memorySink(),
      failures = vi.fn();
    sink.note = () => Promise.reject(new Error('private'));
    sink.onFailure = failures;
    const writer = createObservationRecord({ sink, address, subject });
    expect(writer.note(observation()).status).toBe('noted');
    writer.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failures).toHaveBeenCalledOnce();
    expect(reopen([...sink.entries]).status).toBe('partial');
  });
  it('keeps foreign-clock receipts as observations without manufacturing order or cause', () => {
    const sink = memorySink(),
      writer = createObservationRecord({ sink, address, subject });
    writer.note({
      event: 'gateway.response',
      observedAt: { clock: 'gateway', elapsedMs: 900 },
      facts: { status: 504 },
    });
    writer.note({ event: 'service.response', observedAt: { clock: 'service', elapsedMs: 1 }, facts: { status: 200 } });
    writer.close();
    const result = readObservationRecord(readStoredRecord(sink.entries), { address, subject });
    expect(result.rows.map((row) => row.observedAt)).toEqual([
      { clock: 'gateway', elapsedMs: 900 },
      { clock: 'service', elapsedMs: 1 },
    ]);
    expect(result).not.toHaveProperty('causes');
    expect(result).not.toHaveProperty('edges');
    expect(result.authenticity).toBe('unverified');
  });
  it('does not change native EventLog entry framing or mutate its entries', () => {
    const native = memorySink(),
      log = new EventLog({}, { sink: native, address: subject.nativeAddress });
    log.note('application', { status: 504 });
    log.close('failed');
    const before = JSON.stringify(native.entries),
      host = memorySink();
    const writer = createObservationRecord({ sink: host, address, subject });
    writer.note(observation());
    writer.close();
    expect(JSON.stringify(native.entries)).toBe(before);
    expect(readStoredRecord([...native.entries, ...host.entries]).log(subject.nativeAddress)?.outcome).toBe('failed');
    expect(host.entries.map((entry) => entry.kind)).toEqual(['opened', 'note', 'closed']);
  });
});
