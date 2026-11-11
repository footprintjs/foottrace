/**
 * parentEdges.ts — THE rule for which edges a child keeps to ONE parent for ONE key.
 *
 * WHY THIS FILE EXISTS. The walk back (`backtrack.ts`) meets the links from a child to a parent one
 * at a time, in an order that depends on the shape of the log and on which key it came through.
 * The answer must not depend on that order: the same links give the same edges. Written inside the
 * walk, the rule was a chain of questions about "what is there already", and one pair came out
 * differently by order. A possible link the record's rows made, met BEFORE a certain link to the
 * same parent, stayed beside it; met after, it was never added. (Found by the second reader of the
 * change that added `'built-on-view'`: a commit whose marked row sits inside the key read owes both
 * a fold link and a view link, and only the order they were pushed in decided the answer.) Here the
 * rule is one function over two values, and a test applies every order of every small set of links
 * and holds the result against a statement that knows no order (`test/lib/memory/parent-edges.test.ts`).
 *
 * THE RULE. A link is CERTAIN (no `overlap`) or only POSSIBLE (`overlap` says why). It was made by a
 * READ of the step's code (no `builtOn`), or by the record's ROWS (`builtOn` says which kind).
 *   - At most one certain edge. Where a certain read is among the links, it is that read: such an
 *     edge is what every reader saw before rows were followed, so a record whose walk was right
 *     keeps its bytes. Otherwise it is the rows' edge, and it says `'partial-write'` when a fold is
 *     among its reasons (commit order alone decides a fold), else `'built-on-view'`.
 *   - A possible edge the rows made says nothing a certain edge does not say. It is kept only while
 *     there is no certain edge, one per mark.
 *   - A possible READ is kept beside anything, one per mark: it says the step's code may have read
 *     this parent's write, and no other edge says that.
 */

import type { RegisteredCode } from './honesty.js';
import type { ReadOverlap } from './readWindow.js';

/** Why a parent is under a child's value though no read by the child's code names it (`CausalEdge.builtOn`). */
export type BuiltOn = RegisteredCode<'partial-write' | 'built-on-view'>;

/** What the rule reads and writes of an edge, and what a link says of itself. */
export interface LinkMarks {
  /** Present on a link that is only possible. */
  overlap?: ReadOverlap;
  /** Present on a link the record's rows made, absent on one a read made. */
  builtOn?: BuiltOn;
}

/**
 * Take one link into the edges a child already has. `same` picks the edges of this link's parent,
 * kind and key. Returns `true` when the caller must ADD an edge for the link (the caller makes it:
 * the weight and the basis are its own). Existing edges of the same link are changed or removed as
 * the rule asks, in place.
 */
export function takeLink<Edge extends LinkMarks>(
  edges: Edge[],
  same: (edge: Edge) => boolean,
  link: LinkMarks,
): boolean {
  const certain = edges.find((edge) => same(edge) && edge.overlap === undefined);
  if (link.overlap === undefined) {
    if (certain === undefined) {
      // The first certain link for this parent and key. It takes the place of every possible edge the rows made.
      for (let at = edges.length - 1; at >= 0; at--) {
        const edge = edges[at];
        if (same(edge) && edge.overlap !== undefined && edge.builtOn !== undefined) edges.splice(at, 1);
      }
      return true;
    }
    // One certain edge is there already. A read stands for it; of two reasons the rows give, the fold.
    if (link.builtOn === undefined) delete certain.builtOn;
    else if (certain.builtOn !== undefined && link.builtOn === 'partial-write') certain.builtOn = 'partial-write';
    return false;
  }
  if (link.builtOn !== undefined && certain !== undefined) return false;
  // A possible link: one edge per mark, the rows' apart from the reads'.
  const fromRows = link.builtOn !== undefined;
  return !edges.some(
    (edge) => same(edge) && edge.overlap === link.overlap && (edge.builtOn !== undefined) === fromRows,
  );
}
