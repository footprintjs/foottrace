import { describe, expect, it } from 'vitest';
import { adjacency, AdmissionError } from './validation.js';

const reason = () => ({ code: 'redacted', nodeId: 'selected', evidence: ['proof:page'] });
const page = (gaps: unknown) => ({ edges: [], complete: true, gaps });

describe('directional page evidence admission', () => {
  it('preserves legacy own-key shape and explicit empty-page shape', () => {
    const legacy = adjacency({ edges: [], complete: false }, 5);
    expect(Object.keys(legacy)).toEqual(['edges', 'complete']);
    expect(Object.hasOwn(legacy, 'gaps')).toBe(false);
    expect(adjacency(page([]), 5)).toEqual({ edges: [], complete: true, gaps: [] });
    expect(Object.isFrozen(legacy)).toBe(true);
    expect(Object.isFrozen(legacy.edges)).toBe(true);
  });

  it('detaches and freezes each admitted reason and its references', () => {
    const source = reason(),
      supplied = [source];
    const admitted = adjacency(page(supplied), 5);
    source.evidence[0] = 'proof:changed';
    source.nodeId = 'changed';
    supplied.length = 0;
    expect(admitted.gaps).toEqual([reason()]);
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.gaps)).toBe(true);
    expect(Object.isFrozen(admitted.gaps![0])).toBe(true);
    expect(Object.isFrozen(admitted.gaps![0].evidence)).toBe(true);
  });

  it('charges all raw entries against the supplied remaining allowance', () => {
    const duplicate = reason();
    expect(adjacency(page([duplicate, duplicate]), 5, 2).gaps).toHaveLength(2);
    expect(() => adjacency(page([duplicate, duplicate]), 5, 1)).toThrow(AdmissionError);
    expect(adjacency(page([]), 5, 0).gaps).toEqual([]);
    expect(() => adjacency(page([duplicate]), 5, 0)).toThrow(AdmissionError);
  });

  it('refuses oversized pages before inspecting a hostile entry', () => {
    let reads = 0;
    const supplied = new Array(33);
    Object.defineProperty(supplied, '0', {
      get() {
        reads++;
        throw new Error('PRIVATE');
      },
    });
    expect(() => adjacency(page(supplied), 5)).toThrow('Invalid cause evidence');
    expect(reads).toBe(0);
  });

  for (const value of [
    null,
    {},
    new Array(1),
    [{ code: 'invented', evidence: [] }],
    [{ code: 'redacted', evidence: new Array(1) }],
    [{ code: 'redacted', evidence: Array(17).fill('proof:x') }],
    [{ code: 'redacted', evidence: ['x'.repeat(513)] }],
  ]) {
    it('refuses malformed, sparse or oversized evidence atomically', () => {
      expect(() => adjacency(page(value), 5)).toThrow('Invalid cause evidence');
    });
  }

  it('retains the exact existing reference boundaries', () => {
    const references = Array(16).fill('x'.repeat(512));
    expect(adjacency(page([{ code: 'redacted', evidence: references }]), 5).gaps![0].evidence).toEqual(references);
  });

  it('does not invoke page, reason or array-entry accessors', () => {
    let reads = 0;
    const descriptor = {
      get() {
        reads++;
        throw new Error('PRIVATE');
      },
    };
    const supplied = [reason()];
    Object.defineProperty(supplied, '0', descriptor);
    const item = Object.defineProperty({}, 'code', descriptor);
    const raw = Object.defineProperty({ edges: [], complete: true }, 'gaps', descriptor);
    for (const value of [raw, page([item]), page(supplied)])
      expect(() => adjacency(value, 5)).toThrow('Invalid cause evidence');
    expect(reads).toBe(0);
  });

  it('reads ordinary array slots without calling an iterator', () => {
    let reads = 0;
    const supplied = [reason()];
    Object.defineProperty(supplied, Symbol.iterator, {
      get() {
        reads++;
        throw new Error('PRIVATE');
      },
    });
    expect(adjacency(page(supplied), 5).gaps).toEqual([reason()]);
    expect(reads).toBe(0);
  });
});
