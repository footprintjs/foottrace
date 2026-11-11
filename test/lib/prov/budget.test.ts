import { describe, expect, it } from 'vitest';
import { ProvBudget } from '../../../src/lib/prov/budget.js';
import { provOptions } from '../../../src/lib/prov/options.js';
import { ProvOutput } from '../../../src/lib/prov/output.js';
import { ProvIds } from '../../../src/lib/prov/ids.js';
import { exportProv } from '../../../src/prov.js';

describe('specific export limit evidence', () => {
  it.each([
    'maxCommits',
    'maxRows',
    'maxReads',
    'maxFields',
    'maxNodes',
    'maxRelations',
    'maxStringBytes',
    'maxOutputBytes',
    'maxDepth',
    'maxWork',
  ])('does not silently replace a null %s ceiling with the default', (key) => {
    expect(() => provOptions({ base: 'urn:test:limits/', [key]: null } as never)).toThrow();
  });
  it.each([
    ['fields', 'maxFields'],
    ['rows', 'maxRows'],
    ['reads', 'maxReads'],
    ['nodes', 'maxNodes'],
    ['relations', 'maxRelations'],
    ['stringBytes', 'maxStringBytes'],
    ['work', 'maxWork'],
  ] as const)('names the %s allowance that refused work', (kind, option) => {
    const limits = provOptions({ base: 'urn:test:limits/' });
    const budget = new ProvBudget(limits);
    expect(budget.spend(kind, limits[option] + 1)).toBe(false);
    expect(budget.gaps).toContainEqual({ code: 'truncated', reason: 'export ' + option + ' limit reached' });
  });
});

describe('work accounting proportional to the work done', () => {
  const truncations = (result: Awaited<ReturnType<typeof exportProv>>) =>
    result.gaps.filter((gap) => gap.code === 'truncated').map((gap) => gap.reason);
  it('charges the read index once, not once per read key', async () => {
    const commitLog = Array.from({ length: 1000 }, (_, i) => ({
      runtimeStageId: 's#' + i,
      trace: [
        {
          path: 'k' + i,
          verb: 'set',
          readKeys: Array.from({ length: Math.min(i, 5) }, (_, j) => 'k' + (i - 1 - j)),
        },
      ],
    }));
    const result = await exportProv(
      { commitLog },
      { base: 'urn:test:reads/', maxWork: 2000000, maxOutputBytes: 16777216 },
    );
    expect(result.document['@graph'].filter((node) => node['@type'] === 'ft:Read')).toHaveLength(4985);
    expect(truncations(result)).toEqual([]);
  });
  it('does not charge serialized output bytes as work under the default limits', async () => {
    const commitLog = Array.from({ length: 1000 }, (_, i) => ({
      runtimeStageId: 's#' + i,
      trace: [{ path: 'k' + i, verb: 'set' }],
    }));
    const result = await exportProv({ commitLog }, { base: 'urn:test:work/' });
    expect(result.document['@graph'].filter((node) => node['@type'] === 'prov:Entity')).toHaveLength(1000);
    expect(truncations(result)).toEqual([]);
  });
  it('reports the output limit only when the byte ceiling refused the node', () => {
    const budget = new ProvBudget(provOptions({ base: 'urn:test:limits/', maxNodes: 1 })),
      output = new ProvOutput(budget);
    expect(output.add({ '@id': 'urn:test:0' })).toBe(true);
    expect(output.add({ '@id': 'urn:test:1' })).toBe(false);
    expect(budget.gaps).toContainEqual({ code: 'truncated', reason: 'export maxNodes limit reached' });
    expect(budget.gaps.some((gap) => gap.reason === 'export output limit reached')).toBe(false);
  });
});

describe('PROV identifier families', () => {
  it('names an observed read by its ordinal under the scope prefix', () => {
    const ids = new ProvIds('urn:test:ids/', { logRunId: 'run', drillPath: [] });
    expect(ids.observedRead(7)).toBe('urn:test:ids/scope/3:run/observed-read/7');
    expect(ids.observedRead(7)).toBe(ids.prefix + 'observed-read/' + 7);
  });
});
