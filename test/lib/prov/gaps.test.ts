import { describe, expect, it } from 'vitest';
import { ProvBudget } from '../../../src/lib/prov/budget.js';
import { provOptions } from '../../../src/lib/prov/options.js';
import { ProvOutput } from '../../../src/lib/prov/output.js';
import { exportProv } from '../../../src/prov.js';

describe('gap summaries and reserved envelope accounting', () => {
  it('keeps first-observed reason ordering while counts cross decimal digit boundaries', () => {
    const budget = new ProvBudget(provOptions({ base: 'urn:test:counts/', maxOutputBytes: 2048 }));
    budget.summarizeGap('read-version');
    budget.addGap({ code: 'unsupported', commitIdx: 9 });
    const output = new ProvOutput(budget);
    for (let i = 0; i < 100; i++) if (!output.add({ '@id': 'urn:test:' + i })) break;
    for (let i = 1; i < 10000; i++) budget.summarizeGap('read-version');
    const result = output.finish();
    expect(result.gaps.slice(0, 2)).toEqual([
      { code: 'ambiguous', reason: 'intra-stage read version was not captured', count: 10000 },
      { code: 'unsupported', commitIdx: 9 },
    ]);
    expect(result.document['@graph'].length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(2048);
  });

  it('keeps overflow and output markers even after the report count cap is exhausted', () => {
    const budget = new ProvBudget(provOptions({ base: 'urn:test:slots/' }));
    for (let i = 0; i < 300; i++) budget.addGap({ code: 'unavailable', commitIdx: i });
    budget.outputLimitReached();
    const result = new ProvOutput(budget).finish();
    expect(result.gaps).toHaveLength(256);
    expect(result.gaps).toContainEqual({ code: 'truncated', reason: 'additional export gaps withheld', count: 46 });
    expect(result.gaps).toContainEqual({ code: 'truncated', reason: 'export output limit reached' });
  });

  it('keeps attention problems after routine coverage and reconstruction summaries', async () => {
    const result = await exportProv(
      {
        commitLog: Array.from({ length: 140 }, (_, i) => ({
          runtimeStageId: 'append#' + i,
          trace: [{ path: 'x', verb: 'append' }],
        })),
        attention: { 'append#139': [{ kind: 'error', reason: 'ERROR_RECORDED', evidence: ['unbound-reference'] }] },
      },
      { base: 'urn:test:attention/' },
    );
    expect(result.gaps).toContainEqual({
      code: 'not-permitted',
      reason: 'attention reference has no supported export binding',
    });
    expect(JSON.stringify(result)).not.toContain('unbound-reference');
  });

  it('looks up the actual commit index rather than the admitted-array position after a refused row', async () => {
    const result = await exportProv(
      {
        commitLog: [
          { runtimeStageId: 'seed#0', trace: [{ path: 'x', verb: 'set' }] },
          null,
          { runtimeStageId: 'read#2', trace: [{ path: 'answer', verb: 'set', readKeys: ['x'] }] },
        ],
      },
      { base: 'urn:test:lookup/' },
    );
    const nodes = result.document['@graph'];
    const writer = nodes.find((node) => node['@type'] === 'prov:Entity' && node['ft:commitIdx'] === 0);
    const read = nodes.find((node) => node['@type'] === 'ft:Read');
    expect(read?.['ft:candidateEntity']).toEqual({ '@id': writer?.['@id'] });
    expect(read?.['ft:basis']).toBe('candidate');
    expect(JSON.stringify(result)).not.toContain('prov:used');
  });
});
