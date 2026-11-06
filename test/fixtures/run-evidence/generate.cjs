// Capture what a real engine says about parents, decisions and control, without installing the engine in Foottrace.
//   node test/fixtures/run-evidence/generate.cjs /path/to/an-install > test/fixtures/run-evidence/engine-11.0.0.json
// The install needs footprintjs 11.0.0 and agentfootprint 14.0.0. Everything runs locally: the agent uses a mock provider.
//
// The engine does not write run evidence yet, so this records what S3's seams will hand the writer: each execution's
// `parentRuntimeStageId`, its tracked reads, each decision event, each pause, in the order the real file put its commits.
// `live` is the real `ControlDepRecorder · lookup` for every execution, asked right after its leg.
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { createRequire } = require('node:module');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const require2 = createRequire(resolve(process.argv[2], 'package.json'));
assert.equal(require2('footprintjs/package.json').version, '11.0.0');
assert.equal(require2('agentfootprint/package.json').version, '14.0.0');
const { flowChart, FlowChartExecutor, decide, select, interrupt } = require2('footprintjs');
const { fileSink, readRecordFile } = require2('footprintjs/sinks');
const { controlDepRecorder } = require2('footprintjs/trace');

const stageOf = (id) => id.slice(0, id.lastIndexOf('#'));

function watcher() {
  const seen = { parent: new Map(), reads: new Map(), decisions: new Map(), pauses: new Map(), description: new Map(), order: [] };
  const note = (t) => {
    if (!t?.runtimeStageId) return;
    if (!seen.parent.has(t.runtimeStageId)) {
      seen.parent.set(t.runtimeStageId, t.parentRuntimeStageId);
      seen.order.push(t.runtimeStageId);
    }
  };
  const flow = {
    id: 'evidence-flow',
    onStageExecuted(e) {
      note(e.traversalContext);
      if (e.description && e.traversalContext) seen.description.set(e.traversalContext.runtimeStageId, e.description);
    },
    onSubflowEntry: (e) => note(e.traversalContext),
    onError: (e) => note(e.traversalContext),
    onPause(e) {
      const t = e.traversalContext;
      note(t);
      if (t) seen.pauses.set(t.runtimeStageId, { id: t.runtimeStageId, by: 'pause', payload: e.pauseData });
    },
    onDecision(e) {
      const t = e.traversalContext;
      seen.decisions.set(t.runtimeStageId, {
        id: t.runtimeStageId,
        by: e.evidence ? 'decide' : 'plain',
        chosen: e.chosen,
        ...(e.rationale && { rationale: e.rationale }),
        ...(e.evidence && { evidence: e.evidence }),
      });
    },
    onSelected(e) {
      const t = e.traversalContext;
      seen.decisions.set(t.runtimeStageId, {
        id: t.runtimeStageId,
        by: e.evidence ? 'select' : 'plain',
        chosen: e.selected,
        total: e.total,
        ...(e.evidence && { evidence: e.evidence }),
      });
    },
  };
  const scope = {
    id: 'evidence-scope',
    onRead(e) {
      if (!e.key || !e.runtimeStageId) return;
      const held = seen.reads.get(e.runtimeStageId) ?? new Set();
      held.add(e.key);
      seen.reads.set(e.runtimeStageId, held);
    },
  };
  return { seen, flow, scope };
}

/** The rows of one file: its arrival order, with the evidence S3 will write beside each commit. */
function rowsOf(file, seen, reEntry, runIds) {
  const logOf = (a) => [runIds.get(a.logRunId) ?? (runIds.set(a.logRunId, `run-${runIds.size + 1}`), runIds.get(a.logRunId)), ...a.drillPath];
  const lines = readRecordFile(file).entries;
  const committed = new Set(lines.filter((e) => e.kind === 'commit').map((e) => e.bundle.runtimeStageId));
  const mountIds = new Set(lines.filter((e) => e.kind === 'opened').map((e) => e.address.drillPath.at(-1)));
  const rows = [];
  const firstSeen = new Set();
  const written = new Map();
  const noteIn = (log, note, data) => rows.push({ kind: 'note', log, note, data });
  const movedResumes = (id) => (reEntry?.path.has(stageOf(id)) && reEntry.leg.has(id) ? { resumes: reEntry.paused } : {});
  for (const e of lines) {
    const log = logOf(e.address);
    if (e.kind === 'opened') {
      if (e.address.drillPath.length > 0) {
        const id = e.address.drillPath.at(-1);
        const parent = seen.parent.get(id);
        noteIn(log.slice(0, -1), 'run.stage', { id, ...(parent && { parent }), ...movedResumes(id) });
      }
      if (!written.has(JSON.stringify(log))) rows.push({ kind: 'opened', log });
      written.set(JSON.stringify(log), true);
    } else if (e.kind === 'commit') {
      const id = e.bundle.runtimeStageId;
      const seed = e.address.drillPath.at(-1) === id;
      const first = !seed && e.bundle.phase === undefined && !firstSeen.has(id);
      if (first) firstSeen.add(id);
      const reads = seen.reads.get(id);
      const parent = seen.parent.get(id);
      // An execution with no commit of its own (a fork node with no function) gets its `run.stage` before its first child.
      if (first && parent && !committed.has(parent) && !mountIds.has(parent) && !firstSeen.has(parent)) {
        firstSeen.add(parent);
        const up = seen.parent.get(parent);
        noteIn(log, 'run.stage', { id: parent, ...(up && { parent: up }) });
      }
      const description = seen.description.get(id);
      rows.push({
        kind: 'commit',
        log,
        id,
        ...(e.bundle.phase && { phase: e.bundle.phase }),
        ...(e.bundle.untrackedSources && { untracked: e.bundle.untrackedSources }),
        ...(first && {
          about: {
            ...(parent && { parent }),
            ...movedResumes(id),
            ...(reads && { reads: [...reads] }),
            ...(description && { description }),
          },
        }),
      });
      if (first && seen.decisions.has(id)) noteIn(log, 'run.decision', seen.decisions.get(id));
      if (first && seen.pauses.has(id)) noteIn(log, 'run.stop', seen.pauses.get(id));
    } else if (e.kind === 'closed') rows.push({ kind: 'closed', log, outcome: e.outcome });
  }
  return rows;
}

function liveOf(ctrl, seen) {
  return Object.fromEntries(
    seen.order.map((id) => {
      const found = ctrl.lookup(id);
      return [id, found ? { decider: found.deciderId, ...(found.label !== undefined && { label: found.label }) } : null];
    }),
  );
}

async function runChart(chart, input, dir, name) {
  const file = join(dir, `${name}.jsonl`);
  const sink = fileSink(file);
  const executor = new FlowChartExecutor(chart, { sink });
  const ctrl = controlDepRecorder();
  const { seen, flow, scope } = watcher();
  executor.attachFlowRecorder(ctrl);
  executor.attachFlowRecorder(flow);
  executor.attachScopeRecorder(scope);
  await executor.run(input);
  await sink.close();
  const runIds = new Map();
  return { legs: ['run-1'], rows: rowsOf(file, seen, undefined, runIds), live: liveOf(ctrl, seen) };
}

function branchesChart() {
  const inner = flowChart('Open case', (s) => { s.caseScore = s.riskScore; }, 'open-case', 'Open a case')
    .addDeciderFunction('Assign reviewer', (s) => decide(s, [
      { when: { caseScore: { gte: 70 } }, then: 'senior', label: 'High risk' },
      { when: (x) => x.caseScore >= 40, then: 'junior', label: 'Medium risk' },
    ], { branch: 'junior', label: 'Nothing matched' }), 'assign-reviewer', 'Pick who reviews')
      .addFunctionBranch('senior', 'Senior review', (s) => { s.outcome = 'conditions'; })
      .addFunctionBranch('junior', 'Junior review', (s) => { s.outcome = 'approved'; })
      .setDefault('junior')
      .end()
    .addFunction('Close case', (s) => { s.closed = s.outcome; }, 'close-case', 'Close the case')
    .build();
  return flowChart('Receive', (s) => { s.riskScore = 55; s.passes = 0; s.amount = 240000; }, 'receive', 'Receive it')
    .addDeciderFunction('Route', (s) => decide(s, [
      { when: { riskScore: { lt: 30 } }, then: 'auto', label: 'Low risk' },
      { when: { riskScore: { gte: 30, lt: 90 } }, then: 'manual', label: 'Middle band' },
    ], 'manual'), 'route', 'Choose how')
      .addFunctionBranch('auto', 'Auto', (s) => { s.route = 'auto'; })
      .addSubFlowChartBranch('manual', inner, 'Manual review', {
        inputMapper: (s) => ({ riskScore: s.riskScore }),
        outputMapper: (o) => ({ route: o.outcome }),
      })
      .setDefault('manual')
      .end()
    .addSelectorFunction('Choose checks', (s) => select(s, [
      { when: { riskScore: { gte: 40 } }, then: 'income', label: 'Check income' },
      { when: (x) => x.amount > 200000, then: 'property', label: 'Check property' },
      { when: { riskScore: { gte: 99 } }, then: 'fraud', label: 'Check fraud' },
    ]), 'choose-checks', 'Pick checks')
      .addFunctionBranch('income', 'Income', (s) => { s.income = 1; })
      .addFunctionBranch('property', 'Property', (s) => { s.property = s.amount; })
      .addFunctionBranch('fraud', 'Fraud', (s) => { s.fraud = 1; })
      .end()
    .addFunction('Draft', (s) => { s.passes = s.passes + 1; }, 'draft', 'Draft terms')
    .addDeciderFunction('Check', (s) => decide(s, [
      { when: (x) => x.passes >= 3, then: 'accept', label: 'Enough passes' },
      { when: { passes: { lt: 3 } }, then: 'redraft', label: 'Can improve' },
    ], 'accept'), 'check', 'Good enough?')
      .addFunctionBranch('accept', 'Accept', (s) => { s.accepted = true; })
      .addFunctionBranch('redraft', 'Redraft', (s) => { s.why = s.passes; }, 'Go round again', { loopTo: 'draft' })
      .setDefault('accept')
      .end()
    .addListOfFunction([
      { id: 'notify-a', name: 'Notify A', fn: (s) => { s.a = 1; } },
      { id: 'notify-b', name: 'Notify B', fn: (s) => { s.b = 1; } },
    ])
    .addFunction('Finish', (s) => { s.done = s.route; }, 'finish', 'Finish')
    .build();
}

function resumeChart() {
  const deep = flowChart('Ask', (x) => { x.answer = interrupt(x, { question: 'approve?' }); }, 'ask')
    .addFunction('Use', (x) => { x.used = x.answer; }, 'use')
    .build();
  const mid = flowChart('Mid start', (x) => { x.m = 1; }, 'mid-start')
    .addSubFlowChart('deep', deep, 'Deep', { inputMapper: () => ({}), outputMapper: (o) => ({ used: o.used }) })
    .addFunction('Mid end', (x) => { x.e = x.used; }, 'mid-end')
    .build();
  return flowChart('Start', (x) => { x.v = 2; }, 'start')
    .addDeciderFunction('Gate', (x) => decide(x, [{ when: { v: { gt: 1 } }, then: 'go', label: 'Over one' }], 'skip'), 'gate')
      .addSubFlowChartBranch('go', mid, 'Sub', { inputMapper: () => ({}), outputMapper: (o) => ({ used: o.used }) })
      .addFunctionBranch('skip', 'Skip', () => undefined)
      .setDefault('skip')
      .end()
    .addFunction('After', (x) => { x.done = true; }, 'after')
    .build();
}

async function runResume(mode, dir) {
  const file = join(dir, `resume-${mode}.jsonl`);
  const sink = fileSink(file);
  const chart = resumeChart();
  const first = new FlowChartExecutor(chart, { sink });
  const ctrl = controlDepRecorder();
  const { seen, flow, scope } = watcher();
  first.attachFlowRecorder(ctrl);
  first.attachFlowRecorder(flow);
  first.attachScopeRecorder(scope);
  const result = await first.run();
  const checkpoint = result.checkpoint ?? first.getCheckpoint();
  const live = liveOf(ctrl, seen);
  const before = new Set(seen.order);
  const second = mode === 'same' ? first : new FlowChartExecutor(chart, { sink });
  if (mode === 'fresh') {
    second.attachFlowRecorder(flow);
    second.attachScopeRecorder(scope);
  }
  await second.resume(checkpoint, 'yes');
  await sink.close();
  const leg = new Set(seen.order.filter((id) => !before.has(id)));
  const path = new Set([...(checkpoint.subflowPath ?? []), checkpoint.pausedStageId]);
  const runIds = new Map();
  const rows = rowsOf(file, seen, { path, leg, paused: checkpoint.pausedExecution.runtimeStageId }, runIds);
  return { legs: [...runIds.values()], rows, live, resumed: [...leg] };
}

async function runAgent(dir) {
  const { Agent, defineTool } = require2('agentfootprint');
  const { mock } = require2('agentfootprint/providers');
  const lookup = defineTool({ name: 'lookup', description: 'look up', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, execute: async ({ q }) => `rows for ${q}` });
  const provider = mock({ replies: [
    { toolCalls: [{ id: 'c1', name: 'lookup', args: { q: 'ports' } }] },
    { toolCalls: [{ id: 'c2', name: 'lookup', args: { q: 'switch' } }] },
    { content: 'done' },
  ] });
  const agent = Agent.create({ provider, model: 'mock' }).system('You help.').tool(lookup).build();
  return runChart(agent.getSpec(), { input: { message: 'Which ports?', identity: { conversationId: 'c1' } } }, dir, 'agent');
}

(async () => {
  console.warn = () => {};
  const dir = mkdtempSync(join(tmpdir(), 'foottrace-run-evidence-'));
  try {
    const scenarios = {
      branches: await runChart(branchesChart(), undefined, dir, 'branches'),
      agent: await runAgent(dir),
      'resume-same': await runResume('same', dir),
      'resume-fresh': await runResume('fresh', dir),
    };
    process.stdout.write(`${JSON.stringify({ footprintjs: '11.0.0', agentfootprint: '14.0.0', scenarios })}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
