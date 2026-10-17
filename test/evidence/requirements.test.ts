/** Unit, property, boundary and security: structural admission is never evidence authorization. */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { explain, type CauseGraph } from '../../src/cause.js';
import { readRequirementResults, RequirementValidationError, REQUIREMENT_RESULT_LIMITS } from '../../src/index.js';

const PRIVATE = 'PRIVATE_CREDENTIAL_AND_BUSINESS_PAYLOAD';
const reasons = [
  'not-collected',
  'redacted',
  'invalid-data',
  'unavailable',
  'timeout',
  'not-checked',
  'no-match',
  'ambiguous',
  'stale',
  'incompatible',
  'unsupported',
  'not-permitted',
] as const;

interface Fixture extends Record<string, unknown> {
  id: string;
  requirementRef: string;
  findingRef: string;
  windowRef: string;
  affects: string[];
  state: string;
  reason?: string;
  detail?: string;
  evidenceRefs: string[];
  checks: unknown[];
  actionRefs: string[];
}
function receipt(overrides: Record<string, unknown> = {}): Fixture {
  return {
    id: 'receipt:1',
    requirementRef: 'requirement:connection',
    findingRef: 'finding:latency',
    windowRef: 'window:current',
    affects: ['claim:attribution'],
    state: 'unresolved',
    reason: 'not-collected',
    detail: 'adapter:connection',
    evidenceRefs: ['evidence:summary'],
    checks: [],
    actionRefs: [],
    ...overrides,
  };
}
function check(overrides: Record<string, unknown> = {}) {
  return {
    checkRef: 'check:lookup',
    disposition: 'unreachable',
    reason: 'not-permitted',
    evidenceRefs: [],
    attemptRefs: [],
    ...overrides,
  };
}
function refusal(input: unknown, code = 'invalid-data') {
  let caught: unknown;
  try {
    readRequirementResults(input);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RequirementValidationError);
  expect(caught).toMatchObject({ code, message: 'REQUIREMENT_RESULTS_INVALID' });
  expect(String(caught)).not.toContain(PRIVATE);
  expect(JSON.stringify(caught)).not.toContain(PRIVATE);
}

describe('requirement result structural contract', () => {
  it('preserves opaque bindings, affected claims and separate valid/learned time references', () => {
    const input = receipt({ validTimeRef: 'time:source-validity', learnedTimeRef: 'time:recorded' });
    const output = readRequirementResults([input]);
    expect(output).toEqual([input]);
    expect(output[0]).not.toHaveProperty('fresh');
    expect(output[0]).not.toHaveProperty('authorized');
  });

  it('admits empty arrays without inventing a check, attempt or available action', () => {
    const input = receipt({ evidenceRefs: [] });
    expect(readRequirementResults([input])[0]).toEqual(input);
    expect(readRequirementResults([])).toEqual([]);
  });

  it('reads a supplied satisfied state without claiming its truth or synthesizing verification', () => {
    const input = receipt({ state: 'satisfied' });
    delete input.reason;
    const [result] = readRequirementResults([input]);
    expect(result).toEqual(input);
    expect(result.checks).toEqual([]);
    expect(result).not.toHaveProperty('trusted');
  });

  it.each(['checked-pass', 'checked-fail', 'unreachable', 'not-applicable'] as const)(
    'preserves the existing %s disposition without deriving the result state',
    (disposition) => {
      const input = receipt({ checks: [check({ disposition, attemptRefs: ['attempt:real-1'] })] });
      expect(readRequirementResults([input])[0]).toEqual(input);
    },
  );

  it('retains conflicting receipts without selecting a winner or authorizing the affected claim', () => {
    const satisfied = receipt({ id: 'receipt:2', state: 'satisfied' });
    delete satisfied.reason;
    expect(readRequirementResults([receipt(), satisfied])).toEqual([receipt(), satisfied]);
  });

  it('preserves a 300-finding producer batch and reuse of a real check across results', () => {
    const rows = Array.from({ length: 300 }, (_, i) =>
      receipt({
        id: `receipt:${i}`,
        findingRef: `finding:${i}`,
        affects: [`claim:attribution:${i}`],
        checks: [check()],
      }),
    );
    expect(readRequirementResults(rows)).toEqual(rows);
  });

  it.each(reasons)('uses canonical reason %s unchanged in requirements and graph gaps', async (reason) => {
    expect(readRequirementResults([receipt({ reason })])[0].reason).toBe(reason);
    const graph: CauseGraph = {
      parents: () => ({ edges: [], complete: true }),
      children: () => ({ edges: [], complete: true }),
      attention: () => [],
      gaps: () => [{ code: reason, evidence: ['requirement:connection'] }],
    };
    const result = await explain(graph, 'node:1');
    expect(result.gaps).toContainEqual({ code: reason, evidence: ['requirement:connection'] });
    expect(result.confidence).toBe('incomplete');
  });

  it('copies and deeply freezes only admitted contract data', () => {
    const input = receipt({ checks: [check()] });
    const result = readRequirementResults([input]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
    expect(Object.isFrozen(result[0].affects)).toBe(true);
    expect(Object.isFrozen(result[0].checks[0])).toBe(true);
    expect(Object.isFrozen(result[0].checks[0].attemptRefs)).toBe(true);
    input.affects.push('claim:later');
    expect(result[0].affects).toEqual(['claim:attribution']);
    expect(Object.isFrozen(input)).toBe(false);
  });

  it('accepts ordinary null-prototype records without admitting inherited fields', () => {
    expect(readRequirementResults([Object.assign(Object.create(null), receipt())])).toEqual([receipt()]);
  });

  it('treats hostile-looking identifier strings as inert data', () => {
    const input = receipt({ affects: ['__proto__', 'constructor', 'prototype'] });
    expect(readRequirementResults([input])[0].affects).toEqual(input.affects);
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
});

describe('atomic bounded refusal', () => {
  it.each([null, undefined, {}, 'results', 1, true, new Set(), Promise.resolve([])])('refuses non-list %s', (input) => {
    refusal(input);
  });

  it.each([
    ['unknown state', { state: 'verified' }],
    ['missing state', { state: undefined }],
    ['missing reason', { reason: undefined }],
    ['unknown reason', { reason: 'NO_MATCH' }],
    ['payload reason', { reason: PRIVATE }],
    ['satisfied with gap', { state: 'satisfied' }],
    ['missing requirement', { requirementRef: undefined }],
    ['missing finding', { findingRef: undefined }],
    ['missing window', { windowRef: undefined }],
    ['non-list affects', { affects: {} }],
    ['empty affects', { affects: [] }],
    ['duplicate affects', { affects: ['claim:a', 'claim:a'] }],
    ['duplicate evidence', { evidenceRefs: ['evidence:a', 'evidence:a'] }],
    ['duplicate actions', { actionRefs: ['action:a', 'action:a'] }],
    ['raw subject', { subject: { credential: PRIVATE } }],
    ['raw tool args', { args: { secret: PRIVATE } }],
    ['unknown field', { payload: PRIVATE }],
    ['wrong optional time', { validTimeRef: null }],
    ['empty optional time', { learnedTimeRef: '' }],
    ['unscoped detail', { detail: 'raw message' }],
  ])('refuses %s with a fixed non-echoing code', (_label, fields) => refusal([receipt(fields)]));

  it.each(['', ' ', ' ref:x', 'ref:x ', 'ref:x\n', 'ref:x\u0000', 'ref:with space', 1, null, {}])(
    'refuses malformed reference %s',
    (id) => refusal([receipt({ id })]),
  );

  it.each([
    check({ disposition: 'pass' }),
    check({ disposition: undefined }),
    check({ reason: 'NO_MATCH' }),
    check({ checkRef: undefined }),
    check({ attemptRefs: {} }),
    check({ evidenceRefs: [PRIVATE, PRIVATE] }),
    check({ attemptRefs: ['attempt:1', 'attempt:1'] }),
    check({ action: { tool: PRIVATE } }),
  ])('refuses malformed nested checks', (row) => refusal([receipt({ checks: [row] })]));

  it('refuses duplicate result and check identities atomically', () => {
    refusal([receipt(), receipt()]);
    refusal([receipt({ checks: [check(), check()] })]);
    refusal([receipt(), receipt({ id: 'receipt:2', windowRef: PRIVATE, state: 'invalid' })]);
  });

  it('never calls object, field, element or optional getters, iterators or toJSON', () => {
    let calls = 0;
    const evil = () => {
      calls++;
      throw new Error(PRIVATE);
    };
    for (const key of ['id', 'detail', 'checks', 'validTimeRef']) {
      const input = receipt();
      Object.defineProperty(input, key, { get: evil, enumerable: true });
      refusal([input]);
    }
    const input = [receipt()];
    Object.defineProperty(input, 0, { get: evil, enumerable: true });
    refusal(input);
    const extra = receipt();
    Object.defineProperty(extra, 'toJSON', { get: evil });
    refusal([extra]);
    const iterator = [receipt()];
    Object.defineProperty(iterator, Symbol.iterator, { get: evil });
    refusal(iterator);
    expect(calls).toBe(0);
  });

  it('refuses custom prototypes, accessors on checks and cycles without recursion', () => {
    refusal([Object.assign(Object.create({ inherited: PRIVATE }), receipt())]);
    const rows = [receipt()];
    Object.setPrototypeOf(rows, { private: PRIVATE });
    refusal(rows);
    const loop = receipt();
    loop.checks.push(loop);
    refusal([loop]);
    const refs: unknown[] = [];
    refs.push(refs);
    refusal([receipt({ evidenceRefs: refs })]);
    const unknown = receipt();
    unknown.payload = unknown;
    refusal([unknown]);
  });

  it('translates throwing proxy metadata traps without reflecting their messages', () => {
    const trap = () => {
      throw new Error(PRIVATE);
    };
    for (const handler of [{ getPrototypeOf: trap }, { ownKeys: trap }, { getOwnPropertyDescriptor: trap }]) {
      refusal([new Proxy(receipt(), handler)]);
    }
  });

  it('refuses malformed array metadata, holes, expandos and prototypes', () => {
    refusal(new Array(1));
    const extra = [receipt()];
    Object.defineProperty(extra, 'secret', { value: PRIVATE });
    refusal(extra);
    for (const length of [NaN, -1, 0.5]) {
      const input = new Proxy([receipt()], {
        getOwnPropertyDescriptor(target, key) {
          const d = Reflect.getOwnPropertyDescriptor(target, key);
          return key === 'length' && d ? { ...d, value: length } : d;
        },
      });
      refusal(input);
    }
  });

  it('rejects array length changes between closed-shape inspection and indexed admission', () => {
    let reads = 0;
    const input = new Proxy<unknown[]>([], {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'length')
          return { ...Reflect.getOwnPropertyDescriptor(target, key)!, value: reads++ === 0 ? 0 : 1 };
        if (key === '0') return { value: receipt(), enumerable: true, configurable: true, writable: true };
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    refusal(input);
  });

  it('normalizes revoked list proxies at the top level and in nested lists', () => {
    const value = Proxy.revocable([], {});
    value.revoke();
    refusal(value.proxy);
    refusal([receipt({ checks: value.proxy })]);
    refusal([receipt({ evidenceRefs: value.proxy })]);
  });

  it('normalizes revocation during key inspection before the shared reader rechecks the array', () => {
    const revoking = () => {
      const value = Proxy.revocable<unknown[]>([], {
        ownKeys(target) {
          const keys = Reflect.ownKeys(target);
          value.revoke();
          return keys;
        },
      });
      return value.proxy;
    };
    refusal(revoking());
    refusal([receipt({ checks: revoking() })]);
    refusal([receipt({ evidenceRefs: revoking() })]);
    refusal([receipt({ checks: [check({ attemptRefs: revoking() })] })]);
  });

  it('does not inspect or rethrow an untrusted exception object', () => {
    let reads = 0;
    const exception = new Proxy(
      {},
      {
        getPrototypeOf() {
          reads++;
          throw new Error(PRIVATE);
        },
        get() {
          reads++;
          return PRIVATE;
        },
      },
    );
    refusal([
      new Proxy(receipt(), {
        ownKeys() {
          throw exception;
        },
      }),
    ]);
    expect(reads).toBe(0);
  });

  it('checks oversized array length before enumerating its keys', () => {
    let enumerations = 0;
    const input = new Proxy(new Array(513), {
      ownKeys() {
        enumerations++;
        throw new Error(PRIVATE);
      },
    });
    refusal(input, 'node-limit');
    expect(enumerations).toBe(0);
  });

  it('publishes fixed limits and enforces per-list and identifier bounds', () => {
    expect(REQUIREMENT_RESULT_LIMITS).toEqual({
      results: 512,
      checks: 16,
      affects: 32,
      refs: 16,
      name: 512,
      fields: 32768,
      characters: 1048576,
    });
    expect(Object.isFrozen(REQUIREMENT_RESULT_LIMITS)).toBe(true);
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `ref:${i}`);
    refusal(
      Array.from({ length: 513 }, (_, i) => receipt({ id: `receipt:${i}` })),
      'node-limit',
    );
    refusal(
      [receipt({ checks: Array.from({ length: 17 }, (_, i) => check({ checkRef: `check:${i}` })) })],
      'node-limit',
    );
    refusal([receipt({ affects: ids(33) })], 'node-limit');
    for (const key of ['evidenceRefs', 'actionRefs']) refusal([receipt({ [key]: ids(17) })], 'node-limit');
    refusal([receipt({ checks: [check({ attemptRefs: ids(17) })] })], 'node-limit');
    refusal([receipt({ id: 'r'.repeat(513) })]);
    expect(readRequirementResults([receipt({ id: 'r'.repeat(512) })])[0].id).toHaveLength(512);
  });

  it('shares one aggregate field budget and returns no partial results', () => {
    const rows = Array.from({ length: 512 }, (_, i) =>
      receipt({
        id: `receipt:${i}`,
        checks: Array.from({ length: 16 }, (_, j) => check({ checkRef: `check:${j}` })),
      }),
    );
    refusal(rows, 'node-limit');
  });

  it('shares one aggregate string budget across all reference lists and rows', () => {
    const rows = Array.from({ length: 512 }, (_, i) =>
      receipt({
        id: `receipt:${i}`,
        evidenceRefs: Array.from({ length: 16 }, (_, j) => `${i}:${j}:${'x'.repeat(490)}`),
      }),
    );
    refusal(rows, 'node-limit');
  });

  it('roundtrips independent bounded unresolved receipts without state inference', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({ min: 0, max: 10000 }), { maxLength: 20 }), (ids) => {
        const input = ids.map((id) => receipt({ id: `receipt:${id}`, reason: reasons[id % reasons.length] }));
        expect(readRequirementResults(input)).toEqual(input);
        expect(readRequirementResults(JSON.parse(JSON.stringify(input)))).toEqual(input);
      }),
      { numRuns: 100 },
    );
  });
});
