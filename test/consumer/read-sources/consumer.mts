import {
  createReadSourceRecord,
  decodeReadSourceSnapshot,
  memorySink,
  RecordFrame,
  SharedMemory,
  type ReadSource,
} from 'foottrace/write';
const state = new SharedMemory(undefined, { count: 1 });
const record = createReadSourceRecord(state, { logRunId: 'consumer', drillPath: [] });
const frame = new RecordFrame(state, record.log);
const selected = frame.readWithSource([], 'count', { runtimeStageId: 'reader#0' });
const source: ReadSource | undefined = selected.occurrence?.source;
if (source?.kind === 'committed') {
  const index: number = source.commitIdx;
  void index;
}
const snapshot = decodeReadSourceSnapshot(JSON.parse(JSON.stringify(record.snapshot())));
if (!snapshot || selected.value !== 1) throw new Error('read-source consumer failed');
record.retire();

const evidence = createReadSourceRecord(
  new SharedMemory(undefined, {}),
  { logRunId: 'evidence', drillPath: [] },
  {
    sink: memorySink(),
    collects: { reads: 'keys' },
  },
);
const keepsEvidence: boolean = evidence.log.keepsEvidence;
void keepsEvidence;
evidence.retire();
