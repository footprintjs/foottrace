import { sourceOwner } from '../../read-sources/admission.js';
import type { captureFor } from '../../read-sources/bindings.js';
import type { SourceFrame } from '../../read-sources/capture.js';
import type { ReadSource, ReadSourceOccurrence, ReadSourceOwner } from '../../read-sources/types.js';
import type { NativeReadObservation } from '../pathOps.js';

/** Trusted frame wiring. These operations are not supplied by a reader or a capture observer. */
export interface SourceReadPort {
  capture(): ReturnType<typeof captureFor>;
  sourceFrame(): SourceFrame | undefined;
  touch(): void;
  read(observation?: NativeReadObservation): unknown;
  tracks(): boolean;
  track(observation: NativeReadObservation): void;
  address(): readonly string[];
}

/** The existing source transaction, shared by the ordinary and located read doors. */
export function readSource(
  port: SourceReadPort,
  path: string[],
  key: string,
  owner: ReadSourceOwner,
  privacy: 'visible' | 'redacted' | (() => 'visible' | 'redacted') = 'visible',
  givenObservation?: NativeReadObservation,
): { value: unknown; occurrence: ReadSourceOccurrence | undefined; visible: boolean } {
  const capture = port.capture();
  const ordinal = capture?.begin(port.sourceFrame()?.clock);
  let value: unknown;
  let occurrence: ReadSourceOccurrence | undefined;
  let frame: SourceFrame | undefined;
  let selected: readonly string[] = [];
  let rootKey: unknown;
  let source: ReadSource | undefined;
  let admittedOwner: ReadSourceOwner | undefined;
  try {
    // Admit/copy identities before user accessors or the verdict can mutate them.
    try {
      if (capture) admittedOwner = sourceOwner(owner);
    } catch {
      capture?.poison();
    }
    const observation: NativeReadObservation = givenObservation ?? { dataOnly: true };
    try {
      port.touch();
      frame = port.sourceFrame();
      value = port.read(capture || port.tracks() || givenObservation ? observation : undefined);
      if (port.tracks()) port.track(observation);
    } catch (error) {
      capture?.poison();
      throw error;
    }
    try {
      selected = [...(observation.selectedAddress ?? port.address())];
      rootKey = path.length ? path[0] : key;
      if (capture) {
        if (selected.length > 64 || typeof rootKey !== 'string' || rootKey.length > 1024)
          capture.gap('budget-exhausted');
        else
          source = capture.select(
            frame,
            [...selected, rootKey],
            value,
            observation.dataOnly,
            observation.live === true,
            'visible',
            path.length !== 0,
          );
      }
    } catch {
      capture?.poison();
    }
    // No value/source is passed to this callback. Do not await, coerce or retain its result.
    let verdict: 'visible' | 'redacted';
    try {
      verdict = typeof privacy === 'function' ? privacy() : privacy;
    } catch (error) {
      capture?.poison();
      throw error;
    }
    if (verdict !== 'visible')
      source = { kind: 'unavailable', reason: verdict === 'redacted' ? 'redacted' : 'capture-failed' };
    occurrence =
      capture && source && admittedOwner
        ? capture.retain(ordinal, frame, rootKey, selected, admittedOwner, source)
        : undefined;
    return { value, occurrence, visible: verdict === 'visible' };
  } finally {
    if (!occurrence) capture?.omitted(frame, admittedOwner);
    capture?.finish(ordinal);
  }
}
