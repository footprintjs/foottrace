import { describe, expect, it } from 'vitest';
import { createRecordGraph, createStoredRecordGraph } from '../../cause.js';
import { createRecordScopeLoader } from './recordLoading.js';
import { nodeIdFor, resolveRecordNode } from './recordIdentity.js';
import { RecordRefusal, projectLoaded } from './recordValidation.js';
import { AdmissionError } from './validation.js';
import type { RecordScopeHost } from './recordTypes.js';

const address = { logRunId: 'r', drillPath: [] };
const context = { signal: new AbortController().signal };
const limits = { maxCommits: 16, maxFields: 100, maxEdges: 16, maxScopes: 4, loadTimeoutMs: 1000 };
const unavailable = { failure: 'unavailable' };

function opaque() {
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
  return { error, reads: () => reads };
}

describe('record boundary refusal identity', () => {
  it.each([false, true])('normalizes opaque host throws and rejections (async=%s)', async (async) => {
    const fixture = opaque();
    const host: RecordScopeHost = () => {
      if (async) return Promise.reject(fixture.error);
      throw fixture.error;
    };
    const loader = createRecordScopeLoader(host, limits);
    const result = await loader.loadScope(address, context).then(
      (value) => value,
      () => 'rejected',
    );
    expect(result).toEqual(unavailable);
    expect(fixture.reads()).toBe(0);
  });

  it('keeps legitimate record subclass codes and ignores replacement accessors', async () => {
    class Bounded extends RecordRefusal {}
    const error = new Bounded('node-limit');
    let reads = 0;
    Object.defineProperty(error, 'code', {
      get() {
        reads++;
        throw new Error('private');
      },
    });
    const loader = createRecordScopeLoader(() => {
      throw error;
    }, limits);
    expect(await loader.loadScope(address, context)).toEqual({ failure: 'node-limit' });
    expect(reads).toBe(0);
  });

  it('does not promote graph refusals or proxy wrappers to record refusals', async () => {
    for (const error of [new AdmissionError('edge-limit'), new Proxy(new RecordRefusal('node-limit'), {})]) {
      const loader = createRecordScopeLoader(() => {
        throw error;
      }, limits);
      expect(await loader.loadScope(address, context)).toEqual(unavailable);
    }
  });

  it('retains fixed invalid-data for malformed admitted scope data', async () => {
    const loader = createRecordScopeLoader(() => ({ scope: {} } as never), limits);
    expect(await loader.loadScope(address, context)).toEqual({ failure: 'invalid-data' });
  });

  it('normalizes opaque native-promise inspection errors at the record boundary', async () => {
    const fixture = opaque();
    const promise = Promise.resolve(1);
    const raw = new Proxy(promise, {
      getPrototypeOf() {
        throw fixture.error;
      },
    });
    const outcome = await projectLoaded(
      () => raw,
      (value) => value,
    ).then(
      () => 'resolved',
      (error) => (error === fixture.error ? 'original' : 'changed'),
    );
    expect(outcome).toBe('original');
    expect(fixture.reads()).toBe(0);
  });

  it('converts known graph observation refusals without reading a foreign code', async () => {
    const promise = Promise.resolve(1);
    Object.defineProperty(promise, 'constructor', { value: Promise });
    await expect(
      projectLoaded(
        () => promise,
        (value) => value,
      ),
    ).rejects.toMatchObject({
      code: 'invalid-data',
      message: 'cause: record unavailable',
    });
  });

  it('uses fixed invalid-data when node resolution encounters an opaque loader failure', async () => {
    const fixture = opaque();
    const result = await resolveRecordNode(nodeIdFor(address, { runtimeStageId: 'go#1', commitIdx: 0 }), context, {
      loadScope: async () => {
        throw fixture.error;
      },
      extraGapCodes: () => undefined,
    }).then(
      (value) => value,
      () => 'rejected',
    );
    expect(result).toEqual({ failure: 'invalid-data' });
    expect(fixture.reads()).toBe(0);
  });
});

describe.each([
  {
    name: 'memory',
    graph: (answer: unknown, maxFields?: number) =>
      createRecordGraph([{ address, commitLog: [commit(answer)] }], { maxFields }),
  },
  {
    name: 'storage',
    graph: (answer: unknown, maxFields?: number) =>
      createStoredRecordGraph(
        {
          loadLog: () => ({
            entries: [
              { kind: 'opened', address, at: 0, initialState: {} },
              { kind: 'commit', address, at: 1, bundle: commit(answer) },
              { kind: 'closed', address, at: 2, outcome: 'ok', commits: 1 },
            ],
          }),
        },
        { maxFields },
      ),
  },
])('$name refused record pages', ({ graph }) => {
  it.each([
    { code: 'node-limit', answer: Array.from({ length: 100 }, () => 1), maxFields: 64 },
    { code: 'invalid-data', answer: new Date(0), maxFields: undefined },
  ] as const)('returns one fixed $code gap in both directions', async ({ code, answer, maxFields }) => {
    const reader = graph(answer, maxFields);
    const selected = reader.nodeId(address, { runtimeStageId: 'go#1', commitIdx: 0, key: 'answer' });
    const gaps = [{ code, evidence: [] }];
    const refused = { edges: [], complete: false, gaps };
    expect(await reader.parents(selected, context)).toEqual(refused);
    expect(await reader.children(selected, context)).toEqual(refused);
    expect(await reader.gaps(selected, context)).toEqual(gaps);
  });
});

function commit(answer: unknown) {
  return {
    idx: 0,
    stage: 'go',
    stageId: 'go',
    runtimeStageId: 'go#1',
    overwrite: { answer },
    updates: {},
    trace: [{ path: 'answer', verb: 'set' }],
    redactedPaths: [],
  };
}
