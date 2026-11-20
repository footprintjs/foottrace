import fc from 'fast-check';
import { expect, it } from 'vitest';
import { bundle } from '../../../../test/fixtures/source-links/recordHarness.js';
import { deepEqual } from '../../memory/equality.js';
import { nativeGet, nativeHas, nativeSet } from '../../memory/pathOps.js';
import type { CommitBundle, TraceEntry } from '../../memory/types.js';
import { DELIM } from '../../record-paths/codec.js';
import { stateAt } from '../../../index.js';
import { sourceLinkReplay } from './replay.js';

const part = fc.oneof(
  fc.integer({ min: 0, max: 5 }),
  fc.string({ maxLength: 8 }),
  fc.constant(null),
  fc.record({ note: fc.string({ maxLength: 8 }), tags: fc.array(fc.boolean(), { maxLength: 3 }) }),
);
const list = fc.array(part, { maxLength: 4 });
const value = fc.oneof(list, part);
const key = 'list';
const nested = `bucket${DELIM}list`;

const direct = fc.record({
  base: fc.option(value, { nil: undefined }),
  rows: fc.array(
    fc.oneof(
      fc.record({ verb: fc.constant('set' as const), operand: value }),
      fc.record({ verb: fc.constant('append' as const), operand: value }),
      fc.record({ verb: fc.constant('delete' as const), operand: fc.constant(undefined) }),
      fc.record({ verb: fc.constant('unrelated' as const), operand: value }),
    ),
    { minLength: 1, maxLength: 12 },
  ),
});

function oneRow(idx: number, path: string, verb: TraceEntry['verb'], operand: unknown) {
  const payload = nativeSet({}, path.split(DELIM), operand);
  return bundle(idx, `row#${idx}`, verb === 'merge' ? {} : payload, [{ path, verb }], verb === 'merge' ? payload : {});
}

function compare(log: CommitBundle[], base: Record<string, unknown>, path: string) {
  const replay = sourceLinkReplay({ log, base }, { left: 1_000_000 });
  const parts = path.split(DELIM);
  const expected = [base, ...log.map((_, i) => stateAt({ initialState: base, commitLog: log }, i).state)];
  const elementWriters: (number | undefined)[] = [];
  for (const [cut, state] of expected.entries()) {
    const index = cut - 1;
    const current = nativeGet(state, parts);
    const got = replay.list(path, index);
    expect(got !== undefined, `list at ${index}`).toBe(Array.isArray(current));
    if (Array.isArray(current)) {
      expect(got?.length).toBe(current.length);
      for (let element = 0; element <= current.length; element++) {
        expect(got?.element(element).present).toBe(Object.hasOwn(current, element));
        expect(got?.element(element).value).toEqual(current[element]);
      }
    }
    if (index < 0) continue;
    const previous = expected[cut - 1];
    const before = nativeGet(previous, parts);
    const wrote = log[index].trace.some((entry) => entry.path === path);
    const start =
      !wrote || !Array.isArray(current)
        ? undefined
        : !nativeHas(previous, parts)
        ? 0
        : Array.isArray(before) && before.length < current.length
        ? before.length
        : undefined;
    expect(replay.appended(path, index), `appended start at ${index}`).toBe(start);
    for (
      let element = 0;
      element < Math.max(Array.isArray(before) ? before.length : 0, Array.isArray(current) ? current.length : 0);
      element++
    ) {
      const old = Array.isArray(before) && Object.hasOwn(before, element);
      const next = Array.isArray(current) && Object.hasOwn(current, element);
      const changed = old !== next || (old && next && !deepEqual(before[element], current[element], 'copies'));
      if (changed) elementWriters[element] = index;
      // This differential concerns direct writes on the list as in the original probe.
      // A row directly on a selected element has separate recorded-write evidence.
      if (path === key) expect(replay.writer({ key: path, element }, cut)).toBe(elementWriters[element]);
    }
  }
}

it('compares direct history to the ordinary fold, including non-list append payloads', () => {
  fc.assert(
    fc.property(direct, ({ base, rows }) => {
      const log = rows.map(({ verb, operand }, idx) =>
        verb === 'unrelated' ? oneRow(idx, 'other', 'set', operand) : oneRow(idx, key, verb, operand),
      );
      compare(log, base === undefined ? {} : { [key]: base }, key);
    }),
    { seed: 20261120, numRuns: 512 },
  );
}, 15_000);

it('compares the nested history across a parent merge, append and deletion', () => {
  fc.assert(
    fc.property(list, list, list, (start, additions, tail) => {
      const log = [
        oneRow(0, 'bucket', 'merge', { list: additions }),
        oneRow(1, nested, 'append', tail),
        oneRow(2, `bucket${DELIM}other`, 'set', 'unrelated'),
        oneRow(3, nested, 'delete', undefined),
        oneRow(4, nested, 'set', start),
      ];
      compare(log, { bucket: { list: start } }, nested);
    }),
    { seed: 20261120, numRuns: 128 },
  );
});
