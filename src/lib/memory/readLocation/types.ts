import type { ReadSourceOccurrence } from '../../read-sources/types.js';

/** One native read. Location is optional structural metadata, never proof of semantic use or privacy history. */
export interface LocatedRead {
  /** The original borrowed value; neither it nor the caller's state is frozen. */
  readonly value: unknown;
  /** Existing source-capture semantics, independent of exact member location. */
  readonly occurrence: ReadSourceOccurrence | undefined;
  /** Literal segments of the winning read, copied during traversal. Absent for unsupported or withheld metadata. */
  readonly location?: readonly string[];
}
