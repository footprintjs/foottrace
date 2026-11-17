/** Bounded call-local location capture. Only the public type is exported by foottrace/write. */
export type { LocatedRead } from './readLocation/types.js';
export {
  beginLocatedRead,
  resetLocationCandidate,
  noteLocationSegment,
  completeLocationCandidate,
  takeLocation,
  endLocatedRead,
} from './readLocation/capture.js';
