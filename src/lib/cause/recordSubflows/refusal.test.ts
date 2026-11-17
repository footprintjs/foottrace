import { describe, expect, it } from 'vitest';
import { createRecordGraph } from '../../../cause.js';
import { RecordRefusal } from '../recordValidation.js';
import { AdmissionError } from '../validation.js';
import { prepareRecordSubflows } from './admission.js';

const address = { logRunId: 'refusal-run', drillPath: [] as string[] };
const inventory = () => ({ version: 1, status: 'captured', mounts: [], collections: [] });

/** Box the outcome so a failing assertion never formats an unknown thrown value. */
function prepare(value: unknown) {
  try {
    return { returned: true as const, value: prepareRecordSubflows(value, address, [], { left: 100 }, 32) };
  } catch {
    return { returned: false as const };
  }
}

function opaque(inspections: string[]) {
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
  const inner = new Proxy({}, traps('inner', new Error('PRIVATE_SUBFLOW_ERROR')));
  return new Proxy({}, traps('outer', inner));
}

function failingInventory(error: unknown, trap: 'getPrototypeOf' | 'ownKeys' | 'getOwnPropertyDescriptor') {
  return new Proxy(inventory(), {
    [trap]() {
      throw error;
    },
  });
}

describe('optional subflow refusal identity', () => {
  it.each(['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor'] as const)(
    'contains an opaque %s failure without inspecting the thrown object',
    (trap) => {
      const inspections: string[] = [];
      const outcome = prepare(failingInventory(opaque(inspections), trap));
      expect(outcome.returned).toBe(true);
      expect(inspections).toEqual([]);
      if (outcome.returned) expect(outcome.value).toEqual({ gaps: ['invalid-data'] });
    },
  );

  it.each(['accessor', 'replacement', 'prototype'] as const)(
    'keeps the minted record code despite public %s mutation',
    (mutation) => {
      class Bounded extends RecordRefusal {}
      const error = new Bounded('node-limit');
      let reads = 0;
      if (mutation === 'accessor')
        Object.defineProperty(error, 'code', {
          get() {
            reads++;
            throw new Error('PRIVATE_CODE');
          },
        });
      if (mutation === 'replacement') Object.defineProperty(error, 'code', { value: 'unavailable' });
      if (mutation === 'prototype') Object.setPrototypeOf(error, null);
      const outcome = prepare(failingInventory(error, 'ownKeys'));
      expect(outcome.returned).toBe(true);
      expect(reads).toBe(0);
      if (outcome.returned) expect(outcome.value).toEqual({ gaps: ['node-limit'] });
    },
  );

  it('retains a valid empty optional inventory', () => {
    const value = inventory();
    expect(prepare(value)).toEqual({ returned: true, value: { record: value, gaps: [] } });
  });

  it.each([
    ['graph-family refusal', () => new AdmissionError('edge-limit')],
    ['forged prototype', () => Object.assign(Object.create(RecordRefusal.prototype), { code: 'node-limit' })],
    ['proxy wrapper', () => new Proxy(new RecordRefusal('node-limit'), {})],
  ] as const)('does not promote a %s to a record refusal', (_, failure) => {
    const outcome = prepare(failingInventory(failure(), 'ownKeys'));
    expect(outcome.returned).toBe(true);
    if (outcome.returned) expect(outcome.value).toEqual({ gaps: ['invalid-data'] });
  });

  it('preserves local dependency evidence when optional metadata throws an opaque value', async () => {
    const inspections: string[] = [];
    const commitLog = ['source', 'result'].map((key, idx) => ({
      idx,
      runtimeStageId: `step#${idx}`,
      stageId: `step#${idx}`,
      stage: `step#${idx}`,
      trace: [{ path: key, verb: 'set' as const, readKeys: idx ? ['source'] : [] }],
      overwrite: { [key]: idx },
      updates: {},
      redactedPaths: [],
    }));
    const graph = createRecordGraph([
      {
        address,
        commitLog,
        complete: true,
        reads: { 'step#0': [], 'step#1': ['source'] },
        controlDeps: {},
        attention: {},
        subflows: failingInventory(opaque(inspections), 'ownKeys') as never,
      },
    ]);
    const source = graph.nodeId(address, { runtimeStageId: 'step#0', commitIdx: 0, key: 'source' });
    const target = graph.nodeId(address, { runtimeStageId: 'step#1', commitIdx: 1, key: 'result' });
    const context = { signal: new AbortController().signal };
    const outcome = await Promise.all([graph.parents(target, context), graph.gaps(target, context)]).then(
      (value) => ({ returned: true as const, value }),
      () => ({ returned: false as const }),
    );
    expect(outcome.returned).toBe(true);
    expect(inspections).toEqual([]);
    if (!outcome.returned) return;
    const [parents, gaps] = outcome.value;
    expect(parents.edges.map((edge) => edge.nodeId)).toEqual([source]);
    expect(parents.complete).toBe(false);
    expect(gaps).toEqual([{ code: 'invalid-data', evidence: [] }]);
    expect(JSON.stringify(outcome.value)).not.toContain('PRIVATE_SUBFLOW_ERROR');
  });
});
