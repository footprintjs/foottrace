import { describe, expect, it } from 'vitest';
import { createRecordGraph } from '../../../cause.js';
import type { RecordScope } from '../../../cause.js';
import type { CommitBundle } from '../../memory/types.js';

// Proposed design-03 port fixtures, not claims that the old API admitted this metadata.
// Real local CommitBundles remain usable even when the separate metadata is refused.
const parent = { logRunId: 'admission-run', drillPath: [] as string[] };
const child = { logRunId: 'admission-run', drillPath: ['mount#1'] };
const ctx = () => ({ signal: new AbortController().signal });
const outputCodes = ['explicit-output', 'privacy-active', 'budget-exhausted', 'output-mutated', 'commit-time-read'];
const inputCodes = [
  'privacy-active',
  'budget-exhausted',
  'parent-log-advanced',
  'resume-seed',
  'commit-time-read',
  'selector-reads-unavailable',
];
const collectionCodes = [
  'privacy-active',
  'budget-exhausted',
  'branches-truncated',
  'missing-child-record',
  'explicit-output',
  'failed-slot',
];

function commit(runtimeStageId: string, idx: number, path: string, readKeys: string[]): CommitBundle {
  return {
    idx,
    runtimeStageId,
    stageId: runtimeStageId,
    stage: runtimeStageId,
    trace: [{ path, verb: 'set', readKeys }],
    overwrite: { [path]: 'fixture' },
    updates: {},
    redactedPaths: [],
  };
}
function scope(address: RecordScope['address'], commitLog: CommitBundle[]): RecordScope {
  return {
    address,
    commitLog,
    complete: true,
    controlDeps: {},
    attention: {},
    reads: Object.fromEntries(commitLog.map((row) => [row.runtimeStageId, row.trace.flatMap((t) => t.readKeys ?? [])])),
  };
}
function fixture() {
  const output = {
    version: 1,
    attribution: 'observed-read-prefix',
    parent: { address: parent, runtimeStageId: 'mount#1', commitIdx: 1 },
    child: { address: child, beforeCommitIdx: 2 },
    writes: [{ path: 'final', reads: ['childValue'] }],
    status: 'captured',
    limitations: [] as string[],
  };
  const input = {
    version: 1,
    attribution: 'observed-read-prefix',
    parent: { address: parent, beforeCommitIdx: 1 },
    child: { address: child, runtimeStageId: 'mount#1', commitIdx: 0 },
    writes: [{ path: 'seed', reads: ['input'] }],
    status: 'captured',
    limitations: [] as string[],
  };
  const mount = { runtimeStageId: 'mount#1', child, inputHandoff: input, outputHandoff: output };
  const collection = {
    version: 1,
    attribution: 'observed-scope-collection',
    parent: { address: parent, runtimeStageId: 'collect#1', commitIdx: 1, path: 'final' },
    totalItems: 1,
    branchCount: 1,
    slots: [{ index: 0, child: { address: child, beforeCommitIdx: 2 }, observation: 'scope-snapshot' }],
    status: 'captured',
    limitations: [] as string[],
  };
  const inventory = { version: 1, status: 'captured', mounts: [mount], collections: [] as (typeof collection)[] };
  const parentScope = scope(parent, [commit('local#0', 0, 'input', []), commit('mount#1', 1, 'final', ['input'])]);
  const childScope = scope(child, [commit('mount#1', 0, 'seed', []), commit('child/work#2', 1, 'childValue', [])]);
  Object.assign(parentScope, { subflows: inventory });
  return { output, input, mount, collection, inventory, parentScope, childScope, targetId: 'mount#1' };
}
type Fixture = ReturnType<typeof fixture>;
function fanout(): Fixture {
  const f = fixture();
  f.targetId = 'collect#1';
  Object.assign(f.parentScope, {
    commitLog: [commit('local#0', 0, 'input', []), commit(f.targetId, 1, 'final', ['input'])],
    reads: { 'local#0': [], [f.targetId]: ['input'] },
  });
  Reflect.deleteProperty(f.mount, 'inputHandoff');
  Reflect.deleteProperty(f.mount, 'outputHandoff');
  f.inventory.collections = [f.collection];
  return f;
}
async function inspect(f: Fixture, options: Parameters<typeof createRecordGraph>[1] = {}) {
  const graph = createRecordGraph([f.parentScope, f.childScope], options);
  const target = graph.nodeId(parent, { runtimeStageId: f.targetId, commitIdx: 1, key: 'final' });
  const local = graph.nodeId(parent, { runtimeStageId: 'local#0', commitIdx: 0, key: 'input' });
  const remote = graph.nodeId(child, { runtimeStageId: 'child/work#2', commitIdx: 1, key: 'childValue' });
  const parents = await graph.parents(target, ctx());
  const gaps = await graph.gaps(target, ctx());
  expect(parents.edges.map((edge) => edge.nodeId)).toContain(local);
  return { parents, gaps, remote };
}
async function refused(f: Fixture, options: Parameters<typeof createRecordGraph>[1] = {}) {
  const result = await inspect(f, options);
  expect(result.parents.complete).toBe(false);
  expect(result.gaps.some((gap) => ['invalid-data', 'unsupported', 'node-limit'].includes(gap.code))).toBe(true);
  return result;
}

describe('proposed subflows admission: feature-contract controls', () => {
  it('retains the old local result when no boundary metadata is supplied', async () => {
    const f = fixture();
    Reflect.deleteProperty(f.parentScope, 'subflows');
    const result = await inspect(f);
    expect(result.parents.complete).toBe(true);
    expect(result.gaps).toEqual([]);
  });

  it('accepts an explicitly empty finite inventory without damaging local edges', async () => {
    const f = fixture();
    f.inventory.mounts = [];
    const result = await inspect(f);
    expect(result.parents.complete).toBe(true);
    expect(result.gaps).toEqual([]);
  });

  it('does not promote a partial native inventory into complete impact', async () => {
    const f = fixture();
    f.inventory.status = 'partial';
    f.inventory.mounts = [];
    const graph = createRecordGraph([f.parentScope]);
    const writer = graph.nodeId(parent, { runtimeStageId: 'local#0', commitIdx: 0, key: 'input' });
    const target = graph.nodeId(parent, { runtimeStageId: f.targetId, commitIdx: 1, key: 'final' });
    const result = await graph.children(writer, ctx());
    expect(result.edges.map((edge) => edge.nodeId)).toContain(target);
    expect(result.complete).toBe(false);
  });
});

describe('proposed subflows admission: malformed records retain local evidence', () => {
  const cases: [string, (f: Fixture) => void][] = [
    [
      'inventory version',
      (f) => {
        f.inventory.version = 2;
      },
    ],
    [
      'inventory status',
      (f) => {
        f.inventory.status = 'verified';
      },
    ],
    [
      'unknown inventory property',
      (f) => {
        Object.assign(f.inventory, { passed: true });
      },
    ],
    [
      'required collections missing',
      (f) => {
        Reflect.deleteProperty(f.inventory, 'collections');
      },
    ],
    [
      'invented collections alias',
      (f) => {
        Object.assign(f.inventory, { fanoutCollections: [] });
      },
    ],
    [
      'unknown mount property',
      (f) => {
        Object.assign(f.mount, { complete: true });
      },
    ],
    [
      'duplicate mount',
      (f) => {
        f.inventory.mounts.push(structuredClone(f.mount));
      },
    ],
    [
      'duplicate child address under another execution',
      (f) => {
        f.inventory.mounts.push({ ...structuredClone(f.mount), runtimeStageId: 'other#2' });
      },
    ],
    [
      'child from another run',
      (f) => {
        f.mount.child = { ...child, logRunId: 'another-run' };
      },
    ],
    [
      'child is not an immediate native mount',
      (f) => {
        f.mount.child = { ...child, drillPath: ['outer#0', 'mount#1'] };
      },
    ],
    [
      'child names another visit',
      (f) => {
        f.mount.child = { ...child, drillPath: ['mount#2'] };
      },
    ],
    [
      'output version',
      (f) => {
        f.output.version = 9;
      },
    ],
    [
      'output attribution',
      (f) => {
        f.output.attribution = 'semantic-derivation';
      },
    ],
    [
      'output status',
      (f) => {
        f.output.status = 'verified';
      },
    ],
    [
      'output limitation',
      (f) => {
        f.output.status = 'partial';
        f.output.limitations = ['unknown-output-reason'];
      },
    ],
    [
      'output parent address',
      (f) => {
        f.output.parent.address = { ...parent, logRunId: 'other' };
      },
    ],
    [
      'output parent execution',
      (f) => {
        f.output.parent.runtimeStageId = 'other#2';
      },
    ],
    [
      'input version',
      (f) => {
        f.input.version = 9;
      },
    ],
    [
      'input attribution',
      (f) => {
        f.input.attribution = 'semantic-derivation';
      },
    ],
    [
      'input limitation',
      (f) => {
        f.input.status = 'partial';
        f.input.limitations = ['output-mutated'];
      },
    ],
    [
      'input child address',
      (f) => {
        f.input.child.address = { ...child, logRunId: 'other' };
      },
    ],
    [
      'input child execution',
      (f) => {
        f.input.child.runtimeStageId = 'other#2';
      },
    ],
    [
      'non-seed input target',
      (f) => {
        f.input.child.commitIdx = 1;
      },
    ],
    [
      'null inventory',
      (f) => {
        Object.assign(f.parentScope, { subflows: null });
      },
    ],
    [
      'array inventory',
      (f) => {
        Object.assign(f.parentScope, { subflows: [] });
      },
    ],
  ];
  it.each(cases)('refuses %s without erasing local provenance', async (_name, change) => {
    const f = fixture();
    change(f);
    await refused(f);
  });

  it.each(outputCodes)('output limitation %s cannot claim captured', async (code) => {
    const f = fixture();
    f.output.limitations = [code];
    await refused(f);
  });
  it.each(inputCodes)('input limitation %s cannot claim captured', async (code) => {
    const f = fixture();
    f.input.limitations = [code];
    await refused(f);
  });

  it('never invokes a getter on the new top-level port', async () => {
    const f = fixture();
    let calls = 0;
    Object.defineProperty(f.parentScope, 'subflows', {
      enumerable: true,
      get() {
        calls++;
        return f.inventory;
      },
    });
    await refused(f);
    expect(calls).toBe(0);
  });
  it('never invokes nested evidence getters or returns their private text', async () => {
    const f = fixture();
    let calls = 0;
    const privateText = 'PRIVATE_FIXTURE_DO_NOT_PROJECT';
    Object.defineProperty(f.output.writes[0], 'reads', {
      enumerable: true,
      get() {
        calls++;
        throw new Error(privateText);
      },
    });
    const result = await refused(f);
    expect(calls).toBe(0);
    expect(JSON.stringify(result)).not.toContain(privateText);
  });
  it('rejects symbols and custom prototypes in evidence records', async () => {
    for (const change of [
      (f: Fixture) => {
        Object.assign(f.mount, { [Symbol('hidden')]: true });
      },
      (f: Fixture) => {
        Object.setPrototypeOf(f.output, { version: 1 });
      },
    ]) {
      const f = fixture();
      change(f);
      await refused(f);
    }
  });
});

describe('proposed subflows admission: partial and privacy channels', () => {
  it('retains partial privacy status without inventing a child source', async () => {
    const f = fixture();
    f.output.status = 'partial';
    f.output.limitations = ['privacy-active'];
    f.output.writes[0].reads = [];
    const result = await inspect(f);
    expect(result.parents.complete).toBe(false);
    expect(result.gaps.length).toBeGreaterThan(0);
    expect(result.parents.edges.map((edge) => edge.nodeId)).not.toContain(result.remote);
  });
  it('does not echo invalid limitation or source-name text in refusal gaps', async () => {
    const f = fixture();
    const privateText = 'PRIVATE_BAD_METADATA_TEXT';
    f.output.status = 'partial';
    f.output.limitations = [privateText];
    f.output.writes[0].reads = [privateText];
    const result = await refused(f);
    expect(JSON.stringify(result)).not.toContain(privateText);
  });
});

describe('proposed subflows admission: closed fanout slots', () => {
  const cases: [string, (f: Fixture) => void][] = [
    [
      'version',
      (f) => {
        f.collection.version = 2;
      },
    ],
    [
      'attribution',
      (f) => {
        f.collection.attribution = 'observed-read-prefix';
      },
    ],
    [
      'status',
      (f) => {
        f.collection.status = 'verified';
      },
    ],
    [
      'limitation',
      (f) => {
        f.collection.status = 'partial';
        f.collection.limitations = ['resume-seed'];
      },
    ],
    [
      'observation',
      (f) => {
        f.collection.slots[0].observation = 'unavailable-child';
      },
    ],
    [
      'required child missing',
      (f) => {
        Reflect.deleteProperty(f.collection.slots[0], 'child');
      },
    ],
    [
      'slot duplicate',
      (f) => {
        f.collection.slots.push(structuredClone(f.collection.slots[0]));
      },
    ],
    [
      'slot outside dispatched extent',
      (f) => {
        f.collection.slots[0].index = 1;
      },
    ],
    [
      'negative total',
      (f) => {
        f.collection.totalItems = -1;
      },
    ],
    [
      'unsafe count',
      (f) => {
        f.collection.totalItems = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      'more branches than items',
      (f) => {
        f.collection.branchCount = 2;
      },
    ],
    [
      'captured but missing slot',
      (f) => {
        f.collection.slots = [];
      },
    ],
    [
      'collection parent address',
      (f) => {
        f.collection.parent.address = { ...parent, logRunId: 'other' };
      },
    ],
    [
      'slot from another parent',
      (f) => {
        f.collection.slots[0].child.address = { ...child, drillPath: ['outer#0', 'mount#1'] };
      },
    ],
  ];
  it.each(cases)('refuses %s and keeps the actual local edge', async (_name, change) => {
    const f = fanout();
    change(f);
    await refused(f);
  });
  it.each(collectionCodes)('collection limitation %s requires partial', async (code) => {
    const f = fanout();
    f.collection.limitations = [code];
    await refused(f);
  });
  it('retains an omitted unknown child as a partial collection, never an invented slot', async () => {
    const f = fanout();
    f.collection.status = 'partial';
    f.collection.limitations = ['missing-child-record'];
    f.collection.slots = [];
    const result = await inspect(f);
    expect(result.parents.complete).toBe(false);
    expect(result.gaps.some((gap) => ['scope-boundary', 'unsupported', 'conservative'].includes(gap.code))).toBe(true);
    expect(result.parents.edges).toHaveLength(1);
  });
  it('privacy withholds every child-reference slot', async () => {
    const f = fanout();
    f.collection.status = 'partial';
    f.collection.limitations = ['privacy-active'];
    await refused(f);
  });
});

describe('proposed subflows admission: bounded data work', () => {
  it('caps mount inventory using maxScopes without losing the local log', async () => {
    const f = fixture();
    const other = { runtimeStageId: 'other#2', child: { ...child, drillPath: ['other#2'] } };
    Object.assign(f.inventory, { mounts: [f.mount, other] });
    await refused(f, { maxScopes: 1 });
  });
  it('refuses oversized lists before reading their accessors', async () => {
    const f = fixture();
    let calls = 0;
    const mounts = new Array(257);
    Object.defineProperty(mounts, '0', {
      enumerable: true,
      get() {
        calls++;
        return f.mount;
      },
    });
    Object.assign(f.inventory, { mounts });
    await refused(f);
    expect(calls).toBe(0);
  });
  it('charges the shared field budget for metadata, not only the local bundles', async () => {
    const f = fixture();
    f.output.writes[0].reads = Array.from({ length: 128 }, (_, i) => `key${i}`);
    await refused(f, { maxFields: 100 });
  });
});
