import { expect, it } from 'vitest';
import { bundleBrowser, runBrowser } from '../../../test/lib/observations/browser.js';

it('does not require optional globals for an unrelated CJS writer import', async () => {
  const bundled = await bundleBrowser(
    `const {memorySink} = require('./src/write.ts'); globalThis.count = memorySink().entries.length;`,
    'iife',
  );
  const sandbox: Record<string, unknown> = {};
  runBrowser(bundled.outputFiles[0].text, sandbox);
  expect(sandbox.count).toBe(0);
  expect(sandbox.TextEncoder).toBeUndefined();
  expect(sandbox.process).toBeUndefined();
});

it('keeps optional canonical/value capability modules outside an unrelated root dependency graph', async () => {
  const bundled = await bundleBrowser(
    'import {buildAttemptId} from "./src/index.ts"; console.log(buildAttemptId("node#1",1));',
    'esm',
  );
  expect(
    Object.keys(bundled.metafile!.inputs).filter((name) => /lib[/\\](values|canonical-json)[/\\]/.test(name)),
  ).toEqual([]);
});
