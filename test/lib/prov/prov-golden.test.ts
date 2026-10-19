/** Exact new exporter pins complement semantic tests; established record/cause fixtures stay untouched. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportProv } from '../../../src/prov.js';
import { nativeCompoundSource, recordContractSource } from '../../fixtures/prov/records.js';

const fixture = (name: string) => readFileSync(resolve(__dirname, '../../fixtures/prov', name + '.json'), 'utf8');
const serialize = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const typed = (result: Awaited<ReturnType<typeof exportProv>>, type: string) =>
  result.document['@graph'].filter((node) => node['@type'] === type);

function honest(result: Awaited<ReturnType<typeof exportProv>>): void {
  const text = serialize(result);
  expect(result.complete).toBe(false);
  expect(result.gaps.some((gap) => gap.code === 'not-collected')).toBe(true);
  expect(text).not.toMatch(
    /prov:wasDerivedFrom|prov:wasInfluencedBy|prov:used|prov:qualifiedDerivation|prov:value|valueDigest|startedAtTime|endedAtTime|wasAssociatedWith/,
  );
}

describe('new PROV exact envelope fixtures', () => {
  it('pins the guide record without inventing missing native capture or intermediate value facts', async () => {
    const result = await exportProv(recordContractSource, { base: 'urn:example:prov:record-contract/' });
    honest(result);
    expect(typed(result, 'prov:Activity')).toHaveLength(3);
    expect(typed(result, 'ft:Commit')).toHaveLength(3);
    expect(typed(result, 'prov:Entity')).toHaveLength(3);
    expect(typed(result, 'prov:Entity').filter((node) => node['ft:deleted'] === true)).toHaveLength(1);
    expect(result.gaps).toContainEqual({
      code: 'not-checked',
      commitIdx: 1,
      rowIdx: 0,
      reason: 'final value reconstruction is outside stage one',
    });
    expect(serialize(result)).toBe(fixture('record-contract'));
  });

  it('pins decider, loop, mount continuation and hidden occurrences while refusing the child scope', async () => {
    const result = await exportProv(nativeCompoundSource, { base: 'urn:example:prov:native-compound/' });
    honest(result);
    expect(typed(result, 'prov:Activity')).toHaveLength(5);
    expect(typed(result, 'ft:Commit')).toHaveLength(6);
    const entities = typed(result, 'prov:Entity');
    expect(entities).toHaveLength(6);
    expect(new Set(entities.map((node) => node['@id'])).size).toBe(6);
    expect(entities.filter((node) => node['ft:commitIdx'] === 1).map((node) => node['ft:rowIdx'])).toEqual([0, 1]);
    expect(typed(result, 'ft:Commit').find((node) => node['ft:commitIdx'] === 4)?.['ft:phase']).toBe('exit');
    expect(typed(result, 'prov:Communication')).toHaveLength(1);
    expect(typed(result, 'prov:Activity').filter((node) => node['ft:untrackedInput'] === true)).toHaveLength(1);
    expect(result.gaps.some((gap) => gap.code === 'untracked-input')).toBe(true);
    expect(result.gaps.some((gap) => gap.code === 'scope-boundary')).toBe(true);
    expect(result.gaps).toContainEqual({
      code: 'ambiguous',
      commitIdx: 1,
      rowIdx: 0,
      reason: 'intermediate write value was not retained',
    });
    expect(
      entities.filter((node) => node['ft:redacted'] === true).map((node) => [node['ft:commitIdx'], node['ft:rowIdx']]),
    ).toEqual([[5, 0]]);
    expect(serialize(result)).not.toMatch(
      /private-contact|SECRET_CUSTOMER_EMAIL|GO_PRIVATE_PAYLOAD|EXTERNAL_RESULT_PRIVATE_PAYLOAD|child-secret|child#0/,
    );
    expect(typed(result, 'ft:PossibleDerivation').length).toBeGreaterThan(0);
    expect(serialize(result)).toBe(fixture('native-compound'));
  });
});
