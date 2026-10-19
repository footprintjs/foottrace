import { describe, expect, it } from 'vitest';
import { ProvIds } from '../../../src/lib/prov/ids.js';
import { translateCommit } from '../../../src/lib/prov/translateCommit.js';
import type { ProvCommitContext, ProvTranslation } from '../../../src/lib/prov/translation.js';
import type { AdmittedCommit } from '../../../src/lib/prov/types.js';

const ids = new ProvIds('urn:test:step/');
function commit(): AdmittedCommit {
  return {
    commitIdx: 4,
    bundle: {
      stage: 'Make',
      stageId: 'make',
      overwrite: {},
      updates: [],
      runtimeStageId: 'make#2',
      trace: [],
      redactedPaths: [],
      tags: ['first'],
      phase: 'exit',
    },
    rows: [
      { commitIdx: 4, rowIdx: 0, path: 'secret', verb: 'set', readKeys: [] },
      { commitIdx: 4, rowIdx: 1, path: 'secret', verb: 'delete' },
    ],
  };
}
function context(overrides: Partial<ProvCommitContext> = {}): ProvCommitContext {
  return {
    ids,
    activities: new Set(),
    hasUntrackedInput: () => false,
    scopeGaps: ['not-collected'],
    readGaps: (row) => (row.readKeys === undefined ? ['conservative', 'not-collected'] : []),
    hides: () => false,
    ...overrides,
  };
}
function drain(state: ProvCommitContext, entry: AdmittedCommit, accept = (_: ProvTranslation) => true) {
  const effects: ProvTranslation[] = [],
    iterator = translateCommit(state, entry);
  let next = iterator.next();
  while (!next.done) {
    effects.push(next.value);
    next = iterator.next(accept(next.value));
  }
  return effects;
}
const nodes = (effects: ProvTranslation[]) =>
  effects.flatMap((effect) => (effect.kind === 'node' ? [effect.node] : []));

describe('per-commit translation without a record or output sink', () => {
  it('is deterministic and leaves the input and accepted-identity set unchanged', () => {
    const entry = commit(),
      activities = new Set<string>(),
      state = context({ activities });
    const before = JSON.stringify(entry);
    const first = drain(state, entry);
    expect(drain(state, entry)).toEqual(first);
    expect(JSON.stringify(entry)).toBe(before);
    expect([...activities]).toEqual([]);
    expect(nodes(first).map((node) => node['@type'])).toEqual([
      'prov:Activity',
      'ft:Commit',
      'prov:Entity',
      'prov:Entity',
    ]);
    expect(first.flatMap((effect) => (effect.kind === 'node' ? [[effect.activity, effect.entity]] : []))).toEqual([
      ['make#2', undefined],
      [undefined, undefined],
      [undefined, ids.write(4, 0, 'secret')],
      [undefined, ids.write(4, 1, 'secret')],
    ]);
    expect(first).toContainEqual({ kind: 'routine-gap', category: 'intermediate-write' });
    expect(first).toContainEqual({ kind: 'routine-gap', category: 'read-attribution' });
  });

  it('uses the privacy oracle for every occurrence, never values or hidden names', () => {
    const effects = drain(context({ hides: () => true }), commit());
    const writes = nodes(effects).filter((node) => node['@type'] === 'prov:Entity');
    expect(writes.map((node) => node['@id'])).toEqual([ids.write(4, 0), ids.write(4, 1)]);
    expect(writes.every((node) => node['ft:redacted'] === true && node['ft:path'] === undefined)).toBe(true);
    expect(JSON.stringify(effects)).not.toContain('secret');
    expect(
      effects.filter((effect) => effect.kind === 'routine-gap' && effect.category === 'redacted-write'),
    ).toHaveLength(2);
  });

  it('still processes scope gaps and attempts a commit after an activity is refused', () => {
    let rowReads = 0;
    const effects = drain(
      context({
        readGaps: () => {
          rowReads++;
          return [];
        },
      }),
      commit(),
      () => false,
    );
    expect(effects.map((effect) => (effect.kind === 'node' ? effect.node['@type'] : effect.kind))).toEqual([
      'prov:Activity',
      'routine-gap',
      'ft:Commit',
    ]);
    expect(nodes(effects)[1]['ft:execution']).toBeUndefined();
    expect(rowReads).toBe(0);
  });

  it('stops lazily after the first refused write without inspecting later rows', () => {
    const inspected: number[] = [];
    const effects = drain(
      context({
        readGaps: (row) => {
          inspected.push(row.rowIdx);
          return [];
        },
      }),
      commit(),
      (effect) => effect.kind !== 'node' || effect.node['@type'] !== 'prov:Entity',
    );
    expect(inspected).toEqual([0]);
    expect(nodes(effects)).toHaveLength(3);
  });

  it('does not repeat an accepted execution and keeps continuation execution links', () => {
    const effects = drain(context({ activities: new Set(['make#2']) }), commit());
    expect(nodes(effects).map((node) => node['@type'])).toEqual(['ft:Commit', 'prov:Entity', 'prov:Entity']);
    expect(nodes(effects)[0]['ft:execution']).toEqual({ '@id': ids.activity('make#2') });
  });

  it('uses prepared continuation facts and only already-accepted control parents', () => {
    const state = context({ parent: 'choose#0', hasUntrackedInput: () => true });
    const absent = nodes(drain(state, commit()))[0];
    expect(absent['ft:untrackedInput']).toBe(true);
    expect(absent['ft:tags']).toEqual(['first']);
    expect(absent['prov:wasInformedBy']).toBeUndefined();
    const present = nodes(drain({ ...state, activities: new Set(['choose#0']) }, commit()))[0];
    expect(present['prov:wasInformedBy']).toEqual({ '@id': ids.activity('choose#0') });
  });

  it('does not inspect execution-wide facts for accepted or nonnative executions', () => {
    let scans = 0;
    const state = context({
      hasUntrackedInput: () => {
        scans++;
        return false;
      },
    });
    drain({ ...state, activities: new Set(['make#2']) }, commit());
    const entry = commit();
    drain(state, { ...entry, bundle: { ...entry.bundle, runtimeStageId: 'legacy' } });
    expect(scans).toBe(0);
    drain(state, entry);
    expect(scans).toBe(1);
  });

  it('keeps a nonnative execution positional without inventing an activity', () => {
    const entry = commit();
    const effects = drain(context(), { ...entry, bundle: { ...entry.bundle, runtimeStageId: 'legacy' } });
    expect(effects[0]).toEqual({
      kind: 'gap',
      gap: {
        code: 'unsupported',
        commitIdx: 4,
        reason: 'native execution identity is unavailable',
      },
    });
    expect(nodes(effects)[0]['@type']).toBe('ft:Commit');
    expect(nodes(effects).every((node) => node['prov:wasGeneratedBy'] === undefined)).toBe(true);
  });
});
