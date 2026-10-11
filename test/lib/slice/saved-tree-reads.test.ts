import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { keysReadFromExecutionTree, keysReadFromMap, sliceForKey } from '../../../src/index.js';
import type { ExecutionTree } from '../../../src/index.js';

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(value: unknown, name: string): unknown {
  if (!object(value)) throw new Error(`Fixture must contain an object with ${name}`);
  return value[name];
}

function fixture(name: string, sha256: string): unknown {
  const bytes = readFileSync(new URL(`../../fixtures/${name}`, import.meta.url));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  return parsed;
}

describe('saved execution-tree read evidence through the public entry', () => {
  it('accepts unknown real Flow 10 JSON without changing read keys, coverage or record bytes', () => {
    const snapshot = fixture(
      'causal-phases/runtime-snapshot-10.0.0.json',
      '3a22244cf2f71465b5647a8639de1d0481c99f9342f0874c336c3d35f8613990',
    );
    const before = JSON.stringify(snapshot);
    const reads = keysReadFromExecutionTree(field(snapshot, 'executionTree'));
    expect(reads.kind).toBe('execution-tree');
    expect(reads.coverage).toEqual({ steps: 4, stepsWithReads: 1 });
    expect(reads.lookup('seed#0')).toEqual([]);
    expect(reads.lookup('a#1')).toEqual(['runs']);
    expect(reads.lookup('b#2')).toEqual([]);
    expect(reads.lookup('join#3')).toEqual([]);
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it('keeps a genuine historical Flow 9.15.1 tree readable with the same observed keys', () => {
    const saved = fixture(
      'saved-trees/linear-decider-9.15.1.json',
      '79c841b760e177b34e37288bb98af4d05703da520eada8c2bc09e507d2995903',
    );
    const before = JSON.stringify(saved);
    const reads = keysReadFromExecutionTree(field(field(saved, 'snapshot'), 'executionTree'));
    expect(reads.coverage).toEqual({ steps: 4, stepsWithReads: 2 });
    expect(reads.lookup('intake#0')).toEqual([]);
    expect(reads.lookup('enrich#1')).toEqual(['applicant']);
    expect(reads.lookup('classify-risk#2')).toEqual(['creditScore', 'dti']);
    expect(reads.lookup('approve#3')).toEqual([]);
    expect(JSON.stringify(saved)).toBe(before);
  });

  it('keeps real HCI read maps as maps rather than inventing an execution tree or coverage', () => {
    const saved = fixture(
      'saved-trees/hci-3.0.0.json',
      'fc287b4e0c4e955e2d0ec6b1145971e020e829238e0e77bdd0e39d0f614ceee8',
    );
    const before = JSON.stringify(saved);
    expect(field(field(saved, 'source'), 'executionTree')).toBeUndefined();
    const byStep = field(field(saved, 'reads'), 'byStep');
    if (!object(byStep)) throw new Error('HCI fixture must contain its saved Session.readsByStep map');
    const entries = new Map<string, readonly string[]>();
    for (const [id, value] of Object.entries(byStep)) {
      if (!Array.isArray(value) || !value.every((key): key is string => typeof key === 'string')) {
        throw new Error(`HCI fixture has malformed read keys for ${id}`);
      }
      entries.set(id, value);
    }
    const reads = keysReadFromMap(entries);
    expect(reads.kind).toBe('map');
    expect(reads.coverage).toBeUndefined();
    expect(reads.lookup('unlock#0')).toEqual(['authenticated']);
    expect(reads.lookup('checkout#3')).toEqual(['authenticated', 'itemCount']);
    expect(reads.lookup('add#4')).toEqual([]); // The real pending transition has not committed.
    expect(JSON.stringify(saved)).toBe(before);
  });

  it('retains zero-write readers and exposes partial coverage without claiming independence', () => {
    const reads = keysReadFromExecutionTree({
      runtimeStageId: 'zero-write#0',
      stageReads: { input: 'REDACTED' },
      next: { runtimeStageId: 'empty#1', stageReads: {}, next: { runtimeStageId: 'missing#2' } },
    });
    expect(reads.lookup('zero-write#0')).toEqual(['input']);
    expect(reads.lookup('empty#1')).toEqual([]);
    expect(reads.lookup('missing#2')).toEqual([]);
    expect(reads.coverage).toEqual({ steps: 3, stepsWithReads: 1 });
    expect(sliceForKey([], 'input', reads).readsCoverage).toEqual(reads.coverage);
    expect(reads).not.toHaveProperty('complete');
  });

  it('keeps valid empty, id-less and null-prototype objects, without inventing steps', () => {
    for (const tree of [{}, [], Object.create(null), { runtimeStageId: '', stageReads: {} }]) {
      expect(keysReadFromExecutionTree(tree).coverage).toEqual({ steps: 0, stepsWithReads: 0 });
    }
    const reads = keysReadFromExecutionTree({
      stageReads: { notAttributed: 1 },
      children: [{ runtimeStageId: 'child#0' }],
    });
    expect(reads.lookup('')).toEqual([]);
    expect(reads.coverage).toEqual({ steps: 1, stepsWithReads: 0 });
  });

  it('visits cyclic/shared references once, retaining the established multi-root traversal order', () => {
    const shared: { runtimeStageId: string; stageReads: Record<string, unknown>; next?: unknown } = {
      runtimeStageId: 'shared#1',
      stageReads: { key: 1 },
    };
    const root = { runtimeStageId: 'root#0', next: shared, children: [shared, shared] };
    shared.next = root;
    const reads = keysReadFromExecutionTree([root, shared]);
    expect(reads.coverage).toEqual({ steps: 2, stepsWithReads: 1 });
    expect(reads.lookup('shared#1')).toEqual(['key']);
    expect(root.next).toBe(shared);
    expect(shared.next).toBe(root);

    // Distinct objects reusing an id retain the existing last-visited nonempty
    // lookup; shape validation does not silently introduce a new union policy.
    const repeated = keysReadFromExecutionTree([
      { runtimeStageId: 'same#1', stageReads: { firstRoot: 1 } },
      { runtimeStageId: 'same#1', stageReads: { secondRoot: 1 } },
    ]);
    expect(repeated.lookup('same#1')).toEqual(['firstRoot']);
    expect(repeated.coverage).toEqual({ steps: 2, stepsWithReads: 1 });
  });

  it('accepts frozen typed inputs and ignores metadata and stored read values it does not interpret', () => {
    const tree: ExecutionTree = Object.freeze({
      runtimeStageId: 'typed#0',
      stageReads: Object.freeze({ key: undefined }),
    });
    expect(keysReadFromExecutionTree(tree).lookup('typed#0')).toEqual(['key']);
    const values = { runtimeStageId: 'values#1', stageReads: { nested: null, marker: [1], number: 42 }, logs: null };
    expect(keysReadFromExecutionTree(values).lookup('values#1')).toEqual(['nested', 'marker', 'number']);
  });

  it('handles a deep valid chain without a recursive call-stack limit', () => {
    let tree: ExecutionTree = { runtimeStageId: 'tail#0', stageReads: { input: 1 } };
    for (let i = 1; i <= 20000; i++) tree = { runtimeStageId: `node#${i}`, next: tree };
    const reads = keysReadFromExecutionTree(tree);
    expect(reads.coverage).toEqual({ steps: 20001, stepsWithReads: 1 });
    expect(reads.lookup('tail#0')).toEqual(['input']);
  });

  it('preserves structural class nodes and rich read-bag own-key semantics without a new prototype policy', () => {
    class TreeNode implements ExecutionTree {
      runtimeStageId = 'class#0';
      stageReads = { own: 1 };
    }
    expect(keysReadFromExecutionTree(new TreeNode()).lookup('class#0')).toEqual(['own']);
    for (const bag of [new Map([['notAnOwnKey', 1]]), new Date(0)]) {
      const source = { runtimeStageId: 'rich#1', stageReads: bag };
      expect(keysReadFromExecutionTree(source).lookup('rich#1')).toEqual([]);
      Object.assign(bag, { actualOwnKey: 1 });
      const reads = keysReadFromExecutionTree(source);
      expect(reads.lookup('rich#1')).toEqual(['actualOwnKey']);
      expect(reads.coverage).toEqual({ steps: 1, stepsWithReads: 1 });
    }
  });

  it.each([
    [undefined, '$'],
    [null, '$'],
    [42, '$'],
    ['tree', '$'],
    [true, '$'],
    [[null], '$[0]'],
    [[[]], '$[0]'],
    [[, { runtimeStageId: 'kept#1' }], '$[0]'],
    [{ runtimeStageId: 4 }, '$.runtimeStageId'],
    [{ runtimeStageId: null }, '$.runtimeStageId'],
    [{ stageReads: 7 }, '$.stageReads'],
    [{ stageReads: null }, '$.stageReads'],
    [{ stageReads: ['fabricated-key'] }, '$.stageReads'],
    [{ next: null }, '$.next'],
    [{ next: 'bad' }, '$.next'],
    [{ next: [] }, '$.next'],
    [{ next: { stageReads: false } }, '$.next.stageReads'],
    [{ children: null }, '$.children'],
    [{ children: 'bad' }, '$.children'],
    [{ children: {} }, '$.children'],
    [{ children: [null] }, '$.children[0]'],
    [{ children: [, { runtimeStageId: 'kept#1' }] }, '$.children[0]'],
    [{ children: [{ next: { runtimeStageId: [] } }] }, '$.children[0].next.runtimeStageId'],
  ])('refuses malformed evidence %j with its exact source path %s', (tree, path) => {
    expect(() => keysReadFromExecutionTree(tree)).toThrow(TypeError);
    expect(() => keysReadFromExecutionTree(tree)).toThrow(`keysReadFromExecutionTree: ${path} must be`);
  });

  it('does not return partial evidence when a later visited descendant is malformed', () => {
    const tree = { runtimeStageId: 'read-first#0', stageReads: { input: 1 }, next: { children: [null] } };
    const before = JSON.stringify(tree);
    expect(() => keysReadFromExecutionTree(tree)).toThrow('$.next.children[0]');
    expect(JSON.stringify(tree)).toBe(before);
  });
});
