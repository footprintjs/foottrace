// Capture engine loop events and live control without adding an engine dependency to Foottrace.
// node generate-loops.cjs /path/to/footprintjs-14.1.0-install > engine-loops-14.1.0.json
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');

const load = createRequire(resolve(process.argv[2], 'package.json'));
assert.equal(load('footprintjs/package.json').version, '14.1.0');
assert.equal(load('foottrace/package.json').version, '2.2.0');
const { FlowChartExecutor, flowChart, decide, select, interrupt } = load('footprintjs');
const { controlDepRecorder } = load('footprintjs/trace');
const { memorySink } = load('foottrace/write');

const noop = () => {};
const more = (scope) => decide(scope, [{ when: { left: { gt: 0 } }, then: 'again', label: 'Rounds remain' }], 'leave');

function loopBody(start, options = {}) {
  let body = start.addFunction(
    'Work',
    (s) => {
      s.history = [...(s.history ?? []), s.left];
    },
    'work',
  );
  if (options.parallel) {
    body = body
      .addListOfFunction([
        { id: 'left-child', name: 'Left child', fn: noop },
        { id: 'right-child', name: 'Right child', fn: noop },
      ])
      .addFunction('Join', noop, 'join');
  }
  if (options.pause) {
    body = body.addFunction(
      'Ask',
      (s) => {
        if (s.left === 1 && s.answer === undefined) s.answer = interrupt(s, { question: 'Continue?' });
      },
      'ask',
    );
  }
  if (options.late) {
    body = body
      .addDeciderFunction('Pick', (s) => (s.left === 0 ? 'late' : 'early'), 'pick')
      .addFunctionBranch('early', 'Early', noop)
      .addFunctionBranch('late', 'Only the last pass', noop)
      .end();
  }
  return body
    .addDeciderFunction('More?', more, 'more')
    .addFunctionBranch(
      'again',
      'Again',
      (s) => {
        s.left--;
      },
      undefined,
      { loopTo: 'work' },
    )
    .addFunctionBranch('leave', 'Leave', noop)
    .end()
    .addFunction('After', noop, 'after');
}

const seed = (count) =>
  flowChart(
    'Seed',
    (s) => {
      s.left = count;
      s.history = [];
    },
    'seed',
  );

function branch(kind) {
  const child = loopBody(seed(2)).build();
  const root = flowChart('Start', noop, 'start');
  const dispatch =
    kind === 'decide'
      ? root.addDeciderFunction('Route', () => 'looped', 'route')
      : root.addSelectorFunction(
          'Route',
          (s) =>
            select(s, [
              { when: () => true, then: 'looped' },
              { when: () => true, then: 'plain' },
            ]),
          'route',
        );
  return dispatch
    .addSubFlowChartBranch('looped', child, 'Looped', { inputMapper: () => ({}), outputMapper: () => ({}) })
    .addFunctionBranch('plain', 'Plain', noop)
    .end()
    .addFunction('Outside', noop, 'outside')
    .build();
}

function nested() {
  return loopBody(
    flowChart(
      'Seed',
      (s) => {
        s.outer = 1;
      },
      'seed',
    ).addFunction(
      'Outer work',
      (s) => {
        s.left = 1;
      },
      'outer-work',
    ),
  )
    .addDeciderFunction('Outer gate', (s) => (s.outer > 0 ? 'round' : 'done'), 'outer-gate')
    .addFunctionBranch(
      'round',
      'Round',
      (s) => {
        s.outer--;
      },
      undefined,
      { loopTo: 'outer-work' },
    )
    .addFunctionBranch('done', 'Done', noop)
    .end()
    .addFunction('After all loops', noop, 'after-all')
    .build();
}

async function capture(chart, commitValues, pause = false) {
  const sink = memorySink();
  const executor = new FlowChartExecutor(chart, { sink, commitValues });
  const ctrl = controlDepRecorder();
  const stages = new Map();
  const decisions = new Map();
  const loops = new Map();
  function stage(ctx) {
    if (ctx && !stages.has(ctx.runtimeStageId)) stages.set(ctx.runtimeStageId, ctx.parentRuntimeStageId);
  }
  executor.attachFlowRecorder(ctrl);
  executor.attachFlowRecorder({
    id: 'loop-evidence-fixture',
    onStageExecuted: ({ traversalContext }) => stage(traversalContext),
    onSubflowEntry: ({ traversalContext }) => stage(traversalContext),
    onPause: ({ traversalContext }) => stage(traversalContext),
    onLoop({ traversalContext, target }) {
      if (!traversalContext) throw new Error('fixture requires a loop source');
      // This engine event exposes the display name. Translate only these charts' declared names;
      // the engine-side writer will record the resolved node id directly.
      const id = target.replace(/Work$/, 'work').replace(/Outer work$/, 'outer-work');
      loops.set(traversalContext.runtimeStageId, id);
    },
    onDecision({ traversalContext: ctx, chosen, evidence }) {
      if (ctx)
        decisions.set(ctx.runtimeStageId, { by: evidence ? 'decide' : 'plain', chosen, ...(evidence && { evidence }) });
    },
    onSelected({ traversalContext: ctx, selected, total, evidence }) {
      if (ctx)
        decisions.set(ctx.runtimeStageId, {
          by: evidence ? 'select' : 'plain',
          chosen: selected,
          total,
          ...(evidence && { evidence }),
        });
    },
  });
  const result = await executor.run();
  const before = new Map(Array.from(stages, ([id]) => [id, ctrl.lookup(id)]));
  const resumes = {};
  if (pause) {
    assert.ok(result.checkpoint, 'paused inside the loop');
    const { pausedExecution, pausedStageId } = result.checkpoint;
    await executor.resume(result.checkpoint, 'yes');
    const standIn = [...stages.keys()].find(
      (id) => !before.has(id) && id.slice(0, id.lastIndexOf('#')) === pausedStageId,
    );
    assert.ok(standIn, 'resumed stand-in');
    resumes[standIn] = pausedExecution.runtimeStageId;
  }
  const realRunIds = [...new Set(sink.entries.map(({ address }) => address.logRunId))];
  const legs = realRunIds.map((_, i) => (i === 0 ? 'r' : `r-${i + 1}`));
  // Neither capture clock nor run correlation participates in the control law.
  const entries = sink.entries
    .filter(({ kind }) => kind !== 'note')
    .map(({ meta, ...entry }, at) => ({
      ...entry,
      at,
      address: { ...entry.address, logRunId: legs[realRunIds.indexOf(entry.address.logRunId)] },
    }));
  const live = Array.from(stages, ([id, parent]) => {
    const control = before.has(id) ? before.get(id) : ctrl.lookup(id);
    return { id, parent, control };
  });
  for (const [id, target] of loops) {
    assert.equal(typeof target, 'string', id);
    const execution = live.find((row) => row.parent === id);
    assert.ok(execution, `re-entry of ${id}`);
    assert.equal(execution.id.slice(0, execution.id.lastIndexOf('#')), target);
  }
  return { entries, live, legs, resumes, decisions: Object.fromEntries(decisions), loops: Object.fromEntries(loops) };
}

async function main() {
  const scenarios = [];
  for (const commitValues of ['full', 'delta']) {
    for (const [name, build] of [
      ...[0, 1, 3].map((count) => [`${count} back-edges`, () => loopBody(seed(count)).build()]),
      ['decider branch', () => branch('decide')],
      ['selector branch', () => branch('select')],
      ['nested', nested],
      ['parallel body', () => loopBody(seed(2), { parallel: true }).build()],
      ['last pass first entry', () => loopBody(seed(2), { late: true }).build()],
      ['pause in the body', () => loopBody(seed(2), { pause: true }).build()],
    ]) {
      scenarios.push({ name, commitValues, ...(await capture(build(), commitValues, name === 'pause in the body')) });
    }
  }
  for (const kind of ['full', 'delta']) {
    const recorded = scenarios.find((s) => s.name === '1 back-edges' && s.commitValues === kind);
    assert.ok(
      recorded.entries.some((entry) =>
        entry.bundle?.trace.some((row) => row.path === 'history' && row.verb === (kind === 'delta' ? 'append' : 'set')),
      ),
    );
  }
  process.stdout.write(JSON.stringify(scenarios) + '\n');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
