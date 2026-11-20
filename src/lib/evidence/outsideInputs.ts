import { boundedList, ownData } from './admission.js';

/** Public names of inputs this execution's record cannot replay. */
export interface OutsideInputs {
  readonly declared?: readonly string[];
  /** Present when a native call actually started during the execution. */
  readonly call?: {
    readonly targets: readonly string[];
    readonly incomplete?: true;
  };
}

export interface OutsideInputAdmission {
  readonly outsideInputs?: OutsideInputs;
  /** A problem reading the optional evidence. The original value record may still be usable. */
  readonly outsideInputGap?: 'invalid-data' | 'node-limit';
}

const empty: OutsideInputAdmission = Object.freeze({});
const admitted = new WeakMap<object, OutsideInputAdmission>();
const descriptors = { translateTrapErrors: true, requireOwnValue: true };
// Match the engine's public attempt-name grammar. These strings reach text and JSON views.
const forbiddenName = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Co}\p{Noncharacter_Code_Point}]/u;

class OutsideInputRefusal extends Error {
  constructor(readonly code: NonNullable<OutsideInputAdmission['outsideInputGap']>) {
    super('Outside-input evidence refused');
  }
}

const refuse = (code?: string) => new OutsideInputRefusal(code === 'node-limit' ? code : 'invalid-data');
const own = (value: unknown, key: string): unknown => ownData(value, key, refuse, descriptors);

function names(value: unknown, maximum: number, charge?: (count: number) => void): readonly string[] {
  const values = boundedList(
    value,
    maximum,
    (name) => {
      try {
        charge?.(1);
      } catch {
        throw refuse('node-limit');
      }
      if (typeof name !== 'string' || name.length > 128 || !name.trim() || forbiddenName.test(name)) throw refuse();
      return name;
    },
    { refuse, overflow: 'node-limit', freeze: false, descriptors, translateArrayErrors: true },
  );
  return Object.freeze([...new Set(values)]);
}

/** Copy bounded own data fields while keeping a side-field refusal separate from the commit. */
export function readOutsideInputs(bundle: unknown, charge?: (count: number) => void): OutsideInputAdmission {
  if (!bundle || typeof bundle !== 'object') return empty;
  const held = admitted.get(bundle);
  if (held !== undefined) return held;
  try {
    let slot: PropertyDescriptor | undefined;
    try {
      slot = Object.getOwnPropertyDescriptor(bundle, 'outsideInputs');
    } catch {
      throw refuse();
    }
    if (!slot || own(bundle, 'phase') !== undefined) return empty;
    if (!Object.hasOwn(slot, 'value')) throw refuse();
    const raw: unknown = slot.value;
    if (raw === undefined) return empty;
    if (Array.isArray(raw)) throw refuse();
    const declared = own(raw, 'declared');
    const call = own(raw, 'call');
    const declaredNames = declared === undefined ? undefined : names(declared, 128, charge);
    let nativeCall: OutsideInputs['call'];
    if (call !== undefined) {
      if (Array.isArray(call)) throw refuse();
      const incomplete = own(call, 'incomplete');
      if (incomplete !== undefined && typeof incomplete !== 'boolean') throw refuse();
      nativeCall = Object.freeze({
        targets: names(own(call, 'targets'), 1_000, charge),
        ...(incomplete && { incomplete }),
      });
    }
    if (!declaredNames?.length && nativeCall === undefined) return empty;
    return Object.freeze({
      outsideInputs: Object.freeze({
        ...(declaredNames?.length && { declared: declaredNames }),
        ...(nativeCall !== undefined && { call: nativeCall }),
      }),
    });
  } catch (error) {
    return Object.freeze({ outsideInputGap: error instanceof OutsideInputRefusal ? error.code : 'invalid-data' });
  }
}

/** Carry an admission result through a reader's own normalized commit. */
export function carryOutsideInputs<T extends object>(target: T, admission: OutsideInputAdmission): T {
  if (admission.outsideInputs !== undefined) Object.assign(target, { outsideInputs: admission.outsideInputs });
  if (admission.outsideInputs !== undefined || admission.outsideInputGap !== undefined) admitted.set(target, admission);
  return target;
}
