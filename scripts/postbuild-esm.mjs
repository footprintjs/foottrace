/**
 * postbuild-esm — mark the ESM build as TRUE ESM.
 *
 * tsc emits dist/esm/*.js with ESM syntax + explicit `.js` import extensions,
 * but Node only treats them as ESM when a `package.json` with
 * `"type":"module"` sits alongside. Without it, Node loads them via
 * syntax-detection fallback (MODULE_TYPELESS_PACKAGE_JSON warning + per-file
 * reparse) and stricter loaders can fail. This writes that 2-line manifest.
 *
 * Safe because every relative import in src already carries a `.js` extension
 * (true-ESM-resolvable) and src makes no `require()` call.
 *
 * `sideEffects: false` MUST be repeated here: bundlers resolve sideEffects from
 * the NEAREST enclosing package.json, so this manifest would otherwise shadow
 * the root declaration for every ESM file.
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';

writeFileSync(
  new URL('../dist/esm/package.json', import.meta.url),
  JSON.stringify({ type: 'module', sideEffects: false }, null, 0) + '\n',
);
console.log('postbuild-esm: wrote dist/esm/package.json {type:module, sideEffects:false} ✓');

// Keep the producer and the consumer on the same synthetic wire controls.
const fixtureDirectory = new URL('../dist/fixtures/', import.meta.url);
mkdirSync(fixtureDirectory, { recursive: true });
copyFileSync(
  new URL('../test/fixtures/source-links/v1.json', import.meta.url),
  new URL('source-links-v1.json', fixtureDirectory),
);
