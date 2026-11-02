/**
 * An offline, host-owned adapter over the existing CauseGraph ports. All observations in this
 * example are synthetic local producer fixtures: no request, provider or numerical work runs.
 * FootPrint owns its attempt-note contract; this example is not a new foottrace note schema/reader.
 */
import { buildAttemptId, readStoredRecord, type LogAddress } from 'foottrace';
import { createRecordGraph, explain, type CauseGraph, type GraphEdge } from 'foottrace/cause';
import { EventLog, memorySink, RecordFrame, SharedMemory } from 'foottrace/write';

export async function callAnswerAdapterExample(deliveries = 1) {
  if (!Number.isSafeInteger(deliveries) || deliveries < 1 || deliveries > 1000)
    throw new RangeError('example deliveries must be 1..1000');
  const address: LogAddress = { logRunId: 'example-run', drillPath: [] };
  const attemptId = buildAttemptId('fetch#0', 1, { ordinal: 1, attempt: 1 });
  const responseRef = 'artifact:response-1';
  const sink = memorySink();
  const state = new SharedMemory(undefined, {});
  const log = new EventLog({}, { sink, address });
  const frame = new RecordFrame(state, log);
  frame.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix' });

  // The host retained synthetic invocation observations and ended answers. None proves dispatch.
  for (let ordinal = 1; ordinal <= deliveries; ordinal++) {
    const series = `fetch#0@1.${ordinal}`;
    log.note('attempt-start', { series, attempt: 1, kind: 'call', inputRefs: ['artifact:query-1'] });
    log.note('attempt', {
      record: { series, attempt: 1, kind: 'call', outcome: 'ok' },
      outputRefs: [`artifact:response-${ordinal}`],
    });
    // A real producer calls this ONLY when its facade delivers the answer in its live owner.
    frame.noteReadAttempt(buildAttemptId('fetch#0', 1, { ordinal, attempt: 1 }));
  }
  // With 34 deliveries the first response still has a matching note, but its per-write witness
  // has been evicted. Matching references cannot reconstruct that missing delivery evidence.
  frame.write(frame.at([], 'responseRef'), responseRef, 'set');
  frame.commit(() => ({ stage: 'Fetch', stageId: 'fetch', runtimeStageId: 'fetch#0' }));
  frame.release();
  log.close('ok');

  // A host resolves the stored address and admits its own producer contract. This fixture was
  // authored above: do not copy these checks as admission for arbitrary remote note payloads.
  const stored = readStoredRecord(JSON.parse(JSON.stringify(sink.entries)) as unknown[]).log(address)!;
  const witness = stored.commitLog[0].trace[0].readAttempts ?? [];
  const native = createRecordGraph([
    {
      address,
      commitLog: stored.commitLog,
      initialState: stored.initialState,
      reads: {},
      controlDeps: {},
      attention: {},
      complete: stored.complete,
    },
  ]);
  const writer = native.nodeId(address, { runtimeStageId: 'fetch#0', key: 'responseRef' });
  const call = JSON.stringify([address.logRunId, address.drillPath, 'attempt', attemptId]);
  const notePointer = 'example-run:note:1';
  const related = stored.notes.filter(
    (note) =>
      note.kind === 'attempt' && Array.isArray(note.data.outputRefs) && note.data.outputRefs.includes(responseRef),
  );
  const witnessed = witness.includes(attemptId) && related.length === 1;
  const edge = (nodeId: string): GraphEdge => ({
    nodeId,
    kind: 'data',
    attribution: 'per-write',
    evidence: [notePointer, 'commit:0:trace:0:readAttempts'],
  });
  const host: CauseGraph = {
    async parents(id, context) {
      if (id === call) return { edges: [], complete: false };
      const result = await native.parents(id, context);
      return id === writer && witnessed ? { edges: [...result.edges, edge(call)], complete: false } : result;
    },
    children(id, context) {
      return id === call ? { edges: witnessed ? [edge(writer)] : [], complete: false } : native.children(id, context);
    },
    attention(id, context) {
      return id === call ? [] : native.attention(id, context);
    },
    async gaps(id, context) {
      const base = id === call ? [] : await native.gaps(id, context);
      return [...base, { code: 'conservative', evidence: [notePointer] }, { code: 'not-collected', evidence: [] }];
    },
  };
  const result = await explain(host, writer, { includeBackward: true });
  return {
    attemptId,
    writer,
    call,
    relatedNotes: related.length,
    witness: [...witness],
    readAttemptsOmitted: stored.commitLog[0].trace[0].readAttemptsOmitted,
    result,
    meaning: 'The write may have used this delivered answer; neither semantic use nor remote commitment is proved.',
    coverage: 'unknown: no producer delivery/coverage record was supplied',
  };
}
