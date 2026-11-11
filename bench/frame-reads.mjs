/**
 * What one read through `RecordFrame` costs, for each of its two read tiers:
 *   - VIEW: a step at the root address reading a root key. The answer comes from the view the step
 *     pinned at its first touch.
 *   - LIVE: a step in its own namespace reading a root key. Its view cannot answer, so the answer
 *     comes from live state.
 *
 * Why it exists: the read window notes, for every read, what the read saw of the log
 * (`RecordFrame · sawAt`). This is the checked-in instrument that says what that note costs.
 *
 * Build first. Compare with an unchanged built tree:
 *   node bench/frame-reads.mjs --baseline /path/to/built/main
 * Prints, per tier, the median of 9 rounds of 2,000,000 reads per tree, in nanoseconds per read. The
 * trees are measured in turn, twice, because the medians are a few nanoseconds apart and one run's
 * order can tip that.
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

const TIERS = { view: [], live: ['runs', 'child'] };

function round({ EventLog, RecordFrame, SharedMemory }, address) {
  const seed = { x: 1, y: 2, z: 3 };
  const state = new SharedMemory(undefined, seed);
  const frame = new RecordFrame(state, new EventLog(seed), address);
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
    for (const [tier, address] of Object.entries(TIERS)) {
      for (let i = 0; i < 3; i++) round(library, address); // warm up
      const times = Array.from({ length: ROUNDS }, () => round(library, address)).sort((a, b) => a - b);
      const median = times[(ROUNDS - 1) / 2];
      console.log(
        `pass ${pass}  ${name.padEnd(9)}  ${tier}  ${median.toFixed(1)} ns per read  (min ${times[0].toFixed(1)}, max ${times[
          ROUNDS - 1
        ].toFixed(1)})`,
      );
    }
  }
}
