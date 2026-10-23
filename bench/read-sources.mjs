/** Offline native-read microbenchmark. Build first; compare an unchanged built main via --baseline. */
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { cpus, platform, arch } from 'node:os';
const require = createRequire(import.meta.url);
const api = require('../dist/write.js');
const { createOriginIndex } = require('../dist/lib/read-sources/originIndex.js');
const baselineArg = process.argv.indexOf('--baseline');
if (!global.gc || baselineArg < 0 || !process.argv[baselineArg + 1])
  throw new Error('Use node --expose-gc bench/read-sources.mjs --baseline /path/to/built/main');
const baseline = require(resolve(process.argv[baselineArg + 1], 'dist/write.js'));
const owner = { runtimeStageId: 'reader#0', attemptId: 'reader#0@1' };
const address = { logRunId: 'benchmark', drillPath: [] };
const median = xs => [...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
let checksum = 0;
function reads(library, enabled) {
  const state = new library.SharedMemory(undefined, { count: 1 });
  const record = enabled ? library.createReadSourceRecord(state, address) : undefined;
  const frame = new library.RecordFrame(state, record?.log);
  const start = performance.now();
  for (let i=0;i<1000;i++) checksum += Number(enabled ? frame.readWithSource([], 'count', owner).value : frame.read([], 'count'));
  const ns = (performance.now()-start)*1e6/1000;
  return { ns, record };
}
for (let warm=0;warm<20;warm++) { reads(baseline,false);reads(api,false);reads(api,true); }
const timing = { mainOff:[], candidateOff:[], candidateOn:[] };
for (let sample=0;sample<21;sample++) {
  global.gc();
  timing.mainOff.push(reads(baseline,false).ns);
  timing.candidateOff.push(reads(api,false).ns);
  timing.candidateOn.push(reads(api,true).ns);
}
function retained(build, copies) {
  global.gc(); const before=process.memoryUsage().heapUsed;
  const held = Array.from({length:copies},build);
  global.gc(); const bytes=(process.memoryUsage().heapUsed-before)/copies;
  if (!held.length) throw new Error('missing retained evidence');
  return Math.max(0,bytes);
}
function index(versions) {
  const out=createOriginIndex(10000,1);
  if (versions) {
    out.seed({count:1});
    for(let i=1;i<10000;i++) out.write(['count'],{kind:'committed',commitIdx:i-1});
  } else out.seed(Object.fromEntries(Array.from({length:10000},(_,i)=>['key'+i,i])));
  if(out.size!==10000 || out.lost) throw new Error('benchmark did not retain 10000 entries');
  return out;
}
function indexTime(versions) {
  const times=[];
  for(let sample=0;sample<9;sample++) {
    global.gc();const start=performance.now();const book=index(versions);
    for(let i=0;i<10000;i++) book.resolve([versions?'count':'key'+i],book.clock);
    times.push(performance.now()-start);
  }
  return median(times);
}
const medianNs=Object.fromEntries(Object.entries(timing).map(([key,values])=>[key,median(values)]));
const sample=reads(api,true).record.snapshot();
const output={
  setup:{node:process.version,platform:platform(),arch:arch(),cpu:cpus()[0]?.model,
    baseline:'unchanged main supplied by --baseline',samples:21,warmupBatches:20,readsPerBatch:1000,
    indexSamples:9,indexEntries:10000,indexResolves:10000,heapCopies:12},
  defaults: sample.limits,
  nanosecondsPerRead:{...medianNs,addedVsMain:medianNs.candidateOn-medianNs.mainOff,offDelta:medianNs.candidateOff-medianNs.mainOff},
  bytesPer1000Occurrences:{serialized:Buffer.byteLength(JSON.stringify(sample)),
    retainedHeapIncludingFactoryAndIndex:retained(()=>reads(api,true).record,12)},
  index10000:{distinctKeys:{buildPlus10000QueriesMs:indexTime(false),retainedHeapBytes:retained(()=>index(false),12),metadataBytes:index(false).bytes},
    versionsOfOneKey:{buildPlus10000QueriesMs:indexTime(true),retainedHeapBytes:retained(()=>index(true),12),metadataBytes:index(true).bytes}},
  checksum,
  limitations:['Synthetic scalar keys; no engine integration or live services.','GC heap differences are approximate; JSON/index metadata bytes are exact.','Microbenchmark timings are machine-specific, not application latency guarantees.']
};
console.log(JSON.stringify(output,null,2));
