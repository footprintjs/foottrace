import {
  readTraceMetadata,
  traceMetadata,
  type TraceMetadataInput,
  type TraceMetadataResult,
} from 'foottrace/metadata';
import { isCommitBundle, type CommitBundle, type TimeTravelSource } from 'foottrace';
const input: TraceMetadataInput = {
  scope: { sourceId: 'saved', runId: 'r', invocationId: null },
  addressBasis: 'projection-local',
  commits: [{ stage: 'stage', stageId: 's', runtimeStageId: 's#0', trace: [{ path: 'x' }] }],
};
const metadata = readTraceMetadata(input);
const result: Promise<TraceMetadataResult> = traceMetadata(metadata, {
  scope: input.scope,
  key: 'x',
  before: { commitIndex: 1, traceIndex: 0 },
});
void result;
void isCommitBundle(metadata);
// @ts-expect-error An opaque metadata handle has no replay fields.
const replay: TimeTravelSource = metadata;
// @ts-expect-error A metadata commit with missing verb/patches is not a complete record type.
const complete: CommitBundle = input.commits[0];
// @ts-expect-error Structural lookalikes cannot forge the opaque handle.
traceMetadata({ kind: 'trace-metadata' }, { scope: input.scope, key: 'x', before: { commitIndex: 0, traceIndex: 0 } });
void replay;
void complete;
async function separation(): Promise<void> {
  const found = await result;
  // @ts-expect-error A metadata result is not a replay source.
  const source: TimeTravelSource = found;
  // @ts-expect-error Metadata never reports a proven state effect.
  const effect: 'proven' = found.stateEffect;
  // @ts-expect-error Metadata queries never certify complete semantic causality.
  const full: true = found.complete;
  void source;
  void effect;
  void full;
}
void separation;
