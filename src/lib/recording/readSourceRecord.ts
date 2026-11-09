import { bindCapture, captureFor, nextSourceSegment } from '../read-sources/bindings.js';
import type { LogAddress } from '../memory/eventPosition.js';
import { EventLog } from '../memory/EventLog.js';
import type { RecordSink } from '../memory/sink.js';
import type { SharedMemory } from '../memory/SharedMemory.js';
import { sourceAddress, sourceLimits, sourceOwn, sourceNamespaces } from '../read-sources/admission.js';
import { ReadSourceCapture } from '../read-sources/capture.js';
import { READ_SOURCE_V2_CEILINGS } from '../read-sources/format.js';
import type { ReadSourceLimits, ReadSourceSnapshot } from '../read-sources/types.js';

export interface ReadSourceRecordOptions {
  /** Opt in to source format 2 and bounded observed-before-write associations. */
  readonly writeReadPrefixes?: boolean;
  readonly limits?: Partial<ReadSourceLimits>;
  readonly sink?: RecordSink;
  /** Native heap namespaces known before base cloning. Undeclared late namespaces have no exact base. */
  readonly stateAddresses?: readonly (readonly string[])[];
}
export interface ReadSourceRecord {
  readonly log: EventLog;
  snapshot(): ReadSourceSnapshot;
  /** End source ownership without deleting history or changing the native log's outcome. */
  retire(): void;
}

/** Open a NEW opted-in log from this heap's current state; never retrofit or relabel an existing log. */
export function createReadSourceRecord(
  state: SharedMemory,
  addressInput: LogAddress,
  options?: ReadSourceRecordOptions,
): ReadSourceRecord {
  const address = sourceAddress(addressInput);
  const prefixes = options === undefined ? undefined : sourceOwn(options, 'writeReadPrefixes');
  if (prefixes !== undefined && typeof prefixes !== 'boolean')
    throw new TypeError('read sources: invalid prefix option');
  const limits = sourceLimits(
    options === undefined ? undefined : sourceOwn(options, 'limits'),
    undefined,
    prefixes === true ? READ_SOURCE_V2_CEILINGS : undefined,
  );
  const namespaces = sourceNamespaces(options === undefined ? undefined : sourceOwn(options, 'stateAddresses'), limits);
  if (captureFor(state) && !captureFor(state)!.retired) throw new TypeError('read sources: heap already bound');
  const before = state.getState();
  const sink = options === undefined ? undefined : (sourceOwn(options, 'sink') as RecordSink | undefined);
  const capture = new ReadSourceCapture(address, nextSourceSegment(state), limits, prefixes === true);
  // Inspect descriptors before base cloning can turn an accessor result into an apparent data slot.
  try {
    capture.index.seed(before);
    for (const namespace of namespaces) capture.index.seed(before, namespace);
  } catch {
    capture.poison();
  }
  bindCapture(state, capture); // reserve binding before clone/opened-sink callbacks can re-enter.
  let log: EventLog;
  try {
    log = new EventLog(before, sink ? { sink, address } : undefined);
  } catch (error) {
    capture.retire();
    throw error;
  }
  log.bindAddress(address.logRunId, address.drillPath);
  if (state.getState() !== before) capture.poison(); // clone/opened-sink reentrancy is not an exact base.
  bindCapture(log, capture);
  return Object.freeze({ log, snapshot: () => capture.snapshot(), retire: () => capture.retire() });
}
