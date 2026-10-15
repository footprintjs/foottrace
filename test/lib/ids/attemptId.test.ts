/**
 * The attempt-id codec (1.1.0) — `<runtimeStageId>@<n>` and `<runtimeStageId>@<n>.<k>@<m>`, parsed from
 * the right so no byte of a stage id is newly reserved.
 *
 *   unit      build and parse a stage attempt and a call's attempt; parse from the RIGHT on ids whose stage
 *             id holds `@`, `.`, `~` (and a subflow path); a bare runtimeStageId and malformed suffixes are
 *             not attempt ids
 *   property  parse(build(x)) = x over `fc.string()` stage ids with `#` and `/` excluded (the id doors'
 *             reserved bytes), any subflow path and any counts; build(parse(id)) = id for every id parse
 *             accepts; two different attempts never share an id
 *   boundary  counts of 0, negatives, fractions, NaN, ±Infinity and past MAX_SAFE_INTEGER are refused at
 *             build and never parsed; leading zeros are not the canonical spelling; build refuses a
 *             string that is not a runtimeStageId; parse never throws on a non-string
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { buildAttemptId, buildRuntimeStageId, parseAttemptId } from '../../../src/index.js';

describe('attempt ids — unit', () => {
  it('builds and parses a stage attempt', () => {
    expect(buildAttemptId('charge#4', 2)).toBe('charge#4@2');
    expect(parseAttemptId('charge#4@2')).toEqual({ runtimeStageId: 'charge#4', attempt: 2 });
  });

  it('builds and parses the attempt of a call made during a stage attempt', () => {
    const id = buildAttemptId('charge#4', 2, { ordinal: 1, attempt: 3 });
    expect(id).toBe('charge#4@2.1@3');
    expect(parseAttemptId(id)).toEqual({ runtimeStageId: 'charge#4', attempt: 2, call: { ordinal: 1, attempt: 3 } });
  });

  it('parses from the right — a stage id may hold `@`, `.` and `~`, inside a subflow too', () => {
    const rid = buildRuntimeStageId('v1.2@x~3', 7, 'sf-a/each~0');
    expect(rid).toBe('sf-a/each~0/v1.2@x~3#7');
    expect(parseAttemptId(`${rid}@3`)).toEqual({ runtimeStageId: rid, attempt: 3 });
    expect(parseAttemptId(`${rid}@3.2@1`)).toEqual({
      runtimeStageId: rid,
      attempt: 3,
      call: { ordinal: 2, attempt: 1 },
    });
    // A stage id that itself LOOKS like an attempt suffix is still the stage id: the last `#` decides.
    expect(parseAttemptId('a@1.2@3#0@1')).toEqual({ runtimeStageId: 'a@1.2@3#0', attempt: 1 });
  });

  it('a bare runtimeStageId, and anything missing a part, is not an attempt id', () => {
    for (const id of [
      'charge#4',
      'charge',
      'charge@2',
      'charge#4@',
      'charge#@2',
      'charge#4@2.',
      'charge#4@2.1',
      'charge#4@2.1@',
      'charge#4@2@3',
      'charge#4@2.1@3.1@1',
      'charge#4@x',
      '',
    ]) {
      expect(parseAttemptId(id), id).toBeUndefined();
    }
  });

  it('the parsed runtimeStageId is the one the grammar built — its execution index untouched', () => {
    expect(parseAttemptId('sf/score#12@1')?.runtimeStageId).toBe('sf/score#12');
  });
});

describe('attempt ids — property', () => {
  // The id doors refuse `#` and `/` in a user-authored stage id; everything else is legal.
  const stageId = fc.string({ minLength: 1 }).filter((s) => !s.includes('#') && !s.includes('/'));
  const segment = fc.string({ minLength: 1, maxLength: 8 }).filter((s) => !s.includes('#') && !s.includes('/'));
  const count = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });
  const call = fc.option(fc.record({ ordinal: count, attempt: count }), { nil: undefined });

  it('parse(build(x)) = x for every stage id the doors admit, any subflow path and any counts', () => {
    fc.assert(
      fc.property(
        stageId,
        fc.nat(),
        fc.array(segment, { maxLength: 3 }),
        count,
        call,
        (id, index, path, attempt, made) => {
          const rid = buildRuntimeStageId(id, index, path.length > 0 ? path.join('/') : undefined);
          const parsed = parseAttemptId(buildAttemptId(rid, attempt, made));
          expect(parsed).toEqual(
            made === undefined ? { runtimeStageId: rid, attempt } : { runtimeStageId: rid, attempt, call: made },
          );
        },
      ),
    );
  });

  it('build(parse(id)) = id for every string parse accepts — one spelling per attempt', () => {
    // Strings near the grammar: its alphabet, so the parser meets accepted ids, near misses (a 0, a
    // leading zero, a missing part, a doubled delimiter) and stage ids that hold `@` and `.` alike.
    const near = fc.stringMatching(/^[a-z@.~\/]{0,6}#[0-9]{1,3}(@[0-9]{1,3}(\.[0-9]{1,3}@[0-9]{1,3})?)?[@.0-9]{0,2}$/);
    let accepted = 0;
    fc.assert(
      fc.property(near, (id) => {
        const parsed = parseAttemptId(id);
        if (parsed === undefined) return;
        accepted++;
        expect(buildAttemptId(parsed.runtimeStageId, parsed.attempt, parsed.call)).toBe(id);
      }),
      { numRuns: 2000 },
    );
    // The property must have met accepted ids — a vacuous run proves nothing.
    expect(accepted).toBeGreaterThan(200);
  });

  it('two different attempts never share an id', () => {
    fc.assert(
      fc.property(stageId, fc.nat(), count, call, count, call, (id, index, a, ca, b, cb) => {
        const rid = buildRuntimeStageId(id, index);
        const same = a === b && JSON.stringify(ca) === JSON.stringify(cb);
        expect(buildAttemptId(rid, a, ca) === buildAttemptId(rid, b, cb)).toBe(same);
      }),
    );
  });
});

describe('attempt ids — boundary', () => {
  it('a count that is not a positive safe integer is refused at build, so it is never written', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => buildAttemptId('s#0', bad), String(bad)).toThrow(RangeError);
      expect(() => buildAttemptId('s#0', 1, { ordinal: bad, attempt: 1 }), String(bad)).toThrow(RangeError);
      expect(() => buildAttemptId('s#0', 1, { ordinal: 1, attempt: bad }), String(bad)).toThrow(RangeError);
    }
    expect(buildAttemptId('s#0', Number.MAX_SAFE_INTEGER)).toBe(`s#0@${Number.MAX_SAFE_INTEGER}`);
  });

  it('a zero, a leading zero or a count past MAX_SAFE_INTEGER is never parsed', () => {
    for (const id of ['s#0@0', 's#0@01', 's#0@1.0@1', 's#0@1.1@0', 's#0@1.01@1', 's#0@99999999999999999999']) {
      expect(parseAttemptId(id), id).toBeUndefined();
    }
    // The runtimeStageId's own execution index is the runtime-ID grammar's, passed through as written.
    expect(parseAttemptId('s#007@1')).toEqual({ runtimeStageId: 's#007', attempt: 1 });
  });

  it('build refuses a string that is not a runtimeStageId — a stage id, a path, an empty string', () => {
    for (const bad of ['charge', 'sf/charge', 'charge#', 'charge#x', 'charge#4@2', '']) {
      expect(() => buildAttemptId(bad, 1), bad).toThrow(TypeError);
    }
  });

  it('parse never throws: a non-string is not an attempt id', () => {
    for (const bad of [undefined, null, 4, {}, ['s#0@1']]) {
      expect(parseAttemptId(bad as unknown as string)).toBeUndefined();
    }
  });
});
