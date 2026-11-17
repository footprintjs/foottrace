import { describe, expect, it } from 'vitest';
import { createRecordGraph, explain } from '../../../cause.js';
import type { RecordScope } from '../../../cause.js';
import type { CommitBundle } from '../../memory/types.js';

type Limitation = 'parent-log-advanced' | 'privacy-active' | 'resume-seed';
interface FixtureOptions {
  readonly missingParent?: boolean;
  readonly limitation?: Limitation;
  readonly emptyPrefix?: boolean;
  readonly beforeCommitIdx?: number;
  readonly wrongSeed?: boolean;
}
const context = () => ({ signal: new AbortController().signal });

function commit(runtimeStageId: string, idx: number, path: string, readKeys: string[] = []): CommitBundle {
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
    reads: Object.fromEntries(
      commitLog.map((entry) => [entry.runtimeStageId, entry.trace.flatMap((row) => row.readKeys ?? [])]),
    ),
    controlDeps: {},
    attention: {},
  };
}

/** Proposed handoff data is added structurally; the old public graph API still runs. */
function fixture(options: FixtureOptions = {}) {
  const parent = { logRunId: 'run-input', drillPath: [] as string[] };
  const child = { logRunId: 'run-input', drillPath: ['mount#0'] };
  const first = commit('source#0', 0, 'a.b');
  // These two canonical paths are different: one literal root, one nested path.
  first.trace.push({ path: 'a\u001fb', verb: 'set', readKeys: [] });
  first.overwrite['a\u001fb'] = 'nested fixture';
  const parentLog = [first, commit('mount#0', 1, 'mounted'), commit('later#2', 2, 'a.b')];
  const childLog = [
    commit('mount#0', 0, 'input'),
    commit('child/work#1', 1, 'out', ['input']),
    commit('child/later#2', 2, 'input'),
    commit('child/constant#3', 3, 'local'),
  ];
  const reads = options.limitation || options.emptyPrefix ? [] : ['a.b'];
  const inputHandoff = {
    version: 1 as const,
    attribution: 'observed-read-prefix' as const,
    parent: { address: parent, beforeCommitIdx: options.beforeCommitIdx ?? 1 },
    child: {
      address: child,
      runtimeStageId: options.wrongSeed ? 'child/work#1' : 'mount#0',
      commitIdx: options.wrongSeed ? 1 : 0,
    },
    writes: options.limitation === 'resume-seed' ? [] : [{ path: 'input', reads }],
    status: options.limitation ? ('partial' as const) : ('captured' as const),
    limitations: options.limitation ? [options.limitation] : [],
  };
  const parentScope = Object.assign(scope(parent, parentLog), {
    subflows: {
      version: 1 as const,
      status: 'captured' as const,
      mounts: [{ runtimeStageId: 'mount#0', child, inputHandoff }],
      collections: [],
    },
  });
  const childScope = {
    ...scope(child, childLog),
    attention: {
      'mount#0': [{ kind: 'error', reason: 'ERROR_RECORDED' as const, evidence: ['proof:seed'] }],
    },
  };
  const graph = createRecordGraph(options.missingParent ? [childScope] : [parentScope, childScope]);
  const node = (address: RecordScope['address'], runtimeStageId: string, commitIdx: number, key: string) =>
    graph.nodeId(address, { runtimeStageId, commitIdx, key });
  return {
    graph,
    writer: node(parent, 'source#0', 0, 'a.b'),
    nestedWriter: node(parent, 'source#0', 0, 'a\u001fb'),
    futureWriter: node(parent, 'later#2', 2, 'a.b'),
    seed: node(child, 'mount#0', 0, 'input'),
    selected: node(child, 'child/work#1', 1, 'out'),
    later: node(child, 'child/later#2', 2, 'input'),
    constant: node(child, 'child/constant#3', 3, 'local'),
  };
}

describe('declared native input handoff', () => {
  it('resolves the saved parent prefix before a later overwrite, preserving a literal dotted key', async () => {
    const { graph, writer, nestedWriter, futureWriter, seed } = fixture();
    const parents = await graph.parents(seed, context());
    expect(parents.edges).toContainEqual(expect.objectContaining({ nodeId: writer, attribution: 'stage' }));
    expect(parents.edges.some((edge) => edge.nodeId === futureWriter || edge.nodeId === nestedWriter)).toBe(false);
    expect(parents.complete).toBe(false);
    expect((await graph.gaps(seed, context())).some((gap) => gap.code === 'conservative')).toBe(true);
  });

  it('inverts the source join to the exact seed write, never its later local overwrite', async () => {
    const { graph, writer, seed, later } = fixture();
    const children = await graph.children(writer, context());
    expect(children.edges.some((edge) => edge.nodeId === seed && edge.attribution === 'stage')).toBe(true);
    expect(children.edges.some((edge) => edge.nodeId === later)).toBe(false);
    expect((await graph.parents(later, context())).edges.some((edge) => edge.nodeId === writer)).toBe(false);
  });

  it('retains the seed in a downstream walk while exposing observed ancestry without a semantic root', async () => {
    const { graph, selected, seed, writer, futureWriter } = fixture();
    const result = await explain(graph, selected, { includeBackward: true });
    expect(result.backward?.nodes).toContain(seed);
    expect(result.backward?.nodes).toContain(writer);
    expect(result.backward?.nodes).not.toContain(futureWriter);
    expect(result.backward?.gaps.some((gap) => gap.code === 'conservative')).toBe(true);
    expect(result.backward?.confidence).toBe('incomplete');
    expect(result.rootCause).toBeUndefined();
  });

  it('keeps a missing exact parent load unknown instead of treating its seed as an independent root', async () => {
    const { graph, selected, seed } = fixture({ missingParent: true });
    const result = await explain(graph, selected, { includeBackward: true });
    expect(result.backward?.nodes).toContain(seed);
    expect(result.backward?.gaps.some((gap) => gap.code === 'scope-boundary' || gap.code === 'unavailable')).toBe(true);
    expect(result.backward?.confidence).toBe('incomplete');
    expect(result.rootCause).toBeUndefined();
  });

  it.each<Limitation>(['parent-log-advanced', 'privacy-active', 'resume-seed'])(
    'withholds attributed parent sources for a partial %s handoff',
    async (limitation) => {
      const { graph, writer, seed, selected } = fixture({ limitation });
      const parents = await graph.parents(seed, context());
      expect(parents.edges.some((edge) => edge.nodeId === writer)).toBe(false);
      expect(parents.complete).toBe(false);
      const result = await explain(graph, selected, { includeBackward: true });
      expect(result.backward?.nodes).not.toContain(writer);
      expect(result.backward?.gaps.length).toBeGreaterThan(0);
      expect(result.backward?.confidence).toBe('incomplete');
      expect(result.rootCause).toBeUndefined();
    },
  );

  it('does not turn an observed empty mapper prefix into proven source independence', async () => {
    const { graph, seed } = fixture({ emptyPrefix: true });
    const parents = await graph.parents(seed, context());
    expect(parents.edges).toEqual([]);
    expect(parents.complete).toBe(false);
    expect((await graph.gaps(seed, context())).length).toBeGreaterThan(0);
  });

  it('does not transfer input capture from a different child commit to the actual seed', async () => {
    const { graph, seed, writer } = fixture({ wrongSeed: true });
    const parents = await graph.parents(seed, context());
    expect(parents.edges.some((edge) => edge.nodeId === writer)).toBe(false);
    expect(parents.complete).toBe(false);
    expect((await graph.gaps(seed, context())).length).toBeGreaterThan(0);
  });

  it('refuses a parent cutoff after the mount could already have observed a future write', async () => {
    const { graph, seed, futureWriter } = fixture({ beforeCommitIdx: 3 });
    const parents = await graph.parents(seed, context());
    expect(parents.edges.some((edge) => edge.nodeId === futureWriter)).toBe(false);
    expect(parents.complete).toBe(false);
    expect((await graph.gaps(seed, context())).length).toBeGreaterThan(0);
  });

  it('keeps an independent later child constant backward-complete when the parent is absent', async () => {
    const { graph, constant, seed, writer } = fixture({ missingParent: true });
    const parents = await graph.parents(constant, context());
    expect(parents).toEqual({ edges: [], complete: true });
    const result = await explain(graph, constant, { includeBackward: true });
    expect(result.backward?.nodes).not.toContain(seed);
    expect(result.backward?.nodes).not.toContain(writer);
    expect(result.backward?.gaps).toEqual([]);
    expect(result.backward?.confidence).toBe('complete');
  });
});
