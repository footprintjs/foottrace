import { describe, expect, it } from 'vitest';
import { explain } from '../../cause.js';
import { Session } from './session.js';
import { AdmissionError } from './validation.js';
import { RecordRefusal } from './recordValidation.js';
import type { CauseGraph } from './types.js';

const empty = () => ({ edges: [], complete: true });
const graph: CauseGraph = {
  parents: empty,
  children: empty,
  attention: () => [{ kind: 'error', reason: 'ERROR_RECORDED', evidence: ['proof:selected'] }],
  gaps: () => [],
};

/** D's nested-Proxy reproducer, with all foreign inspection counted rather than echoed. */
function hostile() {
  let reads = 0;
  const second = new Proxy(
    {},
    {
      getPrototypeOf() {
        reads++;
        throw new Error('PRIVATE_GRAPH_ERROR');
      },
    },
  );
  const first = new Proxy(
    {},
    {
      getPrototypeOf() {
        reads++;
        throw second;
      },
      get() {
        reads++;
        throw second;
      },
    },
  );
  return { error: first, reads: () => reads };
}

async function invoke(error: unknown, projection: boolean) {
  const session = new Session(graph);
  try {
    return await session
      .invoke(
        session.direction('backward'),
        'selected',
        () => {
          if (!projection) throw error;
          return {};
        },
        () => {
          throw error;
        },
      )
      .then(
        (value) => value,
        () => 'rejected',
      );
  } finally {
    session.dispose();
  }
}

describe('fixed cause refusal classification', () => {
  it('normalizes the inherited edge descriptor failure without inspecting its thrown object', async () => {
    const fixture = hostile();
    const page = new Proxy(empty(), {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'edges') throw fixture.error;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const result = await explain({ ...graph, parents: () => page }, 'selected', { includeBackward: true }).then(
      (value) => value,
      () => 'rejected',
    );
    expect(result).not.toBe('rejected');
    if (typeof result === 'string') return;
    expect(result.backward?.gaps).toEqual([{ code: 'invalid-data', nodeId: 'selected', evidence: [] }]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_GRAPH_ERROR');
    expect(fixture.reads()).toBe(0);
  });

  it.each([false, true])('keeps the work/projection fallback (projection=%s)', async (projection) => {
    const fixture = hostile();
    expect(await invoke(fixture.error, projection)).toEqual({
      gap: { code: projection ? 'invalid-data' : 'unavailable', nodeId: 'selected', evidence: [] },
    });
    expect(fixture.reads()).toBe(0);
  });

  it.each([false, true])('handles revoked thrown proxies (projection=%s)', async (projection) => {
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    expect(await invoke(revocable.proxy, projection)).toEqual({
      gap: { code: projection ? 'invalid-data' : 'unavailable', nodeId: 'selected', evidence: [] },
    });
  });

  it.each([null, undefined, 'PRIVATE_GRAPH_ERROR', 17, Symbol('private')])(
    'does not interpret primitive throws',
    async (error) => {
      expect(await invoke(error, true)).toEqual({
        gap: { code: 'invalid-data', nodeId: 'selected', evidence: [] },
      });
    },
  );

  it('ignores forged prototypes and code accessors', async () => {
    let reads = 0;
    const forged = Object.create(AdmissionError.prototype);
    Object.defineProperty(forged, 'code', {
      get() {
        reads++;
        throw new Error('private');
      },
    });
    expect(await invoke(forged, true)).toEqual({
      gap: { code: 'invalid-data', nodeId: 'selected', evidence: [] },
    });
    expect(reads).toBe(0);
  });

  it('captures legitimate subclass codes before a host can replace the field', async () => {
    class Bounded extends AdmissionError {}
    const error = new Bounded('edge-limit');
    let reads = 0;
    Object.defineProperty(error, 'code', {
      get() {
        reads++;
        throw new Error('private');
      },
    });
    expect(await invoke(error, true)).toEqual({
      gap: { code: 'edge-limit', nodeId: 'selected', evidence: [] },
    });
    expect(reads).toBe(0);
  });

  it('does not accept a wrapper or another refusal family as graph admission', async () => {
    for (const error of [new Proxy(new AdmissionError('edge-limit'), {}), new RecordRefusal('node-limit')]) {
      expect(await invoke(error, true)).toEqual({
        gap: { code: 'invalid-data', nodeId: 'selected', evidence: [] },
      });
    }
  });

  it('keeps ordinary host and projection Error fallbacks distinct', async () => {
    expect(await invoke(new Error('private'), false)).toMatchObject({ gap: { code: 'unavailable' } });
    expect(await invoke(new Error('private'), true)).toMatchObject({ gap: { code: 'invalid-data' } });
  });
  it('keeps native Promise rejection distinct from a fulfilled page projection failure', async () => {
    const fixture = hostile();
    const session = new Session(graph);
    try {
      const budget = session.direction('backward');
      const failure = await session.invoke(
        budget,
        'selected',
        () => Promise.resolve({}),
        () => {
          throw fixture.error;
        },
      );
      expect(failure).toEqual({ gap: { code: 'invalid-data', nodeId: 'selected', evidence: [] } });
      const rejected = await session.invoke(
        budget,
        'other',
        () => Promise.reject(new AdmissionError('node-limit')),
        () => 1,
      );
      expect(rejected).toEqual({ gap: { code: 'unavailable', nodeId: 'other', evidence: [] } });
      expect(fixture.reads()).toBe(0);
    } finally {
      session.dispose();
    }
  });

  it('does not reflect on a thrown callable proxy', async () => {
    let reads = 0;
    const error = new Proxy(() => undefined, {
      getPrototypeOf() {
        reads++;
        throw new Error('private');
      },
    });
    expect(await invoke(error, true)).toEqual({ gap: { code: 'invalid-data', nodeId: 'selected', evidence: [] } });
    expect(reads).toBe(0);
  });
});
