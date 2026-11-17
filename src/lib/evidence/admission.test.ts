import { describe, expect, it } from 'vitest';
import { EvidenceRefusal, evidenceRefusalCode } from './admission.js';
import { GAP_CODES, type GapCode } from './codes.js';

describe('private refusal identity registry', () => {
  it('retains every closed code for the exact constructed identity', () => {
    for (const code of Object.keys(GAP_CODES) as GapCode[]) {
      const error = new EvidenceRefusal(code, 'fixed');
      expect(evidenceRefusalCode(error)).toBe(code);
      expect(error).toBeInstanceOf(Error);
      expect(Object.keys(error)).toEqual(['code']);
      expect(Object.getOwnPropertySymbols(error)).toEqual([]);
      expect(error.message).toBe('fixed');
    }
  });

  it('preserves explicit families through legitimate derived constructors', () => {
    const family = Symbol();
    class Known extends EvidenceRefusal {
      constructor() {
        super('node-limit', 'fixed', family);
      }
    }
    class Derived extends Known {}
    const error = new Derived();
    expect(evidenceRefusalCode(error)).toBe('node-limit');
    expect(evidenceRefusalCode(error, family)).toBe('node-limit');
    expect(evidenceRefusalCode(error, Symbol())).toBeUndefined();
  });

  it('never records a runtime code outside the closed vocabulary', () => {
    const error = new EvidenceRefusal('PRIVATE_CODE' as GapCode, 'fixed');
    expect(evidenceRefusalCode(error)).toBeUndefined();
    Object.defineProperty(error, 'code', { value: 'node-limit' });
    expect(evidenceRefusalCode(error)).toBeUndefined();
  });

  it('does not consult a replaced prototype, message or code', () => {
    const error = new EvidenceRefusal('node-limit', 'fixed');
    let reads = 0;
    const getter = {
      get() {
        reads++;
        throw new Error('private');
      },
    };
    Object.defineProperties(error, { code: getter, message: getter });
    Object.setPrototypeOf(error, null);
    expect(evidenceRefusalCode(error)).toBe('node-limit');
    expect(reads).toBe(0);
  });

  it('refuses copied fields, forged prototypes and wrappers', () => {
    const error = new EvidenceRefusal('node-limit', 'fixed');
    expect(evidenceRefusalCode({ code: 'node-limit' })).toBeUndefined();
    expect(evidenceRefusalCode(Object.create(EvidenceRefusal.prototype))).toBeUndefined();
    expect(evidenceRefusalCode(new Proxy(error, {}))).toBeUndefined();
  });
});
