/**
 * Finite public-API byte witnesses captured from unchanged 4899960 source, before A1–A4 restructuring.
 * Foottrace #100 updates only record/preparation-limit: both pages carry the loader's node-limit gap,
 * so explain can report that reason without also adding the generic not-collected gap.
 * The named root-strategy rows below remove only the investigated node from alternatives.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as cause from '../../src/cause.js';
import { capturePublicBehavior, PRIVATE_SENTINEL, type PublicCase } from './fixtures/structure-probe.js';

interface Baseline {
  schemaVersion: number;
  sourceCommit: string;
  sourceTree: string;
  sourceSubtree: string;
  captureCheckoutCommit: string;
  captureCheckoutTree: string;
  cases: PublicCase[];
}
const baseline = JSON.parse(
  readFileSync(new URL('./fixtures/structure-equivalence.json', import.meta.url), 'utf8'),
) as Baseline;

const selfAlternativeCases = new Map<string, 'explanation' | 'result' | 'root'>([
  ['record/unfinished', 'explanation'],
  ['record/untracked', 'explanation'],
  ['record/redacted', 'explanation'],
  ['record/adjacency-limit', 'explanation'],
  ['graph/adjacency-getter', 'result'],
  ['admission/graph-edge-overflow', 'root'],
  ['ranking/foreign-root', 'root'],
  ['ranking/missing-score', 'root'],
  ['cancellation/during-dispatch', 'root'],
  ['timeout/synchronous-port', 'root'],
]);

function expectedBytes(testCase: PublicCase): string {
  const location = selfAlternativeCases.get(testCase.name);
  if (!location) return testCase.json;
  type AlternativeFields = { nodeId: string; alternatives: string[] };
  const value = JSON.parse(testCase.json) as AlternativeFields & Record<'explanation' | 'result', AlternativeFields>;
  const explanation = location === 'root' ? value : value[location];
  expect(explanation.alternatives, testCase.name).toContain(explanation.nodeId);
  explanation.alternatives = explanation.alternatives.filter((id) => id !== explanation.nodeId);
  return JSON.stringify(value);
}

describe('A1–A4 structure-only public behavior witnesses', () => {
  it('matches the exact public JSON bytes and order of the captured baseline cases', async () => {
    expect(baseline.schemaVersion).toBe(1);
    expect(baseline.sourceCommit).toBe('4899960d639b18b75e914cf7bde410ca1ca4b2c1');
    expect(baseline.sourceTree).toBe('0dbf0dfb5c45ff3cef81920a57ff5199ed7fdc70');
    expect(baseline.sourceSubtree).toBe('c37f5933cc6bc22bbe8d4bce8ada0b1b2aa6fa01');
    expect(baseline.captureCheckoutCommit).toBe('750ba2f103f97784c22f97a4e5c101e461ad934f');
    expect(baseline.captureCheckoutTree).toBe(baseline.sourceTree);
    const actual = await capturePublicBehavior(cause);
    expect(actual.map((item) => item.name)).toEqual(baseline.cases.map((item) => item.name));
    for (let index = 0; index < actual.length; index++) {
      expect(actual[index].json, actual[index].name).toBe(expectedBytes(baseline.cases[index]));
      expect(actual[index].json, actual[index].name).not.toContain(PRIVATE_SENTINEL);
    }
  });

  it('pins meaningful provenance and admission distinctions, rather than only empty outputs', () => {
    const output = (name: string) => JSON.parse(baseline.cases.find((item) => item.name === name)!.json);
    const perWrite = output('record/per-write-separated-identities');
    expect(perWrite.x).not.toBe(perWrite.y);
    expect(perWrite.xParents.edges).toHaveLength(1);
    expect(perWrite.yParents.edges).toHaveLength(2);
    expect(output('record/per-write-explain').rootCause).toContain('a#0');
    expect(output('record/step-conservative').confidence).toBe('incomplete');
    expect(output('record/readonly-data-and-control').parents.edges.map((edge: { kind: string }) => edge.kind)).toEqual(
      ['data', 'control'],
    );
    expect(output('record/payload-getter').getterReads).toBe(0);
    expect(output('admission/record-path-separator')).toEqual([]);
    expect(output('admission/graph-id-separator').status).toBe('rejected');
    expect(output('admission/graph-id-2048').confidence).toBe('complete');
    expect(output('admission/graph-id-2049').status).toBe('rejected');
    expect(output('admission/record-runtime-id-1024').gaps).toEqual([]);
    expect(output('admission/record-runtime-id-1025').gaps).toEqual([{ code: 'invalid-data', evidence: [] }]);
    expect(output('admission/record-list-overflow')).toEqual([{ code: 'node-limit', evidence: [] }]);
    expect(
      output('admission/graph-edge-overflow').gaps.some((gap: { code: string }) => gap.code === 'edge-limit'),
    ).toBe(true);
    expect(output('storage/lazy-one-scope').beforeLoads).toBe(0);
    expect(output('storage/lazy-one-scope').loads).toHaveLength(1);
    expect(output('record-and-facade/freeze-shapes').result).toBe(true);
    const mutation = output('record/input-mutation-after-preparation');
    expect(mutation.after).toBe(mutation.before);
    expect(output('timeout/stored-load').code).toBe('timeout');
  });
});
