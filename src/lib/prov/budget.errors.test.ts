import { describe, expect, it } from 'vitest';
import { ProvDataRefusal, refusalCode } from './budget.js';
import { AdmissionError } from '../cause/validation.js';
import { RecordRefusal } from '../cause/recordValidation.js';

describe('PROV refusal identity', () => {
  it('does not inspect foreign errors', () => {
    let reads = 0;
    const error = new Proxy(
      {},
      {
        getPrototypeOf() {
          reads++;
          throw new Error('private');
        },
        get() {
          reads++;
          throw new Error('private');
        },
      },
    );
    let result: unknown;
    try {
      result = refusalCode(error);
    } catch {
      result = 'threw';
    }
    expect(result).toBe('invalid-data');
    expect(reads).toBe(0);
  });

  it('keeps its own family and subclasses distinct from cause admission', () => {
    class Bounded extends ProvDataRefusal {}
    expect(refusalCode(new Bounded('truncated'))).toBe('truncated');
    for (const error of [new AdmissionError('edge-limit'), new RecordRefusal('node-limit')]) {
      expect(refusalCode(error)).toBe('invalid-data');
    }
  });

  it('ignores forged prototypes and proxy wrappers', () => {
    const forged = Object.assign(Object.create(ProvDataRefusal.prototype), { code: 'truncated' });
    expect(refusalCode(forged)).toBe('invalid-data');
    expect(refusalCode(new Proxy(new ProvDataRefusal('truncated'), {}))).toBe('invalid-data');
  });

  it('uses the original closed code after mutation', () => {
    const error = new ProvDataRefusal('truncated');
    Object.defineProperty(error, 'code', { value: 'PRIVATE_CODE' });
    expect(refusalCode(error)).toBe('truncated');
  });
});
