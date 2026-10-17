import { boundedList, boundedName, EvidenceRefusal, ownData, spendFields } from './admission.js';
import { isGapCode, type GapCode } from './codes.js';
import type { RequirementCheck, RequirementCheckDisposition, RequirementResult } from './requirementTypes.js';

/** Fixed per-call ceilings; characters are UTF-16 code units, not serialized transport bytes. */
export const REQUIREMENT_RESULT_LIMITS = Object.freeze({
  results: 512,
  checks: 16,
  affects: 32,
  refs: 16,
  name: 512,
  fields: 32768,
  characters: 1048576,
});

/** No input, field value or originating exception is retained on a refusal. */
export class RequirementValidationError extends EvidenceRefusal {
  constructor(code: GapCode = 'invalid-data') {
    super(code, 'REQUIREMENT_RESULTS_INVALID');
  }
}
const refuse = (code?: GapCode): RequirementValidationError => new RequirementValidationError(code);
const descriptors = { translateTrapErrors: true, requireOwnValue: true };
const own = (value: unknown, key: string): unknown => ownData(value, key, refuse, descriptors);
const resultKeys = new Set([
  'id',
  'requirementRef',
  'findingRef',
  'windowRef',
  'affects',
  'state',
  'reason',
  'detail',
  'evidenceRefs',
  'checks',
  'actionRefs',
  'validTimeRef',
  'learnedTimeRef',
]);
const checkKeys = new Set(['checkRef', 'disposition', 'reason', 'detail', 'evidenceRefs', 'attemptRefs']);
const dispositions: ReadonlySet<string> = new Set<RequirementCheckDisposition>([
  'checked-pass',
  'checked-fail',
  'unreachable',
  'not-applicable',
]);
interface Budget {
  left: number;
  characters: number;
}

/** Closed objects expose no unknown payloads. Never invoke data accessors, iterators or toJSON. */
function object(value: unknown, keys: ReadonlySet<string>, budget: Budget): void {
  if (!value || typeof value !== 'object') throw refuse();
  let prototype: object | null;
  let fields: (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(value);
    fields = Reflect.ownKeys(value);
  } catch {
    throw refuse();
  }
  if (prototype !== Object.prototype && prototype !== null) throw refuse();
  if (fields.length > keys.size || fields.some((field) => typeof field !== 'string' || !keys.has(field)))
    throw refuse();
  spendFields(budget, fields.length, refuse);
  // Including optional own fields: an own accessor is never treated as an absent field.
  for (const field of fields) own(value, field as string);
}

function list<T>(value: unknown, maximum: number, read: (value: unknown) => T, budget: Budget): readonly T[] {
  try {
    if (!Array.isArray(value)) throw refuse();
  } catch {
    throw refuse();
  }
  const length = own(value, 'length');
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) throw refuse();
  if (length > maximum) throw refuse('node-limit');
  let prototype: object | null;
  let keys: (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw refuse();
  }
  if (prototype !== Array.prototype) throw refuse();
  if (
    keys.length !== length + 1 ||
    keys.some(
      (key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length),
    )
  )
    throw refuse();
  spendFields(budget, length + 1, refuse);
  return boundedList(value, maximum, read, {
    refuse,
    overflow: 'node-limit',
    freeze: true,
    descriptors,
    expectedLength: length,
    translateArrayErrors: true,
  });
}

function name(value: unknown, budget: Budget): string {
  const result = boundedName(value, REQUIREMENT_RESULT_LIMITS.name, refuse);
  if (/\s/u.test(result)) throw refuse();
  budget.characters -= result.length;
  if (budget.characters < 0) throw refuse('node-limit');
  return result;
}
function unique<T>(items: readonly T[], key: (item: T) => string): readonly T[] {
  if (new Set(items.map(key)).size !== items.length) throw refuse();
  return items;
}
function refs(value: unknown, budget: Budget, maximum: number = REQUIREMENT_RESULT_LIMITS.refs): readonly string[] {
  return unique(
    list(value, maximum, (item) => name(item, budget), budget),
    (item) => item,
  );
}
function reason(value: unknown): GapCode {
  if (!isGapCode(value)) throw refuse();
  return value;
}
function optionalName(value: unknown, key: string, budget: Budget): string | undefined {
  const raw = own(value, key);
  return raw === undefined ? undefined : name(raw, budget);
}
function detail(value: unknown, budget: Budget): string | undefined {
  const id = optionalName(value, 'detail', budget);
  if (id !== undefined && !/^[A-Za-z][A-Za-z0-9_.-]*:.+$/.test(id)) throw refuse();
  return id;
}
function check(value: unknown, budget: Budget): RequirementCheck {
  object(value, checkKeys, budget);
  const checkRef = name(own(value, 'checkRef'), budget),
    disposition = own(value, 'disposition');
  if (typeof disposition !== 'string' || !dispositions.has(disposition)) throw refuse();
  const rawReason = own(value, 'reason'),
    detailId = detail(value, budget);
  return Object.freeze({
    checkRef,
    disposition: disposition as RequirementCheckDisposition,
    ...(rawReason === undefined ? {} : { reason: reason(rawReason) }),
    ...(detailId === undefined ? {} : { detail: detailId }),
    evidenceRefs: refs(own(value, 'evidenceRefs'), budget),
    attemptRefs: refs(own(value, 'attemptRefs'), budget),
  });
}
function result(value: unknown, budget: Budget): RequirementResult {
  object(value, resultKeys, budget);
  const id = name(own(value, 'id'), budget),
    requirementRef = name(own(value, 'requirementRef'), budget),
    findingRef = name(own(value, 'findingRef'), budget),
    windowRef = name(own(value, 'windowRef'), budget),
    state = own(value, 'state'),
    rawReason = own(value, 'reason');
  if (state !== 'satisfied' && state !== 'unresolved') throw refuse();
  if (state === 'satisfied' && rawReason !== undefined) throw refuse();
  const affects = refs(own(value, 'affects'), budget, REQUIREMENT_RESULT_LIMITS.affects);
  if (!affects.length) throw refuse();
  const evidenceRefs = refs(own(value, 'evidenceRefs'), budget),
    checks = unique(
      list(own(value, 'checks'), REQUIREMENT_RESULT_LIMITS.checks, (item) => check(item, budget), budget),
      (item) => item.checkRef,
    ),
    actionRefs = refs(own(value, 'actionRefs'), budget),
    detailId = detail(value, budget),
    validTimeRef = optionalName(value, 'validTimeRef', budget),
    learnedTimeRef = optionalName(value, 'learnedTimeRef', budget);
  const binding = {
    id,
    requirementRef,
    findingRef,
    windowRef,
    affects,
    evidenceRefs,
    checks,
    actionRefs,
    ...(detailId === undefined ? {} : { detail: detailId }),
    ...(validTimeRef === undefined ? {} : { validTimeRef }),
    ...(learnedTimeRef === undefined ? {} : { learnedTimeRef }),
  };
  return Object.freeze(
    state === 'unresolved' ? { ...binding, state, reason: reason(rawReason) } : { ...binding, state },
  );
}

/**
 * Atomically project detached, frozen reference-only records. This is structural admission only.
 * The host must authenticate producers, resolve authorized artifacts, verify current query/run/scope and
 * domain validity, and enforce every unresolved affects reference before rendering any factual claim.
 * Identifier grammar does not classify secrets; producers must supply non-secret identifiers only.
 */
export function readRequirementResults(value: unknown): readonly RequirementResult[] {
  const budget: Budget = { left: REQUIREMENT_RESULT_LIMITS.fields, characters: REQUIREMENT_RESULT_LIMITS.characters };
  return unique(
    list(value, REQUIREMENT_RESULT_LIMITS.results, (item) => result(item, budget), budget),
    (item) => item.id,
  );
}
