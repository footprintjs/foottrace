import { expect, it } from 'vitest';
import { RecordFrame, SharedMemory } from '../../../write.js';

it('adds no caller-array iterator, getter or coercion calls to either existing read strategy', () => {
  for (const source of [false, true])
    for (const canonical of [false, true]) {
      const run = (located: boolean) => {
        const events: string[] = [];
        const trace = (items: string[], prefix: string) =>
          new Proxy(items, {
            get(target, key, receiver) {
              events.push(`${prefix}:${String(key)}`);
              return Reflect.get(target, key, receiver);
            },
          });
        const namespace = trace(['runs', 'one'], 'namespace');
        const path = trace(['cfg'], 'path');
        const state = new SharedMemory(undefined, { runs: { one: { cfg: { n: 7 } } } });
        const frame = new RecordFrame(state, undefined, namespace);
        frame.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix', nestedReadTracking: canonical });
        const privacy = () => {
          events.push('privacy');
          return 'visible' as const;
        };
        const owner = { runtimeStageId: 'read#0' };
        const result = located
          ? source
            ? frame.readWithLocation(path, 'n', owner, privacy).value
            : frame.readWithLocation(path, 'n').value
          : source
          ? frame.readWithSource(path, 'n', owner, privacy).value
          : frame.readTracked(path, 'n');
        expect(result).toBe(7);
        return events;
      };
      expect(run(true)).toEqual(run(false));
    }
});

it('keeps the consumed data-slot location when a Proxy value access mutates original inputs', () => {
  const namespace = ['runs', 'one'];
  const path = ['cfg'];
  const state = new SharedMemory(undefined, { runs: { one: { cfg: {} } } });
  const root = state.getState() as { runs: { one: { cfg: object } } };
  root.runs.one.cfg = new Proxy(
    { n: 7 },
    {
      get(target, key, receiver) {
        if (key === 'n') {
          namespace[1] = 'changed';
          path[0] = 'changed';
        }
        return Reflect.get(target, key, receiver);
      },
    },
  );
  const frame = new RecordFrame(state, undefined, namespace);
  const result = frame.readWithLocation(path, 'n');
  expect(result.value).toBe(7);
  expect(result.location).toEqual(['runs', 'one', 'cfg', 'n']);
});

it('propagates a foreign privacy error by identity without reflecting on it', () => {
  const inspected: string[] = [];
  const error = new Proxy(
    {},
    {
      get() {
        inspected.push('get');
        throw new Error('private');
      },
      getPrototypeOf() {
        inspected.push('prototype');
        throw new Error('private');
      },
    },
  );
  const frame = new RecordFrame(new SharedMemory(undefined, { n: 7 }));
  let caught: unknown;
  try {
    frame.readWithLocation([], 'n', { runtimeStageId: 'read#0' }, () => {
      throw error;
    });
  } catch (value) {
    caught = value;
  }
  expect(caught).toBe(error);
  expect(inspected).toEqual([]);
});
