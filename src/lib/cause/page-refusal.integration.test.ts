import { describe, expect, it } from 'vitest';
import { explain, type Adjacency, type CauseGraph } from '../../cause.js';

const empty = (): Adjacency => ({ edges: [], complete: true });

/** The failure itself is never inspected, including by assertion formatting on the rejected path. */
function foreignFailure(inspections: string[]): object {
  const terminal = new Error('PRIVATE_GRAPH_ERROR');
  const traps = (name: string, next: object): ProxyHandler<object> => ({
    getPrototypeOf() {
      inspections.push(`${name}:prototype`);
      throw next;
    },
    get() {
      inspections.push(`${name}:property`);
      throw next;
    },
    getOwnPropertyDescriptor() {
      inspections.push(`${name}:descriptor`);
      throw next;
    },
    ownKeys() {
      inspections.push(`${name}:keys`);
      throw next;
    },
  });
  const inner = new Proxy({}, traps('inner', terminal));
  return new Proxy({}, traps('outer', inner));
}

describe('directional page admission and private refusal identity compose', () => {
  for (const mode of ['gaps-descriptor', 'host-throw', 'native-rejection'] as const) {
    it(`returns the fixed ${mode === 'gaps-descriptor' ? 'invalid-data' : 'unavailable'} gap for ${mode}`, async () => {
      const inspections: string[] = [];
      const failure = foreignFailure(inspections);
      let descriptorReads = 0;
      const page = new Proxy(empty(), {
        getOwnPropertyDescriptor(target, key) {
          if (key === 'gaps') {
            descriptorReads++;
            throw failure;
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
      const graph: CauseGraph = {
        parents() {
          if (mode === 'host-throw') throw failure;
          if (mode === 'native-rejection') return Promise.reject(failure);
          return page;
        },
        children: empty,
        attention: () => [{ kind: 'error', reason: 'ERROR_RECORDED', evidence: ['proof:selected'] }],
        gaps: () => [],
      };
      const outcome = await explain(graph, 'selected', { includeBackward: true }).then(
        (value) => ({ returned: true as const, value }),
        () => ({ returned: false as const }),
      );
      expect(outcome.returned).toBe(true);
      expect(inspections).toEqual([]);
      if (!outcome.returned) return;
      const code = mode === 'gaps-descriptor' ? 'invalid-data' : 'unavailable';
      expect(outcome.value.backward?.gaps).toEqual([{ code, nodeId: 'selected', evidence: [] }]);
      expect(outcome.value.backward?.confidence).toBe('incomplete');
      expect(outcome.value.rootCause).toBeUndefined();
      expect(outcome.value.path).toEqual([]);
      expect(outcome.value.impact.gaps).toEqual([]);
      expect(outcome.value.impact.confidence).toBe('complete');
      expect(outcome.value.gaps).toEqual([{ code, nodeId: 'selected', evidence: [] }]);
      expect(descriptorReads).toBe(mode === 'gaps-descriptor' ? 1 : 0);
      expect(JSON.stringify(outcome.value)).not.toContain('PRIVATE_GRAPH_ERROR');
    });
  }
});
