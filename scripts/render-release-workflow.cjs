'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { createHash } = require('node:crypto');
const { brotliCompressSync, constants } = require('node:zlib');
const modules = ['changes', 'release-prepare', 'release-control', 'release-archive', 'release-github'];
function inline(stage, root = path.resolve(__dirname, '..')) {
  const definitions = modules
    .map(
      (name) =>
        `${JSON.stringify(`./${name}.cjs`)}:function(module,exports,require){\n${fs.readFileSync(
          path.join(root, `scripts/${name}.cjs`),
          'utf8',
        )}\n}`,
    )
    .join(',\n');
  return `"use strict";\nreturn (async()=>{\nconst nativeRequire=require;\nconst definitions={${definitions}};\nconst loaded=Object.create(null);\nfunction load(name){if(name.startsWith("node:"))return nativeRequire(name);if(!Object.prototype.hasOwnProperty.call(definitions,name))throw new Error("module-refused");if(loaded[name])return loaded[name].exports;const module={exports:{}};loaded[name]=module;definitions[name](module,module.exports,load);return module.exports;}\nconst runtime=load("./release-github.cjs");\nconst fs=nativeRequire("node:fs"),path=nativeRequire("node:path"),child=nativeRequire("node:child_process");\nconst env=process.env,context=runtime.environmentContext(env);\nconst io={read:name=>fs.readFileSync(name),write:(name,bytes)=>{fs.mkdirSync(path.dirname(name),{recursive:true});fs.writeFileSync(name,bytes,{flag:"wx"});},gitTree:()=>child.execFileSync("git",["rev-parse","HEAD^{tree}"],{encoding:"utf8"}).trim(),requireClean:()=>child.execFileSync("git",["diff","--exit-code","HEAD"]),publishFile:(run,attempt)=>path.join(env.RUNNER_TEMP,\`foottrace-publish-\${run}-\${attempt}\`,"package.tgz")};\nconst result=await runtime.runStage(${JSON.stringify(
    stage,
  )},{api:runtime.makeApi(env.GH_TOKEN),context,env,io});\nfs.appendFileSync(env.GITHUB_OUTPUT,load("./release-control.cjs").outputLines(result));\n})().catch(error=>{console.error(error.code??error.message??"release-failed");process.exitCode=1;});`;
}
// Compression is only transport for trusted checked-in workflow source. The decoded
// bytes are capped and hash-bound before execution; no artifact supplies code.
function emitted(stage, root = path.resolve(__dirname, '..')) {
  const program = Buffer.from(inline(stage, root));
  const digest = createHash('sha256').update(program).digest('hex');
  const payload = brotliCompressSync(program, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT },
  }).toString('base64');
  return `"use strict";\n(async()=>{\nconst payload=${JSON.stringify(
    payload,
  )};\nconst program=require("node:zlib").brotliDecompressSync(Buffer.from(payload,"base64"),{maxOutputLength:${
    program.length
  }});\nif(program.length!==${
    program.length
  }||require("node:crypto").createHash("sha256").update(program).digest("hex")!==${JSON.stringify(
    digest,
  )})throw new Error("trusted-program-integrity");\nreturn new Function("require","process",program.toString("utf8"))(require,process);\n})().catch(error=>{console.error(error.code??error.message??"release-failed");process.exitCode=1;});`;
}
function render(root = path.resolve(__dirname, '..')) {
  const template = fs.readFileSync(path.join(root, 'scripts/release-workflow-template.yml'), 'utf8');
  const result = template.replace(/^([ ]*)@@INLINE:([a-z-]+)@@$/gm, (_, indent, stage) => {
    const body = `# trusted-stage: ${stage}\nnode <<'FOOTTRACE_RELEASE'\n${emitted(stage, root)}\nFOOTTRACE_RELEASE`;
    if (body.length > 21000) throw new Error('Generated control run exceeds 21000 characters');
    return body
      .split('\n')
      .map((line) => (line ? indent + line : ''))
      .join('\n');
  });
  // Use decimal KB conservatively; never depend on a larger interpretation.
  if (Buffer.byteLength(result) > 500000) throw new Error('Generated workflow exceeds 500 KB');
  return result;
}
module.exports = { inline, emitted, render };
if (require.main === module) {
  const result = render(),
    file = path.resolve(__dirname, '../.github/workflows/publish.yml');
  if (process.argv.includes('--check')) {
    if (fs.readFileSync(file, 'utf8') !== result) throw new Error('Generated release workflow differs');
  } else fs.writeFileSync(file, result);
}
