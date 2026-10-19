import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { exportProv, ProvExportRefusal } from '../../../src/prov.js';

const options = { base: 'urn:test:run/' };
const step = (runtimeStageId: string, trace: unknown[] = [], rest = {}) => ({ runtimeStageId, trace, ...rest });
const kind = (result: Awaited<ReturnType<typeof exportProv>>, type: string) =>
  result.document['@graph'].filter((node) => node['@type'] === type);
const text = (value: unknown) => JSON.stringify(value);

describe('the bounded, value-free PROV exporter', () => {
  it('is asynchronous and never invents a run identity, producer, person or clock', async () => {
    const pending = exportProv({ commitLog: [step('idle#0')] }, options);
    expect(pending).toBeInstanceOf(Promise);
    const result = await pending;
    expect(kind(result, 'prov:Activity')).toHaveLength(1);
    expect(kind(result, 'prov:SoftwareAgent')).toEqual([]);
    expect(text(result)).not.toMatch(/startedAtTime|endedAtTime|wasAssociatedWith|logRunId|valueDigest/);
    expect(result.complete).toBe(false);
    expect(result.gaps.some((gap) => gap.code === 'not-collected')).toBe(true);
  });

  it('groups repeat and exit commits under one native execution without losing commit/phase pairing', async () => {
    const result = await exportProv({ commitLog: [step('mount#0'), step('mount#0', [], { phase: 'exit' })] }, options);
    expect(kind(result, 'prov:Activity')).toHaveLength(1);
    expect(kind(result, 'ft:Commit').map((node) => [node['ft:commitIdx'], node['ft:phase']])).toEqual([
      [0, undefined],
      [1, 'exit'],
    ]);
  });

  it('keeps each write occurrence and never reads retained final or intermediate values', async () => {
    let accesses = 0;
    const payload = Object.defineProperty({}, 'x', {
      get() {
        accesses++;
        throw new Error('secret');
      },
    });
    const record = {
      commitLog: [
        step(
          'write#0',
          [
            { path: 'x', verb: 'set' },
            { path: 'x', verb: 'set' },
          ],
          { overwrite: payload },
        ),
      ],
      get initialState() {
        accesses++;
        throw new Error('secret');
      },
    };
    const result = await exportProv(record, options);
    const entities = kind(result, 'prov:Entity');
    expect(entities).toHaveLength(2);
    expect(new Set(entities.map((node) => node['@id'])).size).toBe(2);
    expect(entities.map((node) => node['ft:rowIdx'])).toEqual([0, 1]);
    expect(entities.every((node) => typeof node['prov:wasGeneratedBy'] === 'object')).toBe(true);
    expect(accesses).toBe(0);
    expect(text(result)).not.toMatch(/secret|valueDigest|prov:value/);
  });

  it('records candidate reads without claiming derivation, influence or exact standard usage', async () => {
    const result = await exportProv(
      { commitLog: [step('constant#0', [{ path: 'answer', verb: 'set', readKeys: ['unused'] }])] },
      options,
    );
    expect(kind(result, 'ft:PossibleDerivation')).toHaveLength(1);
    expect(kind(result, 'ft:Read')).toHaveLength(1);
    expect(text(result)).not.toMatch(/prov:wasDerivedFrom|prov:wasInfluencedBy|prov:used|prov:qualifiedDerivation/);
    expect(result.gaps.some((gap) => gap.code === 'ambiguous')).toBe(true);
  });

  it.each([
    [
      'nested container',
      [
        step('seed#0', [{ path: 'cfg', verb: 'set' }]),
        step('child#1', [{ path: 'cfg\u001fb', verb: 'set' }]),
        step('read#2', [{ path: 'answer', verb: 'set', readKeys: ['cfg'] }]),
      ],
      'ambiguous',
      'intra-stage read version was not captured',
    ],
    [
      'unused prefix',
      [step('constant#0', [{ path: 'x', verb: 'set', readKeys: ['unused'] }])],
      'ambiguous',
      'intra-stage read version was not captured',
    ],
    [
      'own staged read',
      [step('self#0', [{ path: 'x', verb: 'set', readKeys: ['x'] }])],
      'ambiguous',
      'intra-stage read version was not captured',
    ],
    [
      'intermediate occurrence',
      [
        step('twice#0', [
          { path: 'x', verb: 'set' },
          { path: 'x', verb: 'set' },
        ]),
      ],
      'ambiguous',
      'intermediate write value was not retained',
    ],
    [
      'append patch',
      [step('append#0', [{ path: 'items', verb: 'append' }], { overwrite: { items: [2] } })],
      'not-checked',
      'final value reconstruction is outside stage one',
    ],
  ] as const)('retains an explicit gap for the %s uncertainty example', async (_name, commitLog, code, reason) => {
    const result = await exportProv({ initialState: { x: 0, items: [1] }, commitLog }, options);
    expect(result.complete).toBe(false);
    expect(result.gaps.some((gap) => gap.code === code && gap.reason === reason)).toBe(true);
    expect(text(result)).not.toMatch(/prov:wasDerivedFrom|prov:used|valueDigest/);
  });

  it('uses a tombstone for deletion without invalidating the historical value snapshot', async () => {
    const result = await exportProv({ commitLog: [step('forget#0', [{ path: 'x', verb: 'delete' }])] }, options);
    expect(kind(result, 'prov:Entity')[0]['ft:deleted']).toBe(true);
    expect(text(result)).not.toContain('wasInvalidatedBy');
  });

  it('applies later redaction to earlier occurrences and all read/attention references', async () => {
    const secret = 'private-account';
    const result = await exportProv(
      {
        commitLog: [
          step('first#0', [{ path: secret, verb: 'set' }]),
          step('later#1', [{ path: secret + '\u001fchild', verb: 'set', readKeys: [secret] }], {
            redactedPaths: [secret],
          }),
        ],
        attention: { 'first#0': [{ kind: 'error', reason: 'ERROR_RECORDED', evidence: [secret] }] },
      },
      options,
    );
    expect(text(result)).not.toContain(secret);
    expect(kind(result, 'prov:Entity').map((node) => node['ft:redacted'])).toEqual([true, true]);
    expect(kind(result, 'prov:Entity').map((node) => node['ft:commitIdx'])).toEqual([0, 1]);
    expect(result.gaps.some((gap) => gap.code === 'redacted')).toBe(true);
  });

  it('does not publish earlier path names when the omitted tail could contain a redaction', async () => {
    const result = await exportProv(
      {
        commitLog: [
          step('a#0', [{ path: 'hidden-tail', verb: 'set' }]),
          step('b#1', [], { redactedPaths: ['hidden-tail'] }),
        ],
      },
      { ...options, maxCommits: 1 },
    );
    expect(text(result)).not.toContain('hidden-tail');
    expect(result.gaps.some((gap) => gap.code === 'truncated')).toBe(true);
  });

  it('refuses hostile bundle accessors without calling them and preserves later original indexes', async () => {
    let called = 0;
    const hostile = Object.defineProperty({}, 'trace', {
      get() {
        called++;
        throw new Error('private-error');
      },
    });
    const result = await exportProv({ commitLog: [hostile, step('ok#1', [{ path: '', verb: 'set' }])] }, options);
    expect(called).toBe(0);
    expect(text(result)).not.toContain('private-error');
    expect(kind(result, 'prov:Entity')[0]['ft:commitIdx']).toBe(1);
    expect(result.gaps.some((gap) => gap.commitIdx === 0 && gap.code === 'invalid-data')).toBe(true);
  });

  it('never invents native execution zero for a historical non-execution seed', async () => {
    const result = await exportProv({ commitLog: [step('seed', [{ path: 'x', verb: 'set' }])] }, options);
    expect(kind(result, 'prov:Activity')).toEqual([]);
    expect(kind(result, 'prov:Entity')[0]['prov:wasGeneratedBy']).toBeUndefined();
    expect(result.gaps.some((gap) => gap.code === 'unsupported')).toBe(true);
  });

  it('does not trust serialized completeness or drill into another scope', async () => {
    const result = await exportProv(
      { complete: true, commitLog: [], subflowResults: { secret: { commitLog: [step('foreign#0')] } } },
      options,
    );
    expect(result.complete).toBe(false);
    expect(text(result)).not.toContain('foreign');
    expect(result.gaps.some((gap) => gap.code === 'scope-boundary')).toBe(true);
  });

  it.each(['reads', 'controlDeps'])('reports orphan %s evidence without inventing an execution', async (field) => {
    const value = field === 'reads' ? { 'absent#1': ['x'] } : { 'absent#1': { deciderId: 'a#0' } };
    const result = await exportProv({ commitLog: [step('a#0')], [field]: value }, options);
    expect(kind(result, 'prov:Activity')).toHaveLength(1);
    expect(result.gaps.some((gap) => gap.code === 'unavailable')).toBe(true);
  });

  it.each(['digest', 'raw'])('rejects the unsupported values mode %s with a coded refusal', async (values) => {
    await expect(exportProv({ commitLog: [] }, { ...options, values } as never)).rejects.toMatchObject({
      code: 'PROV_EXPORT_OPTIONS',
    });
  });

  it('rejects callback and extra-scope options without invoking them', async () => {
    let called = 0;
    await expect(
      exportProv({}, {
        ...options,
        agents: () => {
          called++;
        },
      } as never),
    ).rejects.toBeInstanceOf(ProvExportRefusal);
    await expect(exportProv({}, { ...options, scopes: [] } as never)).rejects.toMatchObject({
      code: 'PROV_EXPORT_OPTIONS',
    });
    expect(called).toBe(0);
  });

  it('bounds the entire returned envelope and reports truncation at the minimum byte budget', async () => {
    const result = await exportProv(
      {
        commitLog: Array.from({ length: 30 }, (_, i) =>
          step('write#' + i, [{ path: 'long-' + 'x'.repeat(100) + i, verb: 'set' }]),
        ),
      },
      { ...options, maxOutputBytes: 2048 },
    );
    expect(Buffer.byteLength(text(result), 'utf8')).toBeLessThanOrEqual(2048);
    expect(result.gaps.some((gap) => gap.code === 'truncated')).toBe(true);
    expect(result.complete).toBe(false);
  });

  it('keeps deterministic, collision-free occurrences for arbitrary well-formed key text', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(fc.string({ maxLength: 24 }), { minLength: 1, maxLength: 12 }), async (paths) => {
        const record = {
          commitLog: [
            step(
              'write#0',
              paths.map((path) => ({ path, verb: 'set' })),
            ),
          ],
        };
        const first = await exportProv(record, options);
        const second = await exportProv(record, options);
        expect(text(first)).toBe(text(second));
        expect(new Set(kind(first, 'prov:Entity').map((node) => node['@id'])).size).toBe(paths.length);
        expect(kind(first, 'prov:Entity').map((node) => node['ft:path'])).toEqual(paths);
      }),
      { numRuns: 60 },
    );
  });
});
