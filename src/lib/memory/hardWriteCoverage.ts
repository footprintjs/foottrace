import { DELIM } from '../record-paths/codec.js';

/** A hard write owns its exact path and descendants, using the writer's path codec. */
export function hardWriteCovers(keys: ReadonlySet<string>, path: readonly (string | number)[]): boolean {
  let prefix = '';
  for (let index = 0; index < path.length; index++) {
    prefix += (index === 0 ? '' : DELIM) + String(path[index]);
    if (keys.has(prefix)) return true;
  }
  return false;
}

/**
 * The mark of a `set` row the WRITER made out of writes that only added (`TraceEntry.builtOnView`):
 * present when no hard write of the step owns the row's path, so the value in the row still holds
 * what the path held in the step's view.
 *
 * WHY HERE: "does a hard write own this path?" is this file's one question, and the places that write
 * such a row (`TransactionBuffer`: the overlap families of `'delta'`, and the read-back of rows that
 * would not fold back) must all ask it the same way. A hard write at any time counts, whatever the
 * step did to the path before or after it: from that write on, everything at the path is the step's.
 */
export function viewMark(keys: ReadonlySet<string>, path: readonly (string | number)[]): { builtOnView?: true } {
  return hardWriteCovers(keys, path) ? {} : { builtOnView: true };
}
