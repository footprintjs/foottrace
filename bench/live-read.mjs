/**
 * What one LIVE read through `RecordFrame` costs: a step in its own namespace reading a root key, the
 * read tier that notes its look at state for the read window (`RecordFrame · observe`).
 *
 * Why it exists: the read window adds one note per live read. This is the checked-in instrument that
 * says what that costs. A read answered from the step's own view does not pay it.
 *
 * Build first. Compare with an unchanged built tree:
 *   node bench/live-read.mjs --baseline /path/to/built/main
 * Prints the median of 9 rounds of 2,000,000 reads per tree, in nanoseconds per read. The trees are
 * measured in turn, twice, because the two medians are a few nanoseconds apart and one run's order
 * can tip that.
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const baselineArg = process.argv.indexOf('--baseline');
const trees = [['this tree', resolve(import.meta.dirname, '..')]];
if (baselineArg >= 0 && process.argv[baselineArg + 1])
  trees.unshift(['baseline', resolve(process.argv[baselineArg + 1])]);

const READS = 2_000_000;
const ROUNDS = 9;
const KEYS = ['x', 'y', 'z'];
/** The keys hold 1, 2 and 3 and are read in turn. */
const EXPECTED = Math.floor(READS / 3) * 6 + [0, 1, 3][READS % 3];

function round({ EventLog, RecordFrame, SharedMemory }) {
  const seed = { x: 1, y: 2, z: 3 };
  const state = new SharedMemory(undefined, seed);
  const frame = new RecordFrame(state, new EventLog(seed), ['runs', 'child']);
  let sum = 0;
  const start = process.hrtime.bigint();
  for (let i = 0; i < READS; i++) sum += frame.read([], KEYS[i % 3]);
  const ns = Number(process.hrtime.bigint() - start);
  if (sum !== EXPECTED) throw new Error('a read returned the wrong value');
  return ns / READS;
}

for (let pass = 1; pass <= 2; pass++) {
  for (const [name, root] of trees) {
    const library = require(resolve(root, 'dist/write.js'));
    for (let i = 0; i < 3; i++) round(library); // warm up
    const times = Array.from({ length: ROUNDS }, () => round(library)).sort((a, b) => a - b);
    const median = times[(ROUNDS - 1) / 2];
    console.log(
      `pass ${pass}  ${name.padEnd(9)}  ${median.toFixed(1)} ns per live read  (min ${times[0].toFixed(1)}, max ${times[
        ROUNDS - 1
      ].toFixed(1)})`,
    );
  }
}
