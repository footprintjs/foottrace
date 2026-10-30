'use strict';
const fs = require('node:fs');
const path = require('node:path');
const child = require('node:child_process');
const runtime = require('./release-github.cjs');
const { outputLines } = require('./release-control.cjs');
const ROOT = path.resolve(__dirname, '..');
const STAGES = new Set([
  'plan',
  'prepare',
  'proposal',
  'authority',
  'verdict',
  'build-manifest',
  'release',
  'publish',
  'verify',
]);
const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};
function createIo(env) {
  const git = (args) => child.execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }).trim();
  const publishFile = (run, attempt) => {
    if (typeof env.RUNNER_TEMP !== 'string' || !path.isAbsolute(env.RUNNER_TEMP)) fail('publish-directory');
    const temp = path.resolve(env.RUNNER_TEMP),
      relative = path.relative(ROOT, temp);
    if (!relative || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) fail('publish-directory');
    if (!Number.isSafeInteger(run) || run <= 0 || !Number.isSafeInteger(attempt) || attempt <= 0)
      fail('publish-directory');
    return path.join(temp, `foottrace-publish-${run}-${attempt}`, 'package.tgz');
  };
  return {
    head: () => git(['rev-parse', 'HEAD']),
    gitTree: () => git(['rev-parse', 'HEAD^{tree}']),
    requireClean: () => git(['diff', '--exit-code', 'HEAD']),
    read: (name) => fs.readFileSync(path.resolve(ROOT, name)),
    write: (name, bytes) => {
      const local = [
        'release-artifact/proposal.json',
        'release-artifact/manifest.json',
        'release-artifact/package.tgz',
      ];
      if (!local.includes(name) && name !== publishFile(Number(env.RUN_ID), Number(env.RUN_ATTEMPT)))
        fail('output-path');
      const file = path.resolve(ROOT, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes, { flag: 'wx' });
    },
    publishFile,
    appendOutput: (file, bytes) => fs.appendFileSync(file, bytes),
    appendSummary: (file, bytes) => fs.appendFileSync(file, bytes),
  };
}
async function runCli(argv, options = {}) {
  if (!Array.isArray(argv) || argv.length !== 1 || !STAGES.has(argv[0])) fail('stage');
  const stage = argv[0],
    env = options.env ?? process.env;
  const context = runtime.withRefusalSync('runner-context', () => runtime.environmentContext(env));
  if (!['push', 'workflow_dispatch'].includes(context.eventName) || context.ref !== 'refs/heads/main') fail('event');
  if (typeof env.GITHUB_OUTPUT !== 'string' || !path.isAbsolute(env.GITHUB_OUTPUT)) fail('runner-output');
  if (stage === 'verify' && (typeof env.GITHUB_STEP_SUMMARY !== 'string' || !path.isAbsolute(env.GITHUB_STEP_SUMMARY)))
    fail('runner-summary');
  const io = options.io ?? createIo(env);
  if (runtime.withRefusalSync('runner-checkout', () => io.head()) !== context.sha) fail('checkout-sha');
  const result = await runtime.withRefusal(`runner-${stage}`, () =>
    runtime.runStage(stage, {
      api: options.api ?? runtime.makeApi(env.GH_TOKEN, options.fetcher),
      context,
      env,
      io,
      fetcher: options.fetcher,
    }),
  );
  const lines = runtime.withRefusalSync('runner-output-encode', () => outputLines(result));
  runtime.withRefusalSync('runner-output-write', () => io.appendOutput(env.GITHUB_OUTPUT, lines));
  if (stage === 'verify')
    runtime.withRefusalSync('runner-summary-write', () =>
      io.appendSummary(env.GITHUB_STEP_SUMMARY, result.verification + '\n'),
    );
  return result;
}
module.exports = { createIo, runCli };
if (require.main === module)
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(runtime.refusalCode(error));
    process.exitCode = 1;
  });
