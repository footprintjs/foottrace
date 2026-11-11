// buffer-differential.cjs — is a change to the transaction buffer behaviour-neutral?
//
// WHY THIS EXISTS. `TransactionBuffer` writes the record's bytes, and the write door promises that a
// refactor never moves one (src/write.ts). The test suite compares bytes for the programs it holds.
// This tool compares them for programs nobody wrote down: it drives TWO BUILDS of the buffer with the
// same random stage (sets, merges, deletes, list appends, reads, redaction marks, edits of a value
// after it was handed over, both encodings, with and without read provenance) and compares every
// read and the commit payload, byte for byte. It was written for the split of the buffer into
// staging and row layouts, and it is kept because the next change of that kind needs the same proof.
//
// It is a development tool, not a test: it needs a second build to compare with, which a checkout
// does not hold. Get the released one with `npm pack foottrace@<version>` and unpack it.
//
// Usage:  npm run build
//         node scripts/buffer-differential.cjs <dist of the released build> dist [programs] [seed]
// Prints one line: `SAME {...counts}` (how many rows, marked rows, merges, appends and deletes the
// programs reached, so a run that reached nothing is visible), or `DIFFERENT` with the first
// program that shows it, and exits 1.
//
// What it does NOT show: anything outside the buffer (the frame, the log, the readers), and any
// value kind the generator does not make (it makes JSON values and `undefined`; no Date, Map or Set).
'use strict';
const path = require('node:path');

const [distA, distB, countText = '20000', seedText = '1'] = process.argv.slice(2);
if (!distA || !distB) {
  console.error('usage: node scripts/buffer-differential.cjs <dist of build A> <dist of build B> [programs] [seed]');
  process.exit(2);
}
// Resolved against the working directory, so `dist` means this checkout's build.
const load = (dist) => require(path.resolve(dist, 'lib/memory/TransactionBuffer.js')).TransactionBuffer;
const A = load(distA);
const B = load(distB);
if (A === B) throw new Error('both builds resolved to the same module');

// ── A seeded generator (mulberry32) ──
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = ['a', 'b', 'list', 'obj', 'deep', 'x', 'y', '0', '1', '2'];
const U = { '«u»': true }; // stands for `undefined` in a plan

function plan(random) {
  const pick = (items) => items[Math.floor(random() * items.length)];
  const int = (n) => Math.floor(random() * n);
  const value = (depth = 0) => {
    const r = random();
    if (depth > 2 || r < 0.34) return pick([0, 1, 7, 's', 'tt', '', true, false, null, U]);
    if (r < 0.67) return Array.from({ length: int(4) }, () => value(depth + 1));
    const out = {};
    for (let i = int(4); i > 0; i--) out[pick(KEYS)] = value(depth + 1);
    return out;
  };
  const address = random() < 0.3 ? ['runs', pick(['r1', 'r2'])] : [];
  const at = () => {
    const below = Array.from({ length: 1 + int(3) }, () => pick(KEYS));
    return random() < 0.85 ? [...address, ...below] : below;
  };
  const base = {};
  for (let i = int(5); i > 0; i--) base[pick(KEYS)] = value();
  if (address.length > 0 && random() < 0.7) {
    const inner = {};
    for (let i = int(4); i > 0; i--) inner[pick(KEYS)] = value();
    base.runs = { [address[1]]: inner };
  }
  // Values an op may share with a later op, by slot: one object per build, so identity is the same in both.
  const slots = Array.from({ length: 3 }, () => value());
  const ops = [];
  for (let i = int(9); i > 0; i--) {
    const r = random();
    const redact = random() < 0.1;
    const val = random() < 0.25 ? { slot: int(slots.length) } : { literal: value() };
    if (r < 0.3) ops.push({ t: 'set', path: at(), val, redact });
    else if (r < 0.58) ops.push({ t: 'merge', path: at(), val, redact });
    else if (r < 0.7) ops.push({ t: 'delete', path: at(), redact });
    else if (r < 0.82) ops.push({ t: 'get', path: at() });
    else if (r < 0.86) ops.push({ t: 'mark', path: at(), fields: [pick(KEYS), `${pick(KEYS)}.${pick(KEYS)}`] });
    else if (r < 0.9) ops.push({ t: 'detach', path: at() });
    else if (r < 0.93) ops.push({ t: 'edit', slot: int(slots.length), key: pick(KEYS), val: value() });
    else if (r < 0.97) ops.push({ t: 'push', path: at(), val: { literal: value() } });
    else ops.push({ t: 'ask', path: at() });
  }
  return {
    base,
    address,
    slots,
    ops,
    commitValues: random() < 0.5 ? 'full' : 'delta',
    provenance: random() < 0.3,
    attempts: random() < 0.15,
  };
}

// A plan value as a live value: `U` becomes undefined, everything else a fresh copy.
function live(v) {
  if (v === U || (v && typeof v === 'object' && v['«u»'] === true && Object.keys(v).length === 1)) return undefined;
  if (Array.isArray(v)) return v.map(live);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = live(v[k]);
    return out;
  }
  return v;
}

const text = (v) =>
  JSON.stringify(v, (_k, x) => (x === undefined ? '«undefined»' : x instanceof Set ? { '«set»': [...x] } : x));

function run(Buffer, p) {
  const out = [];
  const reads = [];
  const slots = p.slots.map(live);
  const buffer = new Buffer(
    live(p.base),
    p.commitValues,
    p.provenance ? () => [...reads] : undefined,
    p.address,
    undefined,
    p.attempts
      ? () => ({ readAttempts: reads.map((k) => `${k}@1`), readAttemptsOmitted: reads.length > 2 ? 1 : 0 })
      : undefined,
  );
  for (const op of p.ops) {
    try {
      const val = op.val === undefined ? undefined : 'slot' in op.val ? slots[op.val.slot] : live(op.val.literal);
      if (op.t === 'set') buffer.set(op.path, val, op.redact);
      else if (op.t === 'merge') buffer.merge(op.path, val, op.redact);
      else if (op.t === 'delete') buffer.delete(op.path, op.redact);
      else if (op.t === 'get') {
        reads.push(op.path.join('.'));
        out.push(`get ${text(buffer.get(op.path))}`);
      } else if (op.t === 'push') {
        // A list written back with one more item: the shape the 'delta' encoding stores as an `append`.
        const current = buffer.peek(op.path);
        buffer.set(op.path, Array.isArray(current) ? [...current, val] : [val]);
      } else if (op.t === 'mark') buffer.markRedactedFields(op.path, op.fields);
      else if (op.t === 'detach') buffer.detachBase(op.path);
      else if (op.t === 'edit') {
        // The caller edits its own object after handing it over (the record keeps what the stage read back).
        const target = slots[op.slot];
        if (target && typeof target === 'object' && !Array.isArray(target)) target[op.key] = live(op.val);
        else if (Array.isArray(target)) target.push(live(op.val));
      } else out.push(`ask ${buffer.hasHardWrite(op.path)} ${buffer.wasStaged(op.path)} ${text(buffer.peek(op.path))}`);
    } catch (error) {
      out.push(`threw ${error && error.name}: ${error && error.message}`);
    }
  }
  try {
    out.push(`commit ${text(buffer.commit())}`);
    out.push(`after ${text(buffer.commit())}`); // an emptied buffer commits nothing
  } catch (error) {
    out.push(`commit threw ${error && error.name}: ${error && error.message}`);
  }
  return out;
}

const count = Number(countText);
const random = rng(Number(seedText));
const seen = { programs: 0, rows: 0, marked: 0, merges: 0, appends: 0, deletes: 0, threw: 0, redacted: 0 };
for (let i = 0; i < count; i++) {
  const p = plan(random);
  const a = run(A, p);
  const b = run(B, p);
  for (let k = 0; k < Math.max(a.length, b.length); k++) {
    if (a[k] === b[k]) continue;
    console.log(`DIFFERENT at program ${i}, line ${k}\nA: ${a[k]}\nB: ${b[k]}\nprogram: ${JSON.stringify(p)}`);
    process.exit(1);
  }
  seen.programs += 1;
  const committed = a.find((line) => line.startsWith('commit {'));
  if (committed) {
    const payload = JSON.parse(committed.slice('commit '.length));
    seen.rows += payload.trace.length;
    for (const row of payload.trace) {
      if (row.builtOnView) seen.marked += 1;
      if (row.verb === 'merge') seen.merges += 1;
      if (row.verb === 'append') seen.appends += 1;
      if (row.verb === 'delete') seen.deletes += 1;
    }
    if (payload.redactedPaths['«set»'].length > 0) seen.redacted += 1;
  }
  if (a.some((line) => line.includes('threw'))) seen.threw += 1;
}
console.log(`SAME ${JSON.stringify({ seed: Number(seedText), ...seen })}`);
