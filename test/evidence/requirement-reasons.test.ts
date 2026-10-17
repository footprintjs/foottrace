/** Public type, unit and boundary law: domain evidence reasons are a subset of the one gap registry. */
import { describe, expect, it } from 'vitest';

import { explain, type CauseGraph, type GapCode } from '../../src/cause.js';
import {
  readRequirementResults,
  RequirementValidationError,
  type RequirementCheck,
  type RequirementReason,
  type RequirementResult,
} from '../../src/index.js';

const expected = [
  'not-collected',
  'not-checked',
  'no-match',
  'ambiguous',
  'stale',
  'incompatible',
  'unsupported',
  'not-permitted',
  'unavailable',
  'invalid-data',
  'redacted',
  'timeout',
] as const;
const traversal = [
  'untracked-input',
  'conservative',
  'scope-boundary',
  'cancelled',
  'cycle',
  'node-limit',
  'depth-limit',
  'edge-limit',
  'call-limit',
  'truncated',
  'strategy-failed',
] as const;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type PublicReason = Assert<Equal<RequirementReason, (typeof expected)[number]>>;
type ResultReason = Assert<Equal<Extract<RequirementResult, { state: 'unresolved' }>['reason'], RequirementReason>>;
type CheckReason = Assert<Equal<RequirementCheck['reason'], RequirementReason | undefined>>;
type AdmissionCode = Assert<Equal<RequirementValidationError['code'], GapCode>>;
const typeWitness: [PublicReason, ResultReason, CheckReason, AdmissionCode] = [true, true, true, true];

const row = (reason: unknown, checkReason: unknown = 'not-checked') => ({
  id: 'result:1',
  requirementRef: 'policy:connection',
  findingRef: 'finding:1',
  windowRef: 'window:1',
  affects: ['claim:1'],
  state: 'unresolved',
  reason,
  evidenceRefs: [],
  checks: [{ checkRef: 'check:1', disposition: 'unreachable', reason: checkReason, evidenceRefs: [], attemptRefs: [] }],
  actionRefs: [],
  validTimeRef: 'time:valid',
  learnedTimeRef: 'time:learned',
});

describe('RequirementReason public subset', () => {
  it('exports the exact public subset without narrowing traversal/admission codes', () => {
    expect(typeWitness).toEqual([true, true, true, true]);
    expect(new RequirementValidationError('node-limit').code).toBe('node-limit');
  });

  it.each(expected)('admits %s as both requirement and check reason', (reason) => {
    const input = row(reason, reason);
    expect(readRequirementResults([input])).toEqual([input]);
  });

  for (const location of ['result', 'check'] as const) {
    it.each(traversal)(`refuses traversal code %s in the ${location} reason`, (reason) => {
      const input = location === 'result' ? row(reason) : row('not-checked', reason);
      expect(() => readRequirementResults([input])).toThrowError(RequirementValidationError);
      expect(() => readRequirementResults([input])).toThrowError('REQUIREMENT_RESULTS_INVALID');
    });
  }

  it.each([...expected, ...traversal])('retains %s in generic cause gaps', async (code) => {
    const graph: CauseGraph = {
      parents: () => ({ edges: [], complete: true }),
      children: () => ({ edges: [], complete: true }),
      attention: () => [],
      gaps: () => [{ code, evidence: ['gap:evidence'] }],
    };
    expect((await explain(graph, 'node:1')).gaps).toContainEqual({ code, evidence: ['gap:evidence'] });
  });
});
