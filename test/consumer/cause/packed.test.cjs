const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

// This consumer runs after the ordinary build, against its real offline pack.
test('packed cause option works through actual CJS and ESM public exports', { timeout: 90000 }, () => {
  const root = path.resolve(__dirname, '../../..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'foottrace-cause-consumer-'));
  try {
    const packed = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath,
      'pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', temporary,
    ], { cwd: root, encoding: 'utf8', timeout: 30000 }));
    assert.equal(packed.length, 1);
    const archive = path.join(temporary, packed[0].filename);
    const bytes = fs.readFileSync(archive);
    assert.equal(createHash('sha1').update(bytes).digest('hex'), packed[0].shasum);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', timeout: 30000 }).trim().split('\n');
    assert.ok(entries.every((name) => name.startsWith('package/') && !name.split('/').includes('..')));
    execFileSync('tar', ['-xzf', archive, '-C', temporary], { timeout: 30000 });
    const consumer = path.join(temporary, 'consumer');
    const modules = path.join(consumer, 'node_modules');
    fs.mkdirSync(modules, { recursive: true });
    fs.renameSync(path.join(temporary, 'package'), path.join(modules, 'foottrace'));
    fs.writeFileSync(path.join(consumer, 'package.json'), '{"private":true,"type":"module"}');
    const assertions = `
      const good = {kind:'error',reason:'ERROR_RECORDED',evidence:['proof']};
      const graph = { parents:()=>({edges:[],complete:true}), children:()=>({edges:[],complete:true}),
        gaps:()=>[], attention:()=>[good,{kind:'error',reason:'INVALID_PRIVATE',evidence:['private']}] };
      const result = await explain(graph,'selected',{attentionAdmission:'retain-valid'});
      assert.deepEqual(result.attention,[good]);
      assert.equal(result.rootCause,undefined);
      assert.equal(result.confidence,'incomplete');
      assert.deepEqual(result.gaps,[{code:'invalid-data',nodeId:'selected',evidence:[]}]);
      assert.equal(Object.isFrozen(result.attention[0].evidence),true);
      assert.deepEqual((await explain(graph,'selected')).attention,[]);
      const list = await attentionList(graph,{nodeIds:['selected'],attentionAdmission:'retain-valid'});
      assert.deepEqual(list.nodes,[{nodeId:'selected',attention:[good]}]);
      assert.equal(list.confidence,'incomplete');
      assert.equal(JSON.stringify(list).includes('INVALID_PRIVATE'),false);
    `;
    const cjs = path.join(consumer, 'consumer.cjs');
    const esm = path.join(consumer, 'consumer.mjs');
    fs.writeFileSync(cjs, `const assert=require('node:assert/strict');
      const {explain,attentionList}=require('foottrace/cause');
      assert.ok(require.resolve('foottrace/cause').startsWith(__dirname+'/node_modules/foottrace/'));
      (async()=>{${assertions}})().catch(error=>{console.error(error);process.exitCode=1;});`);
    fs.writeFileSync(esm, `import assert from 'node:assert/strict';
      import {explain,attentionList} from 'foottrace/cause';
      assert.ok(import.meta.resolve('foottrace/cause').startsWith(new URL('./node_modules/foottrace/',import.meta.url).href));
      ${assertions}`);
    execFileSync(process.execPath, [cjs], { cwd: consumer, stdio: 'pipe', timeout: 30000 });
    execFileSync(process.execPath, [esm], { cwd: consumer, stdio: 'pipe', timeout: 30000 });
    console.log(JSON.stringify({ proof: 'packed-cause-cjs-esm', name: packed[0].name,
      version: packed[0].version, shasum: packed[0].shasum, sha256, integrity: packed[0].integrity,
      formats: ['CJS', 'ESM'], resolution: 'actual unpacked node_modules package', installs: 0 }));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
