/**
 * A saved control map, walked back — no engine in the room.
 *
 * A control recorder saves which decision let which step run as plain data:
 * `{ 'high#2': { deciderId: 'route#1', label: 'score over 50' } }`. A tool that reads that file later has an
 * object, and `causalChain` takes a function. `controlDepsFromMap` is the door between them: it reads the
 * object as data (own properties only, never a getter, never the prototype) and hands the walk the lookup.
 */
import { causalChain, controlDepsFromMap, formatCausalChain, keysReadFromMap } from 'foottrace';
import type { CommitBundle } from 'foottrace';

const commit = (idx: number, stageId: string, written: string[]): CommitBundle => ({
  idx,
  stage: stageId,
  stageId,
  runtimeStageId: `${stageId}#${idx}`,
  trace: written.map((path) => ({ path, verb: 'set' as const })),
  redactedPaths: [],
  overwrite: Object.fromEntries(written.map((path) => [path, 1])),
  updates: {},
});

// The run: seed writes `score`, route reads it and decides, high (the chosen branch) writes `result`.
const log = [commit(0, 'seed', ['score']), commit(1, 'route', []), commit(2, 'high', ['result'])];
const reads = keysReadFromMap({ 'route#1': ['score'] });

// What the control recorder kept, written to a file and read back.
const text = JSON.stringify({ 'high#2': { deciderId: 'route#1', label: 'score over 50' } });
console.log(`saved: ${text}`);
const saved = JSON.parse(text);

console.log('\n=== The walk back from high#2, controlDeps from the saved map ===\n');
const root = causalChain(log, 'high#2', reads.lookup, { controlDeps: controlDepsFromMap(saved) })!;
console.log(formatCausalChain(root));

console.log('\n=== The object itself is not a lookup: one way in, and the refusal says which ===\n');
try {
  causalChain(log, 'high#2', reads.lookup, { controlDeps: saved });
} catch (error) {
  console.log(`  ${(error as Error).message}`);
}

console.log('\n=== A hostile name finds nothing, and the helper refuses what is not a plain object ===\n');
const lookup = controlDepsFromMap(saved);
console.log(`  constructor: ${String(lookup('constructor'))}   __proto__: ${String(lookup('__proto__'))}`);
try {
  controlDepsFromMap(new Map() as never);
} catch (error) {
  console.log(`  ${(error as Error).message}`);
}
