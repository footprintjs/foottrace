import type { NativeReadObservation } from '../pathOps.js';

interface Capture {
  segments: string[];
  units: number;
  refused: boolean;
  complete: boolean;
  accessor: boolean;
}

// Only active call-local tokens: finally removes the association, including on read/verdict errors.
// The observation passed through existing host ports never exposes a mutable receipt or last-read slot.
const active = new WeakMap<NativeReadObservation, Capture>();

export function beginLocatedRead(): NativeReadObservation {
  const observation: NativeReadObservation = { dataOnly: true };
  active.set(observation, { segments: [], units: 0, refused: false, complete: false, accessor: false });
  return observation;
}

/** Reset only the losing candidate's cursor; existing source/canonical facts and accessor taint survive. */
export function resetLocationCandidate(observation?: NativeReadObservation): void {
  const capture = observation && active.get(observation);
  if (!capture) return;
  capture.segments = [];
  capture.units = 0;
  capture.refused = false;
  capture.complete = false;
}

/** Consume the primitive selector already held by the existing own-slot operation, with no conversion or reread. */
export function noteLocationSegment(observation: NativeReadObservation, segment: unknown, dataOnly: boolean): void {
  const capture = active.get(observation);
  if (!capture) return;
  if (!dataOnly) capture.accessor = true;
  if (capture.refused) return;
  if (
    typeof segment !== 'string' ||
    capture.segments.length >= 64 ||
    segment.length > 1024 ||
    capture.units + segment.length > 4096
  ) {
    capture.refused = true;
    capture.segments = [];
    return;
  }
  capture.segments.push(segment);
  capture.units += segment.length;
}

/** A native candidate completed, rather than a custom port merely returning an unrelated value. */
export function completeLocationCandidate(observation: NativeReadObservation | undefined, complete: boolean): void {
  const capture = observation && active.get(observation);
  if (capture) capture.complete = complete;
}

export function takeLocation(
  observation: NativeReadObservation,
  key: unknown,
  value: unknown,
  visible = true,
): readonly string[] | undefined {
  const capture = active.get(observation);
  if (
    !capture ||
    typeof key !== 'string' ||
    value === undefined ||
    !visible ||
    capture.refused ||
    capture.accessor ||
    !capture.complete
  )
    return undefined;
  return Object.freeze([...capture.segments]);
}

export function endLocatedRead(observation: NativeReadObservation): void {
  active.delete(observation);
}
