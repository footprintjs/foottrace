import { expect, it } from 'vitest';
import { createObservationRecord, memorySink } from '../../write.js';
import { address, reopen, subject } from '../../../test/lib/observations/fixtures.js';

/** Inspection is allowed to run Proxy traps; each fixture reenters only once. */
function inspected(action: () => void) {
  let entered = false;
  return new Proxy(
    { event: 'outer.note' },
    {
      ownKeys(target) {
        if (!entered) {
          entered = true;
          action();
        }
        return Reflect.ownKeys(target);
      },
    },
  );
}

it('cannot append after input inspection seals the writer', () => {
  const sink = memorySink(),
    writer = createObservationRecord({ sink, address, subject });
  expect(writer.note(inspected(() => writer.close()))).toEqual({ status: 'omitted', reason: 'closed' });
  writer.close();
  const entries = JSON.parse(JSON.stringify(sink.entries));
  expect(entries.map((entry: { kind: string }) => entry.kind)).toEqual(['opened', 'closed']);
  expect(entries[1].meta.observations).toEqual({
    v: 1,
    rows: 0,
    omissions: { 'invalid-data': 0, 'row-limit': 0, 'byte-limit': 0 },
  });
});

it('does not mutate omission accounting if inspection closes and then throws', () => {
  const sink = memorySink(),
    writer = createObservationRecord({ sink, address, subject });
  expect(
    writer.note(
      inspected(() => {
        writer.close();
        throw Error('private input failure');
      }),
    ),
  ).toEqual({ status: 'omitted', reason: 'closed' });
  expect(sink.entries).toHaveLength(2);
  expect(JSON.stringify(sink.entries)).not.toContain('private input failure');
  expect(reopen(JSON.parse(JSON.stringify(sink.entries)))).toMatchObject({ status: 'collected', rows: [] });
});

it.each([1, 256])('rechecks the current %i-row budget after nested admission', (maxRows) => {
  const sink = memorySink(),
    writer = createObservationRecord({ sink, address, subject, limits: { maxRows } });
  const outer = inspected(() => {
    for (let sequence = 1; sequence <= maxRows; sequence++)
      expect(writer.note({ event: 'inner.note' })).toEqual({ status: 'noted', sequence });
  });
  expect(writer.note(outer)).toEqual({ status: 'omitted', reason: 'row-limit' });
  writer.close();
  const entries = JSON.parse(JSON.stringify(sink.entries));
  expect(entries.filter((entry: { kind: string }) => entry.kind === 'note')).toHaveLength(maxRows);
  expect(entries.at(-1).meta.observations).toEqual({
    v: 1,
    rows: maxRows,
    omissions: { 'invalid-data': 0, 'row-limit': 1, 'byte-limit': 0 },
  });
  const opened = reopen(entries);
  expect(opened.status).toBe('partial');
  expect(opened.rows.map((row) => row.sequence)).toEqual(Array.from({ length: maxRows }, (_, index) => index + 1));
  expect(opened.rows.every((row) => row.event === 'inner.note')).toBe(true);
});

it('keeps safe nested notes in order when the live budget still has room', () => {
  const sink = memorySink(),
    writer = createObservationRecord({ sink, address, subject, limits: { maxRows: 2 } });
  expect(
    writer.note(
      inspected(() => {
        writer.note({ event: 'inner.note' });
      }),
    ),
  ).toEqual({ status: 'noted', sequence: 2 });
  writer.close();
  const opened = reopen(JSON.parse(JSON.stringify(sink.entries)));
  expect(opened.status).toBe('collected');
  expect(opened.rows.map((row) => [row.sequence, row.event])).toEqual([
    [1, 'inner.note'],
    [2, 'outer.note'],
  ]);
});

it('charges bytes spent by nested notes before accepting the outer one', () => {
  const sink = memorySink(),
    writer = createObservationRecord({ sink, address, subject, limits: { maxBytes: 60 } });
  expect(
    writer.note(
      inspected(() => {
        writer.note({ event: 'inner.note' });
      }),
    ),
  ).toEqual({ status: 'omitted', reason: 'byte-limit' });
  writer.close();
  const opened = reopen(JSON.parse(JSON.stringify(sink.entries)));
  expect(opened.status).toBe('partial');
  expect(opened.rows.map((row) => row.event)).toEqual(['inner.note']);
});
