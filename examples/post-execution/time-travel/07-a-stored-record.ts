/**
 * A stored record — a run that never finished, read back.
 *
 * A log built with a sink hands every entry to it AS IT LANDS: the base when the log opens, each
 * bundle as it is recorded, the writer's notes, and how the log ended. Here the run is "killed" after
 * its second stage — there is no closing entry — and its record is read back from the stored entries
 * through JSON, the way a file or a table gives them back: the reader says it never finished, keeps
 * the notes written as attempts ended, and folds what landed.
 */
import { buildAttemptId, readStoredRecord, stateAt, timeTravel } from 'foottrace';
import { EventLog, RecordFrame, SharedMemory, memorySink } from 'foottrace/write';

const sink = memorySink();
const state = new SharedMemory(undefined, { quote: null as number | null });
const log = new EventLog(state.getState(), {
  sink,
  address: { logRunId: 'run-7', drillPath: [] },
  meta: { chart: 'checkout' },
});

/** One stage: a frame, its writes, one commit. */
function step(stageId: string, index: number, write: (frame: RecordFrame) => void) {
  const frame = new RecordFrame(state, log);
  write(frame);
  frame.commit(() => ({ stage: stageId, stageId, runtimeStageId: `${stageId}#${index}` }));
  frame.release();
}

step('price', 0, (f) => f.write(f.at([], 'quote'), 42, 'set'));
// The attempts of a call inside the next stage, noted as each one ended — before the stage commits.
log.note('attempt', { id: buildAttemptId('charge#1', 1), outcome: 'timeout', durationMs: 40_000 });
log.note('attempt', { id: buildAttemptId('charge#1', 2), outcome: 'failed', durationMs: 812 });
step('charge', 1, (f) => f.write(f.at([], 'charged'), false, 'set'));
// … the process dies here: no `log.close(...)`, so no closing entry.

const stored = readStoredRecord(JSON.parse(JSON.stringify(sink.entries)) as unknown[]);
const run = stored.root('run-7')!;

console.log('=== What the store says before any fold ===\n');
console.log(`  complete: ${run.complete}   outcome: ${run.outcome ?? '(none — it never closed)'}`);
console.log(`  opened with: ${JSON.stringify(run.meta.opened)}`);
for (const note of run.notes) console.log(`  note ${note.kind}: ${JSON.stringify(note.data)}`);

console.log('\n=== The fold over what landed ===\n');
const cursor = timeTravel(run.source());
cursor.last();
console.log(`  stops: ${cursor.stops.map((s) => s.runtimeStageId || s.kind).join(' → ')}`);
console.log(`  state: ${JSON.stringify(cursor.stateAt().state)}`);

console.log('\n=== A commit the store lost is a gap at its own index ===\n');
const lost = sink.entries.filter((e) => !(e.kind === 'commit' && e.bundle.idx === 0));
const damaged = readStoredRecord(lost).root('run-7')!;
console.log(`  gaps: ${JSON.stringify(damaged.gaps)}`);
console.log(`  fold: ${JSON.stringify(stateAt(damaged.source(), 1))}`);
