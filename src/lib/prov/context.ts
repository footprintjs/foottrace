import type { ProvNode } from './types.js';

/** Fixed inline prefixes; links always use explicit @id objects, never implicit string coercion. */
export const PROV_CONTEXT: ProvNode = Object.freeze({
  prov: 'http://www.w3.org/ns/prov#',
  ft: 'https://footprintjs.dev/ns/foottrace#',
});
