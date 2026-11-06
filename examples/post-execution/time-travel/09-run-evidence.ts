/**
 * Why did a stage run? Read the answer from the file alone.
 *
 * A log that declares `collects` keeps three more kinds of fact beside its commits. This one writes a small run by hand,
 * through a JSON round trip, the way a file comes back, and reads it. A real engine writes the same entries.
 */
import { readRunEvidence, readStoredRecord } from 'foottrace';
import { EventLog, memorySink } from 'foottrace/write';

const sink = memorySink();
const log = new EventLog({}, { sink, address: { logRunId: 'run-1', drillPath: [] }, collects: { reads: 'keys' } });
const empty = (id: string) => ({
  stage: id,
  stageId: id.slice(0, id.indexOf('#')),
  runtimeStageId: id,
  trace: [],
  redactedPaths: [],
  overwrite: {},
  updates: {},
});

log.record(empty('score#0'), {});
log.record(empty('route#1'), { parent: 'score#0', reads: ['riskScore'] });
log.noteRun('run.decision', {
  id: 'route#1',
  by: 'decide',
  chosen: 'Manual review',
  evidence: {
    rules: [
      {
        type: 'filter',
        ruleIndex: 0,
        branch: 'manual',
        matched: true,
        label: 'Middle band',
        conditions: [
          { key: 'riskScore', op: 'gte', threshold: 30, actualSummary: '55', result: true, redacted: false },
          // The writer masked this one: a hole with its marker, not a value. The reader never masks a second time.
          {
            key: 'ssn',
            op: 'eq',
            threshold: '[REDACTED]',
            thresholdRedacted: true,
            actualSummary: '[REDACTED]',
            result: true,
            redacted: true,
          },
        ],
      },
    ],
    chosen: 'manual',
    default: 'manual',
  },
});
log.record(empty('manual#2'), { parent: 'route#1', description: 'A person reads the case' });
log.noteRun('run.stop', { id: 'manual#2', by: 'break', reason: 'Enough evidence' });
log.close('ok');

// What a file gives back: untrusted, and read as such.
const entries: unknown = JSON.parse(JSON.stringify(sink.entries));
const evidence = readRunEvidence(readStoredRecord(entries as unknown[]), 'run-1');

console.log(evidence.control('manual#2'));
// { status: 'collected', decider: 'route#1', label: 'Middle band', gaps: [] }

console.log(evidence.stops.status, evidence.stops.rows[0]?.reason);
// collected Enough evidence

// A file with no evidence never reads as nothing having happened.
const old = readRunEvidence(readStoredRecord([]), 'run-1');
console.log(old.decisions);
// { status: 'not-collected', rows: [], why: 'no-log' }
