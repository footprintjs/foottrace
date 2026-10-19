import { describe, expect, it } from 'vitest';
import { ProvBudget } from '../../../src/lib/prov/budget.js';
import { provOptions } from '../../../src/lib/prov/options.js';

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
