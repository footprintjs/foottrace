import { expect, it } from 'vitest';
import { HONESTY_CODES } from '../memory/honesty.js';
import { memorySink } from '../../write.js';
import { createObservationRecord } from './writer.js';
import { ObservationError } from './types.js';
import { address, reopen, subject } from '../../../test/lib/observations/fixtures.js';

it('explains actual omitted evidence from a saved observation cut through the shared registry', () => {
  const sink = memorySink();
  const writer = createObservationRecord({ sink, address, subject });
  const omitted = writer.note({ event: 'service.response', facts: { nested: { unsupported: true } } });
  expect(omitted).toEqual({ status: 'omitted', reason: 'invalid-data' });
  writer.close();
  const evidence = reopen(JSON.parse(JSON.stringify(sink.entries)));
  expect(evidence.status).toBe('partial');
  expect(evidence.authenticity).toBe('unverified');
  expect(evidence.gaps.map((gap) => gap.code)).toContain('omitted');
  for (const code of ['invalid-data', ...evidence.gaps.map((gap) => gap.code)])
    expect(Object.hasOwn(HONESTY_CODES, code), code).toBe(true);
});

it('keeps a caller-options refusal separate from evidence gaps and does not create a recording', () => {
  const sink = memorySink();
  expect(() => createObservationRecord({ sink, address, subject, limits: { maxRows: 0 } })).toThrowError(
    new ObservationError('invalid-options'),
  );
  expect(sink.entries).toEqual([]);
  expect(Object.hasOwn(HONESTY_CODES, 'invalid-options')).toBe(false);
});
