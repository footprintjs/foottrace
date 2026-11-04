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
