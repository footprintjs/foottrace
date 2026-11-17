import type { NativeReadObservation } from '../pathOps.js';
import type { SourceReadPort } from './sourceRead.js';

export interface TrackedReadPort extends Pick<SourceReadPort, 'read' | 'tracks' | 'track'> {
  plainRead(): unknown;
  legacyNote(): void;
}

/** Existing tracked-read strategy; a located read supplies its own call-local observation. */
export function trackedRead(port: TrackedReadPort, key?: string, supplied?: NativeReadObservation): unknown {
  const canonical = port.tracks();
  if (!canonical && !supplied) {
    const value = port.plainRead();
    if (key !== undefined) port.legacyNote();
    return value;
  }
  const observation: NativeReadObservation = supplied ?? { dataOnly: true };
  const value = port.read(observation);
  if (key !== undefined) {
    if (canonical) port.track(observation);
    else port.legacyNote();
  }
  return value;
}
