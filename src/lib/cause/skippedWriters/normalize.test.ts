import { describe, expect, it } from 'vitest';

import { canonicalSnapshot } from '../../canonical-json/canonical.js';
import type { JsonValue } from '../../canonical-json/types.js';
import { normalizeSkippedChart } from './normalize.js';

const stage = (id: string, edges: readonly string[] = [], stageId = id) => ({ id, stageId, role: 'stage', edges });
const choose = {
  placementId: 'choose',
  kind: 'decider',
  choices: [
    { entry: 'keep', name: 'Keep', fallback: true },
    { entry: 'skip', name: 'Skip' },
  ],
  continuation: 'next',
};

const graph = (stages: readonly unknown[], controls: readonly unknown[] = [choose]) => ({ stages, controls });
const basic = [
  stage('choose', ['keep', 'skip', 'next']),
  stage('keep', ['next']),
  { ...stage('skip', ['next']), writes: ['stock'] },
  { ...stage('next'), role: 'join', writes: [] },
];
const normalize = (value: unknown, budget = { left: 1000 }) =>
  normalizeSkippedChart(canonicalSnapshot(value).value, budget);

describe('normalizeSkippedChart', () => {
  it('keeps graph edges, explicit continuation and absent versus empty write declarations', () => {
    const normalized = normalize(graph(basic));
    if (typeof normalized === 'string') throw new Error(normalized);
    expect(normalized.stages.get('skip')?.writes).toEqual(['stock']);
    expect(normalized.stages.get('next')?.writes).toEqual([]);
    expect(Object.hasOwn(normalized.stages.get('keep')!, 'writes')).toBe(false);
    expect(normalized.controlsByStage.get('choose')).toEqual([choose]);
  });

  it('groups distinct control placements reading the same static stage without selecting one', () => {
    const another = { ...choose, placementId: 'another', continuation: null };
    const normalized = normalize(graph([...basic, stage('another', ['keep', 'skip'], 'choose')], [choose, another]));
    if (typeof normalized === 'string') throw new Error(normalized);
    expect(normalized.controlsByStage.get('choose')).toEqual([choose, another]);
  });

  it('leaves display-name collisions for dispatch and preserves the recorded label spelling', () => {
    const control = { ...choose, choices: choose.choices.map((choice) => ({ ...choice, name: 'next\nstep' })) };
    const normalized = normalize(graph(basic, [control]));
    if (typeof normalized === 'string') throw new Error(normalized);
    expect(normalized.controlsByStage.get('choose')).toEqual([control]);
  });

  it.each([
    graph([...basic, stage('skip')]),
    graph(basic, [choose, choose]),
    graph(basic, [{ ...choose, choices: [choose.choices[0], choose.choices[0]] }]),
    graph(basic.slice(0, -1)),
    graph(basic, [{ placementId: 'choose', kind: 'decider', choices: choose.choices }]),
    graph(basic, [{ ...choose, continuation: 'missing' }]),
    graph(basic, [{ ...choose, choices: [...choose.choices, { entry: 'choose', name: 'Self' }] }]),
    graph(basic, [{ ...choose, choices: [...choose.choices, { entry: 'next', name: 'Next', fallback: true }] }]),
    graph(basic, [{ ...choose, kind: 'selector' }]),
    { ...graph(basic), executable: 'code' },
  ])('refuses missing or ambiguous topology %#', (value) => {
    expect(normalize(value)).toBe('graph-ambiguous');
  });

  it('requires every loop reference and a separate direct, nonloop exit', () => {
    const nodes = [
      ...basic.slice(0, 2),
      { ...stage('skip', ['choose']), role: 'loop-reference' },
      basic[3],
      stage('body'),
    ];
    const alternative = {
      entry: 'skip',
      name: 'Again',
      loopBack: { body: 'body', exit: 'keep', owner: 'choose' },
    };
    const bound = (loopBack: typeof alternative.loopBack) =>
      graph(nodes, [{ ...choose, choices: [choose.choices[0], { ...alternative, loopBack }] }]);
    expect(typeof normalize(bound(alternative.loopBack))).toBe('object');
    for (const loopBack of [
      { ...alternative.loopBack, exit: 'skip' },
      { ...alternative.loopBack, exit: 'next' },
      { ...alternative.loopBack, body: 'keep' },
      { ...alternative.loopBack, body: 'missing' },
      { ...alternative.loopBack, owner: 'missing' },
    ])
      expect(normalize(bound(loopBack))).toBe('graph-ambiguous');
    expect(
      normalize(
        graph(nodes, [
          {
            ...choose,
            choices: [{ ...choose.choices[0], loopBack: { ...alternative.loopBack, exit: 'skip' } }, alternative],
          },
        ]),
      ),
    ).toBe('graph-ambiguous');
  });

  it('does not call an accessor and accounts for the shared budget', () => {
    let called = false;
    const accessor = Object.create(null, {
      stages: {
        enumerable: true,
        get: () => {
          called = true;
          return [];
        },
      },
      controls: { enumerable: true, value: [] },
    }) as JsonValue;
    Object.freeze(accessor);
    expect(normalizeSkippedChart(accessor, { left: 1000 })).toBe('graph-ambiguous');
    expect(called).toBe(false);
    const budget = { left: 5 };
    expect(normalize(graph(basic), budget)).toBe('truncated');
    expect(budget.left).toBeLessThan(1);
  });
});
