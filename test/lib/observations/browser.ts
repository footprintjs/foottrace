/** Platform-only test host; production and adjacent assertions remain platform independent. */
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const root = resolve(__dirname, '../../..');
export const bundleBrowser = (contents: string, format: 'iife' | 'esm') =>
  build({
    stdin: { contents, resolveDir: root },
    bundle: true,
    platform: 'browser',
    format,
    target: 'es2022',
    minify: format === 'esm',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });

export const runBrowser = (code: string, globals: Record<string, unknown>): void => {
  runInNewContext(code, globals, {
    timeout: 1000,
    contextCodeGeneration: { strings: false, wasm: false },
  });
};
