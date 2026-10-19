/** A real JSON-LD processor checks representation only; it does not certify provenance truth. */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportProv } from '../../../src/prov.js';

type ExpandedNode = Record<string, unknown> & { '@id'?: string; '@type'?: string[] };
type JsonLdProcessor = {
  expand(input: unknown, options: { documentLoader: (url: string) => Promise<never> }): Promise<ExpandedNode[]>;
  toRDF(input: unknown, options: { documentLoader: (url: string) => Promise<never>; format: string }): Promise<string>;
};
const jsonld = createRequire(resolve(__dirname, '../../../package.json'))('jsonld') as JsonLdProcessor;
const PROV = 'http://www.w3.org/ns/prov#';
const FT = 'https://footprintjs.dev/ns/foottrace#';

function source() {
  return {
    initialState: { before: 0 },
    commitLog: [
      { runtimeStageId: 'seed#0', trace: [{ path: 'answer', verb: 'set', readKeys: [] }], overwrite: { answer: 1 } },
      {
        runtimeStageId: 'show#1',
        trace: [{ path: 'label', verb: 'set', readKeys: ['answer'] }],
        overwrite: { label: 'PRIVATE_PAYLOAD' },
      },
    ],
    executionTree: {
      runtimeStageId: 'seed#0',
      stageReads: {},
      next: { runtimeStageId: 'show#1', stageReads: { answer: 1 } },
    },
  };
}

describe('the PROV-O JSON-LD representation', () => {
  it('expands inline terms and generation links without a remote loader call', async () => {
    let requests = 0;
    const documentLoader = async (_url: string): Promise<never> => {
      requests++;
      throw new Error('NETWORK_FORBIDDEN');
    };
    const result = await exportProv(source(), { base: 'urn:example:jsonld/', values: 'none' });
    const expanded = await jsonld.expand(result.document, { documentLoader });
    expect(requests).toBe(0);
    const activities = expanded.filter((node) => node['@type']?.includes(PROV + 'Activity'));
    const entities = expanded.filter((node) => node['@type']?.includes(PROV + 'Entity'));
    expect(activities).toHaveLength(2);
    expect(entities).toHaveLength(2);
    const activityIds = new Set(activities.map((node) => node['@id']));
    for (const entity of entities) {
      const generations = entity[PROV + 'wasGeneratedBy'] as Array<{ '@id': string }>;
      expect(generations).toHaveLength(1);
      expect(activityIds.has(generations[0]['@id'])).toBe(true);
    }
    expect(JSON.stringify(expanded)).not.toContain('PRIVATE_PAYLOAD');
    expect(JSON.stringify(expanded)).not.toContain(PROV + 'startedAtTime');
    expect(JSON.stringify(expanded)).not.toContain(PROV + 'endedAtTime');
    expect(result.complete).toBe(false);
  });

  it('keeps candidate provenance extension-only when converted to RDF', async () => {
    const documentLoader = async (_url: string): Promise<never> => {
      throw new Error('NETWORK_FORBIDDEN');
    };
    const result = await exportProv(source(), { base: 'urn:example:jsonld/' });
    const expanded = await jsonld.expand(result.document, { documentLoader });
    const candidates = expanded.filter((node) => node['@type']?.includes(FT + 'PossibleDerivation'));
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate['@type']).not.toContain(PROV + 'Derivation');
      expect(candidate['@type']).not.toContain(PROV + 'Influence');
      expect(candidate[FT + 'source']).toBeDefined();
      expect(candidate[FT + 'target']).toBeDefined();
      expect(candidate[FT + 'attribution']).toEqual([{ '@value': 'reads-prefix' }]);
    }
    const rdf = await jsonld.toRDF(result.document, { documentLoader, format: 'application/n-quads' });
    for (const localName of ['wasDerivedFrom', 'wasInfluencedBy', 'qualifiedDerivation', 'used']) {
      expect(rdf).not.toContain('<' + PROV + localName + '>');
    }
    expect(rdf).toContain('<' + FT + 'possibleDerivation' + '>');
    expect(rdf).toContain('<' + PROV + 'wasGeneratedBy' + '>');
  });

  it('retains the count and position of redacted writes without exporting their names or values', async () => {
    const documentLoader = async (_url: string): Promise<never> => {
      throw new Error('NETWORK_FORBIDDEN');
    };
    const record = {
      commitLog: [
        {
          runtimeStageId: 'protect#0',
          trace: [{ path: 'SECRET_PATH', verb: 'set', readKeys: [] }],
          redactedPaths: ['SECRET_PATH'],
          overwrite: { SECRET_PATH: 'SECRET_VALUE' },
        },
      ],
    };
    const result = await exportProv(record, { base: 'urn:example:redacted/' });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('SECRET_PATH');
    expect(serialized).not.toContain('SECRET_VALUE');
    const expanded = await jsonld.expand(result.document, { documentLoader });
    const entities = expanded.filter((node) => node['@type']?.includes(PROV + 'Entity'));
    expect(entities).toHaveLength(1);
    expect(entities[0][FT + 'redacted']).toEqual([{ '@value': true }]);
    expect(entities[0][FT + 'commitIdx']).toEqual([{ '@value': 0 }]);
    expect(entities[0][FT + 'rowIdx']).toEqual([{ '@value': 0 }]);
  });

  it('expands recorded governing control as communication with a node-valued source', async () => {
    const documentLoader = async (_url: string): Promise<never> => {
      throw new Error('NETWORK_FORBIDDEN');
    };
    const result = await exportProv(
      {
        commitLog: [
          { runtimeStageId: 'decide#0', trace: [] },
          { runtimeStageId: 'chosen#1', trace: [] },
        ],
        controlDeps: { 'chosen#1': { deciderId: 'decide#0' } },
      },
      { base: 'urn:example:control/' },
    );
    const expanded = await jsonld.expand(result.document, { documentLoader });
    const activities = expanded.filter((node) => node['@type']?.includes(PROV + 'Activity'));
    const controlled = activities.find((node) => node[PROV + 'wasInformedBy'] !== undefined)!;
    const informed = controlled[PROV + 'wasInformedBy'] as Array<{ '@id': string }>;
    expect(informed).toHaveLength(1);
    expect(activities.some((node) => node['@id'] === informed[0]['@id'])).toBe(true);
    const communication = expanded.find((node) => node['@type']?.includes(PROV + 'Communication'))!;
    expect(communication[FT + 'relation']).toEqual([{ '@value': 'control' }]);
    expect(communication[PROV + 'activity']).toEqual(informed);
    expect(controlled[PROV + 'qualifiedCommunication']).toEqual([{ '@id': communication['@id'] }]);
  });

  it('keeps JSON-LD-looking and delimiter-looking path names as plain literal data', async () => {
    const documentLoader = async (_url: string): Promise<never> => {
      throw new Error('NETWORK_FORBIDDEN');
    };
    const paths = ['@context', '@id', 'a\u001f', '"</script>'];
    const result = await exportProv(
      {
        commitLog: [{ runtimeStageId: 'keys#0', trace: paths.map((path) => ({ path, verb: 'set', readKeys: [] })) }],
      },
      { base: 'urn:example:literal/' },
    );
    const expanded = await jsonld.expand(result.document, { documentLoader });
    const entities = expanded.filter((node) => node['@type']?.includes(PROV + 'Entity'));
    expect(entities).toHaveLength(paths.length);
    expect(entities.map((node) => node[FT + 'path'])).toEqual(paths.map((path) => [{ '@value': path }]));
    expect(new Set(entities.map((node) => node['@id'])).size).toBe(paths.length);
    expect(entities.every((node) => node['@id']?.startsWith('urn:example:literal/'))).toBe(true);
  });
});
