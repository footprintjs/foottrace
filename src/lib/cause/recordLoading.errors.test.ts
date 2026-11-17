import { describe, expect, it } from 'vitest';
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
