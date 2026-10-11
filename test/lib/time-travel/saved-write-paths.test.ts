import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  type CommitBundle,
  causalChain,
  flattenCausalDAG,
  isCommitBundle,
  keysReadFromExecutionTree,
  keysReadFromMap,
  stateAt,
  timeTravel,
} from '../../../src/index.js';

const fixtureFile = resolve(__dirname, '../../fixtures/causal-phases/interleaved-fork-10.0.0.json');
const fixtureText = readFileSync(fixtureFile, 'utf8');
const fixture: { commitLog: unknown[]; executionTree: unknown } = JSON.parse(fixtureText);

function checkedRows(raw: readonly unknown[]): CommitBundle[] {
  const rows: CommitBundle[] = [];
  for (let index = 0; index < raw.length; index++) {
    const row = raw[index];
    if (!isCommitBundle(row)) throw new TypeError(`Unreadable row ${index}`);
    rows.push(row);
  }
  return rows;
}

const original = checkedRows(fixture.commitLog);
const reads = keysReadFromExecutionTree(fixture.executionTree);
const seed = original[0];

function withPath(path: unknown) {
  return { ...seed, trace: [{ ...seed.trace[0], path }] };
}

const missingPath = {
  ...seed,
  trace: [{ verb: seed.trace[0].verb, readKeys: seed.trace[0].readKeys }],
};
const invalidPaths: { name: string; value: unknown; description: string }[] = [
  { name: 'undefined', value: undefined, description: 'missing' },
  { name: 'null', value: null, description: 'null' },
  { name: 'number', value: 42, description: 'a number' },
  { name: 'NaN', value: NaN, description: 'a number' },
  { name: 'Infinity', value: Infinity, description: 'a number' },
  { name: '-Infinity', value: -Infinity, description: 'a number' },
  { name: 'true', value: true, description: 'a boolean' },
  { name: 'false', value: false, description: 'a boolean' },
  { name: 'object', value: {}, description: 'a object' },
  { name: 'array', value: ['runs'], description: 'an array' },
  { name: 'boxed string', value: new String('runs'), description: 'a object' },
  { name: 'symbol', value: Symbol('runs'), description: 'a symbol' },
  { name: 'bigint', value: BigInt(42), description: 'a bigint' },
  { name: 'function', value: () => 'runs', description: 'a function' },
];

describe('saved write paths use the one public bundle boundary', () => {
  it.each(invalidPaths)('refuses $name without coercion and reports the indexed gap', ({ value, description }) => {
    const row = withPath(value);
    expect(isCommitBundle(row)).toBe(false);
    const folded = stateAt({ commitLog: [row] }, 0);
    expect(folded.skipped).toEqual([{ index: 0, reason: `trace[0].path is ${description}, not a string` }]);
    expect(folded.state).toEqual({});
    expect(row.trace[0].path).toBe(value);
    expect(row.overwrite).toBe(seed.overwrite);
  });

  it('refuses an absent path, not just an explicitly undefined field', () => {
    expect(isCommitBundle(missingPath)).toBe(false);
    expect(stateAt({ commitLog: [missingPath] }, 0).skipped).toEqual([
      { index: 0, reason: 'trace[0].path is missing, not a string' },
    ]);
    expect(Object.hasOwn(missingPath.trace[0], 'path')).toBe(false);
  });

  it.each(['', 'runs', 'a.b', 'a\u001fb', '\u001f', '__proto__', 'constructor', 'prototype', '雪'])(
    'preserves the existing string-path contract for %j',
    (path) => {
      const row = withPath(path);
      expect(isCommitBundle(row)).toBe(true);
      expect(row.trace[0].path).toBe(path);
    },
  );

  it('keeps advisory metadata optional on readable historical rows', () => {
    const row = { runtimeStageId: 'legacy#0', trace: [{ path: 'runs', verb: 'set' }], overwrite: { runs: 1 } };
    expect(isCommitBundle(row)).toBe(true);
    const log = checkedRows([row]);
    expect(log[0]).toBe(row);
    expect(causalChain(log, 'legacy#0', () => [])?.keysWritten).toEqual(['runs']);
    expect(stateAt({ commitLog: log }, 0).state).toEqual({ runs: 1 });
  });

  it('keeps empty traces valid, with no new mandatory fields', () => {
    expect(isCommitBundle({ runtimeStageId: 'empty#0', trace: [] })).toBe(true);
  });

  it('preserves the existing empty-string-key fold, not just guard acceptance', () => {
    const row = { runtimeStageId: 'empty#0', trace: [{ path: '', verb: 'set' }], overwrite: { '': 42 } };
    const before = JSON.stringify(row);
    expect(isCommitBundle(row)).toBe(true);
    expect(stateAt({ commitLog: [row] }, 0).state).toEqual({ '': 42 });
    expect(stateAt({ commitLog: [row] }, 0).skipped).toBeUndefined();
    expect(JSON.stringify(row)).toBe(before);
  });
});

describe('saved-row refusal remains atomic and index preserving', () => {
  it('discards the entire damaged bundle, not just its invalid path or later writes', () => {
    const before = { runtimeStageId: 'before#0', trace: [{ path: 'count', verb: 'set' }], overwrite: { count: 1 } };
    const damaged = {
      runtimeStageId: 'damaged#1',
      trace: [
        { path: 'count', verb: 'set' },
        { path: 42, verb: 'set' },
        { path: 'leaked', verb: 'set' },
      ],
      overwrite: { count: 2, leaked: true },
    };
    const after = { runtimeStageId: 'after#2', trace: [{ path: 'done', verb: 'set' }], overwrite: { done: true } };
    const source = { initialState: { count: 0 }, commitLog: [before, damaged, after] };
    const bytes = JSON.stringify(source);
    expect(stateAt(source, 0).state).toEqual({ count: 1 });
    expect(stateAt(source, 0).skipped).toBeUndefined();
    const folded = stateAt(source, 2);
    expect(folded.state).toEqual({ count: 1, done: true });
    expect(folded.skipped).toEqual([{ index: 1, reason: 'trace[1].path is a number, not a string' }]);
    expect(
      timeTravel(source)
        .stops.filter((stop) => stop.kind === 'commit')
        .map((stop) => stop.commitIdx),
    ).toEqual([0, 2]);
    expect(JSON.stringify(source)).toBe(bytes);
  });

  it.each([undefined, null, [], {}, 42])('retains the prior verb refusal for an invalid trace entry %j', (entry) => {
    const row = { ...seed, trace: [entry] };
    expect(isCommitBundle(row)).toBe(false);
    expect(stateAt({ commitLog: [row] }, 0).skipped).toEqual([
      { index: 0, reason: 'trace[0].verb is missing, not set | merge | append | delete' },
    ]);
  });

  it('does not skip a sparse trace entry and retains its original refusal reason', () => {
    const trace: unknown[] = [seed.trace[0]];
    trace.length = 2;
    const row = { ...seed, trace };
    expect(isCommitBundle(row)).toBe(false);
    expect(stateAt({ commitLog: [row] }, 0).skipped).toEqual([
      { index: 0, reason: 'trace[1].verb is missing, not set | merge | append | delete' },
    ]);
    expect(Object.hasOwn(trace, 1)).toBe(false);
  });

  it('preserves existing envelope and same-entry verb refusal precedence', () => {
    const trace = [{ path: 42, verb: 'invented' }];
    const badVerb = { ...seed, trace };
    expect(stateAt({ commitLog: [badVerb] }, 0).skipped?.[0].reason).toBe(
      'trace[0].verb is "invented", not set | merge | append | delete',
    );
    expect(stateAt({ commitLog: [{ ...badVerb, overwrite: [] }] }, 0).skipped?.[0].reason).toBe(
      'overwrite is not a plain object',
    );
    expect(stateAt({ commitLog: [{ ...badVerb, runtimeStageId: undefined }] }, 0).skipped?.[0].reason).toBe(
      'runtimeStageId is missing, not a string',
    );
  });
});

describe.each([0, 257])('real Flow recording at both causal lookup strategies (%i padding)', (padding) => {
  const pads = Array.from({ length: padding }, (_, i) => ({
    stage: 'Explicit synthetic padding',
    stageId: `pad-${i}`,
    runtimeStageId: `pad#${i}`,
    trace: [],
    overwrite: {},
    updates: {},
    redactedPaths: [],
  }));

  it.each(['stage', 'per-write'] as const)('keeps the unchanged producer witness correct (%s)', (edgeAttribution) => {
    const raw = [...pads, ...original.slice(0, 2)];
    const bytes = JSON.stringify(raw);
    const log = checkedRows(raw);
    const root = causalChain(log, 'a#1', reads.lookup, { edgeAttribution });
    if (!root) throw new Error('Missing real A root');
    expect(flattenCausalDAG(root).map((node) => node.runtimeStageId)).toEqual(['a#1', 'seed#0']);
    expect(root.preRunReads).toBeUndefined();
    expect(root.keysWritten).toEqual(['runs\u001fa\u001fy']);
    expect(stateAt({ commitLog: log }, log.length - 1).skipped).toBeUndefined();
    expect(JSON.stringify(raw)).toBe(bytes);
    for (let i = 0; i < raw.length; i++) expect(log[i]).toBe(raw[i]);
  });

  it.each([
    ['numeric', withPath(42)],
    ['missing', missingPath],
  ] as const)('refuses the %s path before causal lookup can invent an origin or crash', (_name, damaged) => {
    const log = [...pads, damaged, original[1]];
    expect(isCommitBundle(damaged)).toBe(false);
    expect(() => checkedRows(log)).toThrow(`Unreadable row ${padding}`);
    expect(log[padding]).toBe(damaged);
  });

  it('a later malformed path cannot spoil a selected valid prefix', () => {
    const raw = [...pads, ...original.slice(0, 2), withPath(42)];
    const prefix = checkedRows(raw.slice(0, padding + 2));
    const root = causalChain(prefix, 'a#1', reads.lookup);
    if (!root) throw new Error('Missing real A root');
    expect(flattenCausalDAG(root).map((node) => node.runtimeStageId)).toEqual(['a#1', 'seed#0']);
    expect(stateAt({ commitLog: raw }, padding + 1).skipped).toBeUndefined();
    expect(stateAt({ commitLog: raw }, padding + 2).skipped?.[0].index).toBe(padding + 2);
  });
});

describe('real fixtures are never rewritten by validation', () => {
  it('pins the Flow witness bytes', () => {
    expect(createHash('sha256').update(fixtureText).digest('hex')).toBe(
      '45b01229a52eaf72b305577647c1e191c49025722614f1d610b6bfe251b4d07d',
    );
    expect(readFileSync(fixtureFile, 'utf8')).toBe(fixtureText);
  });

  it('preserves the genuine HCI session, including append values and redaction', () => {
    const text = readFileSync(resolve(__dirname, '../../fixtures/saved-trees/hci-3.0.0.json'), 'utf8');
    expect(createHash('sha256').update(text).digest('hex')).toBe(
      'fc287b4e0c4e955e2d0ec6b1145971e020e829238e0e77bdd0e39d0f614ceee8',
    );
    const hci: {
      source: { commitLog: unknown[]; initialState: Record<string, unknown> };
      reads: { byStep: Record<string, string[]> };
    } = JSON.parse(text);
    const before = JSON.stringify(hci);
    const log = checkedRows(hci.source.commitLog);
    const folded = stateAt(hci.source, log.length - 1);
    expect(folded.skipped).toBeUndefined();
    expect(folded.state).toEqual({
      authenticated: true,
      items: [{ id: 'p1' }, { id: 'p2' }],
      itemCount: 2,
      privateNote: 'REDACTED',
      orderId: 'demo-order-1',
    });
    expect(folded.redactedPaths).toContain('privateNote');
    const root = causalChain(log, 'checkout#3', keysReadFromMap(hci.reads.byStep).lookup);
    if (!root) throw new Error('Missing recorded checkout');
    expect(flattenCausalDAG(root).map((node) => node.runtimeStageId)).toEqual(['checkout#3', 'unlock#0', 'add#2']);
    expect(JSON.stringify(hci)).toBe(before);
  });
});
