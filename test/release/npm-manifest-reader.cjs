'use strict';
// npm11.19 publish.js#getManifest uses this exact pacote manifest call.
// This child receives no inherited credential/OIDC/config environment.
const path = require('node:path'),
  fs = require('node:fs');
const root = process.argv[3];
if (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version !== '11.19.0')
  throw Error('pinned-npm-reader-required');
const pacote = require(path.join(root, 'node_modules/pacote')),
  npa = require(path.join(root, 'node_modules/npm-package-arg'));
(async () => {
  try {
    const m = await pacote.manifest(npa(path.resolve(process.argv[2])), {
      cache: process.env.NPM_TEST_CACHE,
      offline: true,
      ignoreScripts: true,
      fullMetadata: true,
      fullReadJson: true,
    });
    console.log(JSON.stringify({ name: m.name, version: m.version, hasPublishConfig: Boolean(m.publishConfig) }));
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'NPM_READER_REFUSED';
    console.log(JSON.stringify({ error: code }));
  }
})().catch(() => {
  process.exitCode = 1;
});
