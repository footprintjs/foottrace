/** Run only in the reviewed neutral consumer beside the producer's fixed produce.cjs. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const addressKey = (address) => JSON.stringify([address.logRunId, ...address.drillPath]);
const sameAddress = (left, right) => addressKey(left) === addressKey(right);
const own = (object, key) => Object.hasOwn(object, key);

function nativeExecution(reader, id) {
  if (!reader.isExecutionKey(id)) return false;
  const parsed = reader.parseRuntimeStageId(id);
  return reader.buildRuntimeStageId(parsed.stageId, parsed.executionIndex, parsed.subflowPath) === id;
}

/** Adapt actual native records; never infer a complete inventory from a snapshot map. */
export function nativeScopes(snapshot, reader) {
  assert.ok(snapshot.logAddress, 'native root log address is required');
  const rows = [
    {
      address: snapshot.logAddress,
      commitLog: snapshot.commitLog,
      initialState: snapshot.initialState,
      collections: snapshot.fanoutCollections?.collections ?? [],
    },
  ];
  const mounts = [];
  for (const [runtimeStageId, result] of Object.entries(snapshot.subflowResults ?? {})) {
    if (!nativeExecution(reader, runtimeStageId)) continue;
    const context = result.treeContext;
    assert.ok(context.logAddress, 'retained native child must name its real log');
    const address = context.logAddress;
    assert.equal(address.drillPath.at(-1), runtimeStageId, 'runtime alias must bind the actual child');
    const parent = { logRunId: address.logRunId, drillPath: address.drillPath.slice(0, -1) };
    mounts.push({
      parent,
      runtimeStageId,
      child: address,
      ...(result.inputHandoff ? { inputHandoff: result.inputHandoff } : {}),
      ...(result.outputHandoff ? { outputHandoff: result.outputHandoff } : {}),
    });
    assert.ok(!rows.some((row) => sameAddress(row.address, address)), 'duplicate native child identity');
    rows.push({
      address,
      commitLog: context.history,
      initialState: context.initialState,
      collections: context.fanoutCollections?.collections ?? [],
    });
  }
  for (const mount of mounts)
    assert.ok(
      rows.some((row) => sameAddress(row.address, mount.parent)),
      'native fixture parent is unavailable',
    );
  return rows.map((row) => {
    return {
      address: row.address,
      commitLog: row.commitLog,
      initialState: row.initialState,
      // Rely on actual per-write prefixes. Do not fabricate collected empty stage/control/attention maps.
      // The fixture returns after run settles. This is log extent, not captured map/control/attention coverage.
      complete: true,
      subflows: {
        version: 1,
        status: 'partial',
        collections: row.collections,
        mounts: mounts.filter((mount) => sameAddress(mount.parent, row.address)).map(({ parent, ...mount }) => mount),
      },
    };
  });
}

function node(graph, scope, commitIdx, key) {
  return graph.nodeId(scope.address, { runtimeStageId: scope.commitLog[commitIdx].runtimeStageId, commitIdx, key });
}
function uniqueStage(scope, name) {
  const matches = scope.commitLog.flatMap((bundle, index) => (bundle.stage === name ? [index] : []));
  assert.equal(matches.length, 1, `fixture stage ${name} must identify exactly one real commit`);
  return matches[0];
}
function scopeAt(scopes, address) {
  const found = scopes.find((scope) => sameAddress(scope.address, address));
  assert.ok(found, 'actual referenced scope is required');
  return found;
}
function mappedMount(scopes) {
  const root = scopes.find((scope) => scope.address.drillPath.length === 0);
  const matches = root.subflows.mounts.filter((mount) => {
    const nested = scopeAt(scopes, mount.child);
    return nested.commitLog.some((bundle) => bundle.stage === 'Compute');
  });
  assert.equal(matches.length, 1, 'fixture must contain its one actual mapped child');
  return { root, mount: matches[0], child: scopeAt(scopes, matches[0].child) };
}
function allNodes(graph, scope) {
  return new Set(
    scope.commitLog.flatMap((bundle, index) => [
      node(graph, scope, index),
      ...bundle.trace.map((row) => node(graph, scope, index, row.path)),
    ]),
  );
}
const context = () => ({ signal: new AbortController().signal });

async function checkMapped(scopes, cause, reader, paths, { input, output, privateView = false }) {
  const graph = cause.createRecordGraph(scopes);
  const { root, mount, child } = mappedMount(scopes);
  const sourceIdx = uniqueStage(root, 'Source');
  const laterIdx = uniqueStage(root, 'Later write');
  const literalSource = paths.normaliseStateKey(['literal.source']);
  assert.equal(reader.commitValueAt(root.commitLog, sourceIdx, literalSource), 7);
  assert.equal(reader.commitValueAt(root.commitLog, laterIdx, literalSource), 999);
  assert.equal(reader.commitValueAt(root.commitLog, root.commitLog.length - 1, 'answer'), 14);
  const source = node(graph, root, sourceIdx, literalSource);
  const late = node(graph, root, laterIdx, literalSource);
  if (input) {
    const handoff = mount.inputHandoff;
    assert.ok(handoff, 'actual mapped seed capture is required');
    assert.equal(handoff.parent.beforeCommitIdx <= laterIdx, true);
    const write = handoff.writes.find((entry) => entry.path === 'seed');
    if (privateView) assert.ok(write === undefined || write.reads.length === 0);
    else assert.ok(write, 'actual seed write must be retained');
    const seed = node(graph, child, handoff.child.commitIdx, 'seed');
    const parents = await graph.parents(seed, context());
    assert.equal(
      parents.edges.some((edge) => edge.nodeId === source),
      !privateView,
    );
    assert.equal(
      parents.edges.some((edge) => edge.nodeId === late),
      false,
    );
    assert.equal(parents.complete, false);
    if (!privateView) assert.ok((await graph.children(source, context())).edges.some((edge) => edge.nodeId === seed));
  } else assert.equal(own(mount, 'inputHandoff'), false);
  if (output) {
    const handoff = mount.outputHandoff;
    assert.ok(handoff, 'actual mapping output capture is required');
    assert.equal(handoff.child.beforeCommitIdx, child.commitLog.length);
    const target = node(graph, root, handoff.parent.commitIdx, 'answer');
    const writer = node(graph, child, uniqueStage(child, 'Compute'), 'childAnswer');
    const parents = await graph.parents(target, context());
    assert.equal(
      parents.edges.some((edge) => edge.nodeId === writer),
      !privateView,
    );
    assert.equal(parents.complete, false);
    const result = await cause.explain(graph, target, { includeBackward: true });
    assert.equal(result.backward.confidence, 'incomplete');
    assert.equal(result.rootCause, undefined);
    if (!privateView) {
      assert.ok((await graph.children(writer, context())).edges.some((edge) => edge.nodeId === target));
      if (input) assert.ok(result.backward.nodes.includes(source));
    }
  } else assert.equal(own(mount, 'outputHandoff'), false);
}

async function checkCollections(scopes, cause, reader, privateView = false) {
  const graph = cause.createRecordGraph(scopes);
  const root = scopes.find((scope) => scope.address.drillPath.length === 0);
  const nested = scopes.filter((scope) => scope.commitLog.some((bundle) => bundle.stage === 'Nested items'));
  assert.equal(nested.length, 1);
  assert.equal(root.subflows.collections.length, 1, 'root collection belongs once to root');
  assert.equal(nested[0].subflows.collections.length, 1, 'nested collection belongs once to its own parent');
  const answers = reader.commitValueAt(root.commitLog, root.commitLog.length - 1, 'answers');
  assert.deepEqual(
    answers.map((answer) => answer.branchAnswer),
    [3, 9],
    'ITEMS order follows the reversed selector',
  );
  for (const owner of [root, nested[0]])
    for (const collection of owner.subflows.collections) {
      assert.equal(owner.subflows.status, 'partial');
      assert.equal(collection.totalItems, 2);
      assert.equal(collection.branchCount, 2);
      const target = node(graph, owner, collection.parent.commitIdx, collection.parent.path);
      const parents = await graph.parents(target, context());
      assert.equal(parents.complete, false);
      assert.ok((await graph.gaps(target, context())).some((gap) => gap.code === 'scope-boundary'));
      const remote = new Set(
        scopes
          .filter((scope) => !sameAddress(scope.address, owner.address))
          .flatMap((scope) => [...allNodes(graph, scope)]),
      );
      assert.equal(
        parents.edges.some((edge) => remote.has(edge.nodeId)),
        false,
        'whole-scope slots are nontraversable',
      );
      if (privateView) {
        assert.equal(collection.status, 'partial');
        assert.ok(collection.limitations.includes('privacy-active'));
        assert.deepEqual(collection.slots, []);
      } else {
        assert.deepEqual(
          collection.slots.map((slot) => slot.index),
          [0, 1],
        );
        for (const slot of collection.slots) {
          assert.equal(slot.observation, 'scope-snapshot');
          const child = scopeAt(scopes, slot.child.address);
          assert.equal(slot.child.beforeCommitIdx, child.commitLog.length);
        }
      }
    }
}

function assertDisabled(snapshot) {
  assert.equal(own(snapshot, 'fanoutCollections'), false);
  for (const result of Object.values(snapshot.subflowResults ?? {})) {
    assert.equal(own(result, 'inputHandoff'), false);
    assert.equal(own(result, 'outputHandoff'), false);
    assert.equal(own(result.treeContext, 'fanoutCollections'), false);
  }
}
function generatedInputs(scopes) {
  return scopes
    .flatMap((scope) => scope.subflows.mounts)
    .filter((mount) => scopeAt(scopes, mount.child).commitLog.some((bundle) => bundle.stage === 'Branch'));
}

/** Fixed reviewed producer and both real installed reader formats; no source self-reference. */
export async function verifyNativeSubflows(produce, engine, readers) {
  const modes = [
    ['disabled', {}],
    ['all', { captureInputHandoff: true, captureOutputHandoff: true, captureFanoutHandoff: true }],
    ['input-only', { captureInputHandoff: true }],
    ['output-only', { captureOutputHandoff: true }],
    ['fanout-only', { captureFanoutHandoff: true }],
  ];
  const completed = [];
  for (const [name, capture] of modes) {
    const { snapshot, redacted } = await produce(engine, { writeProvenance: 'reads-prefix', ...capture });
    if (name === 'disabled') {
      assertDisabled(snapshot);
      completed.push({ name, readers: [], rawAndRedacted: false });
      continue;
    }
    for (const [format, { record: reader, cause, paths }] of Object.entries(readers)) {
      const scopes = nativeScopes(snapshot, reader);
      assert.ok(scopes.length > 1);
      assert.ok(scopes.every((scope) => scope.subflows.status === 'partial'));
      await checkMapped(scopes, cause, reader, paths, {
        input: name === 'all' || name === 'input-only',
        output: name === 'all' || name === 'output-only',
      });
      const generated = generatedInputs(scopes);
      assert.ok(generated.length > 0, 'real dispatched branches are required');
      for (const mount of generated) {
        if (name === 'input-only') {
          assert.equal(mount.inputHandoff.status, 'partial');
          assert.ok(mount.inputHandoff.limitations.includes('selector-reads-unavailable'));
          assert.ok(mount.inputHandoff.writes.every((write) => write.reads.length === 0));
        }
        if (name === 'output-only') assert.equal(own(mount, 'inputHandoff'), false);
      }
      if (name === 'all' || name === 'fanout-only') {
        await checkCollections(scopes, cause, reader);
        const privateScopes = nativeScopes(redacted, reader);
        await checkCollections(privateScopes, cause, reader, true);
        if (name === 'all')
          await checkMapped(privateScopes, cause, reader, paths, { input: true, output: true, privateView: true });
      } else assert.ok(scopes.every((scope) => scope.subflows.collections.length === 0));
      completed.push({ name, format, scopes: scopes.length, rawAndRedacted: name === 'all' || name === 'fanout-only' });
    }
  }
  return { protocol: 'native-subflow-provenance-fixture-v1', completed };
}

async function main() {
  const { produce } = require('./produce.cjs');
  const engine = require('footprintjs');
  const readers = {
    esm: {
      record: await import('foottrace'),
      cause: await import('foottrace/cause'),
      paths: await import('foottrace/paths'),
    },
    cjs: { record: require('foottrace'), cause: require('foottrace/cause'), paths: require('foottrace/paths') },
  };
  const result = await verifyNativeSubflows(produce, engine, readers);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
