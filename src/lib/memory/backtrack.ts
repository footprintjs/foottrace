/**
 * backtrack.ts — Backward causal chain analysis on the commit log.
 *
 * Implements **backward program slicing** (Weiser 1984, thin-slice variant):
 * given a starting execution step, walk backwards through read→write
 * dependencies to build the causal DAG that produced the data at that step.
 *
 * ## Algorithm
 *
 * BFS on the implicit dependency graph where edges run from reader → writer.
 *
 * 1. Locate startId in commitLog → root node
 * 2. Get keysRead for root via `getKeysRead` callback
 * 3. For each key read, find what the read could have seen → parent commits
 *    ("wrote" is the writer rule of `keyPaths.ts`, 9.33.0: a row on the key, inside it, or
 *    around it that changed it — so a stage that read `cfg` links to the subflow seed or
 *    merge-back that wrote `cfg␟b`). The rule is `readWindow.ts · readSourcesOf`: the last
 *    writer before the step began, plus every writer inside the step's read window (steps
 *    side by side that looked at state again after a sibling committed). With a writer in
 *    the window every edge for that key carries `overlap`: a possible source, not a certain
 *    one. A step with no window has one parent per key, and it is certain.
 * 4. Create parent CausalNode, link to root.parents
 * 5. A parent whose write of the linking key did not REPLACE the value (a merge, an append, a row
 *    inside the key) is not the end of the walk for that key: the value is made of that write and
 *    of what was there. The parent is linked to the step whose commit its write was folded onto, in
 *    commit order (`builtOn.ts`), with an edge marked `builtOn`. No step read anything for this
 *    edge. The rule speaks in commits and a node here is a STEP: when the commit underneath is an
 *    earlier one of the same step, no edge is drawn and the walk passes through it.
 *    One more case of the same kind: a `set` row the WRITER built on the step's view
 *    (`TraceEntry.builtOnView`) replaces the value in the fold and still holds what the view held.
 *    The parent is linked to what that commit's view held (the read rule of step 3, asked with the
 *    moment the view was pinned, `CommitBundle.viewAt`), with the edge marked
 *    `builtOn: 'built-on-view'`.
 * 6. Enqueue parent. Repeat until queue empty or limits hit.
 *
 * Output is a graph of steps, not a linked list: a stage reading `creditScore` AND `dti` from
 * different writers has two parents. It is a **DAG** for every log in which no step commits a key
 * between two commits of another step that both add to that key. In such a log each of the two
 * steps rests on the other (A's later commit was folded onto B's write, and B's write onto A's
 * earlier commit), and the walk says so with an edge each way: a cycle of two steps. Every helper
 * here (`flattenCausalDAG`, `formatCausalChain`, `sliceToJSON`) visits a node once and ends on it.
 * A consumer that follows `parents` itself must do the same, as it must already for a shared
 * parent. The cause graph (`foottrace/cause`) has one node per COMMIT and is always acyclic.
 *
 * ## Staged Optimization
 *
 * Two writer-lookup strategies, chosen automatically by commit log size. Both
 * give the answer `findLastWriter` gives, so the choice never changes a slice:
 *
 * | Strategy | When | Cost per lookup |
 * |----------|------|-----------------|
 * | Scan | N ≤ 256 | `findLastWriter`: a backward scan of the log. A frozen log (an engine snapshot's) is answered from its memoised read model instead. |
 * | Read model | N > 256 | one build of the log's read model for the call (`logModel.ts`: a path trie over the rows), then a binary search |
 *
 * The threshold (256) is where building the read model for one call pays for
 * itself. The consumer never sees this — `causalChain()` picks the strategy
 * internally (like a query optimizer choosing between a sequential scan and
 * an index scan by table size).
 *
 * ## Complexity
 *
 * - **Small logs (N ≤ 256):** O(V × K × N) total at worst. V=visited, K=avg keys/node.
 * - **Large logs (N > 256):** O(rows) model build + O(V × K × (depth + log N)) lookups.
 *
 * ## References
 *
 * - Weiser, M. (1984). "Program Slicing." IEEE TSE.
 * - Sridharan, M. et al. (2007). "Thin Slicing." PLDI.
 *
 * @example
 * ```typescript
 * import { causalChain, flattenCausalDAG, formatCausalChain } from 'foottrace';
 *
 * const dag = causalChain(commitLog, 'decide#2', (id) => recorder.getKeysRead(id));
 * const flat = flattenCausalDAG(dag);     // BFS-ordered flat list
 * console.log(formatCausalChain(dag));     // human-readable
 * ```
 */

import type { CausalChainOptions, CausalEdge, CausalNode, KeysReadLookup } from './backtrackTypes.js';
import { builtOnBefore, readFromView, replacesValue, viewOverlapOf } from './builtOn.js';
import { buildCommitIndex } from './commitLogUtils.js';
import { queryWork, relation, writesOnlyInside } from './keyPaths.js';
import { overlapOf, readSourcesOf } from './readWindow.js';
import { type BuiltOn, type SourceOverlap, takeLink } from './parentEdges.js';
import { placesOf } from './windowPlacement.js';
import { createWriterLookup } from './writerLookup.js';
import type { CommitBundle, TraceEntry, UntrackedSource } from './types.js';

// The walk back's door inside the package. Its declarations (`backtrackTypes.ts`), the two ways to read
// a result (`backtrackViews.ts`) and the writer lookup (`writerLookup.ts`) live beside it. They are
// handed out here so that an importer names one file, as it did when all of it was this file.
export type {
  CausalChainOptions,
  CausalEdge,
  CausalNode,
  ControlDependency,
  ControlDepLookup,
  EdgeWeigher,
  KeysReadLookup,
} from './backtrackTypes.js';
export { flattenCausalDAG, formatCausalChain } from './backtrackViews.js';
/** @internal Exposed for testing the strategy selection. */
export { REVERSE_INDEX_THRESHOLD as _REVERSE_INDEX_THRESHOLD } from './writerLookup.js';

/**
 * The trace entries of `commit` that make it a writer of `linkKey` — the entries whose read
 * prefix (`TraceEntry.readKeys`) a per-write edge expands through. EVERY entry on the exact path
 * when there is one: a stage that wrote the key twice committed its LAST write, and the reads
 * between the two writes are causes of it. ('delta' encoding keeps one row per path with the last
 * prefix; 'full' keeps a row per write, so taking the first row alone dropped those reads.) The
 * caller unions the rows' prefixes, which is the last prefix when prefixes only grow. Otherwise
 * every entry inside or around the key (9.33.0: the commit wrote the key through a nested row — a
 * subflow seed, an outputMapper merge-back — and all of those rows wrote it).
 */
function linkingEntries(commit: CommitBundle, linkKey: string): TraceEntry[] {
  const exact = commit.trace.filter((t) => t.path === linkKey);
  if (exact.length > 0) return exact;
  return commit.trace.filter((t) => relation(t.path, linkKey) !== undefined);
}

// ── Core algorithm ─────────────────────────────────────────────────────

/**
 * RFC-003 D2: the `incompleteSources` node fragment for a commit — `{}`
 * when the stage consumed no untracked read paths, keeping the field
 * ABSENT (not empty-array-valued) for fully-tracked stages.
 */
function incompleteSourcesFragment(commit: CommitBundle): { incompleteSources?: ReadonlyArray<UntrackedSource> } {
  if (!commit.untrackedSources || commit.untrackedSources.length === 0) return {};
  return { incompleteSources: commit.untrackedSources };
}

/**
 * Build the causal DAG rooted at `startId` by walking backwards
 * through read→write dependencies in the commit log.
 * This state-key view does not project `TraceEntry.readAttempts`: empty parents
 * do not rule out external ancestry. Inspect the saved trace or compose a host CauseGraph.
 *
 * Automatically selects the optimal writer lookup strategy:
 * - Linear scan for small logs (≤ 256 commits)
 * - Reverse index with binary search for large logs (> 256 commits)
 *
 * Produces a DAG (not a tree): if two children both read from the same
 * parent, the parent node is shared (deduped by runtimeStageId).
 *
 * @param commitLog   Ordered commit bundles from executor.getSnapshot().commitLog
 * @param startId     runtimeStageId to start backtracking from
 * @param getKeysRead Callback returning keys read by a given execution step
 * @param options     Depth and node limits
 * @returns Root CausalNode with .parents forming the DAG, or undefined if startId not found
 */
export function causalChain(
  commitLog: CommitBundle[],
  startId: string,
  getKeysRead: KeysReadLookup,
  options?: CausalChainOptions,
): CausalNode | undefined {
  return buildCausalChain(commitLog, startId, getKeysRead, options);
}

/**
 * Internal slice composition: keep the actual bundle selected by the writer
 * query (including a nonempty continuation). This is not a public entry point.
 * The read position still belongs to the execution's first commit.
 */
export function causalChainFromCommit(
  commitLog: CommitBundle[],
  writer: CommitBundle,
  getKeysRead: KeysReadLookup,
  options?: CausalChainOptions,
): CausalNode | undefined {
  return buildCausalChain(commitLog, writer.runtimeStageId, getKeysRead, options, writer);
}

function buildCausalChain(
  commitLog: CommitBundle[],
  startId: string,
  getKeysRead: KeysReadLookup,
  options?: CausalChainOptions,
  selectedWriter?: CommitBundle,
): CausalNode | undefined {
  const maxDepth = options?.maxDepth ?? 20;
  const maxNodes = options?.maxNodes ?? 100;
  const controlDeps = options?.controlDeps;
  const weigh = options?.weigh;
  const perWrite = options?.edgeAttribution === 'per-write';

  // RFC-003 D4 — truncation visibility. Set only when a limit actually
  // cuts the slice; surfaced on the root as `truncated` so a consumer can
  // never mistake a truncated slice for a complete one.
  let truncatedByDepth = false;
  let truncatedByNodes = false;

  // A continuation may write more data, but it is not another execution of
  // the stage's reads. Use the shared FIRST-commit rule for every read cutoff;
  // keep writer bundles separately for their write metadata and read prefixes.
  const idxMap = buildCommitIndex(commitLog);
  queryWork.units += commitLog.length;

  const startIdx = idxMap.get(startId);
  if (startIdx === undefined) return undefined;

  const startCommit = selectedWriter ?? commitLog[startIdx];
  // Where the root's own writes sit: the selected bundle (a slice may anchor at a continuation), else
  // the execution's first commit.
  const startPos = selectedWriter ? commitLog.indexOf(selectedWriter) : startIdx;

  // Pick writer lookup strategy based on log size
  const findWriter = createWriterLookup(commitLog);
  // When each step looked at state (`readWindow.ts`): one pass over the log for the whole walk.
  const places = placesOf(commitLog);
  const windowAt = places.window;

  // Node dedup map: runtimeStageId → CausalNode (ensures DAG, not tree)
  const nodeMap = new Map<string, CausalNode>();

  const root: CausalNode = {
    runtimeStageId: startId,
    stageId: startCommit.stageId,
    stageName: startCommit.stage,
    keysWritten: startCommit.trace.map((t) => t.path),
    linkedBy: '',
    depth: 0,
    parents: [],
    parentEdges: [],
    ...incompleteSourcesFragment(startCommit),
  };
  nodeMap.set(startId, root);

  // ── #P1 per-write attribution machinery (inert under 'stage') ──────────
  // expandedReads: per node, the reads already queued for expansion — late
  // links via additional keys re-enqueue only the DELTA, so the slice grows
  // monotonically toward the stage-level ceiling and terminates (each key
  // expands at most once per node). fullyExpanded: nodes that fell back to
  // stage level (no readKeys on a linking entry) — nothing left to add.
  const expandedReads = new Map<string, Set<string>>();
  const fullyExpanded = new Set<string>();

  /**
   * Resolve a node's expansion read-set for the given linking WRITTEN keys.
   * Per-write mode with provenance present → union of the linking writes'
   * temporal-prefix `readKeys`. Any linking entry WITHOUT `readKeys` (or no
   * linkKeys at all) → honest stage-level fallback, flagged via the second
   * tuple member so the caller marks the node fully expanded.
   */
  function readsForLinks(commit: CommitBundle, linkKeys: string[] | undefined): [string[], boolean] {
    if (!perWrite || !linkKeys || linkKeys.length === 0) {
      return [getKeysRead(commit.runtimeStageId), true];
    }
    const union = new Set<string>();
    for (const linkKey of linkKeys) {
      const entries = linkingEntries(commit, linkKey);
      if (entries.length === 0 || entries.some((e) => e.readKeys === undefined)) {
        // Mixed/dial-off log — degrade THIS node to stage level, honestly.
        return [getKeysRead(commit.runtimeStageId), true];
      }
      for (const entry of entries) for (const rk of entry.readKeys as string[]) union.add(rk);
    }
    return [[...union], false];
  }

  // ── Writes that did not replace a value (`builtOn.ts`) ─────────────────
  // A node the walk came to through key `k`, at the bundle that wrote `k`, owes one more link when
  // that write was partial: to the commit it was built on. Each (node, key, bundle) is followed once.
  // What is under the write: the commit it was folded onto (`'fold'`: it did not replace the value),
  // or what its step's view held (`'view'`: the writer built a `set` row on the view, on the key,
  // around it or inside it). A commit with such a row INSIDE the key owes both.
  type Partial = readonly [key: string, at: number, from: 'fold' | 'view'];
  const followed = new Set<string>();
  const bundleAt = (position: number): CommitBundle => commitLog[position];
  /** What the write of `key` at `at` by `id` still owes the walk, less what has been followed already. */
  function partialWrite(id: string, key: string, at: number): Partial[] {
    queryWork.units += 1 + 2 * commitLog[at].trace.length;
    const owed: Partial[] = [];
    if (!replacesValue(commitLog[at], key)) owed.push([key, at, 'fold']);
    if (readFromView(commitLog[at], key)) owed.push([key, at, 'view']);
    return owed.filter(([, , from]) => {
      const mark = `${at}\u0000${key}\u0000${id}\u0000${from}`;
      if (followed.has(mark)) return false;
      followed.add(mark);
      return true;
    });
  }

  // BFS/worklist queue: [node, commitIdx, depth, keysToExpand, partial writes to follow]
  const [rootReads, rootIsFull] = perWrite
    ? readsForLinks(startCommit, options?.rootLinkKeys)
    : [getKeysRead(startId), true];
  expandedReads.set(startId, new Set(rootReads));
  if (rootIsFull) fullyExpanded.add(startId);
  // The root's own writes the walk is about (a slice names its key): only where the root's bundle
  // really wrote the key (it is then the last writer before the position after it).
  const rootPartials = (options?.rootLinkKeys ?? []).flatMap((key) =>
    startPos >= 0 && findWriter(key, startPos + 1) === startPos ? partialWrite(startId, key, startPos) : [],
  );
  const queue: Array<[CausalNode, number, number, string[], readonly Partial[]]> = [
    [root, startIdx, 0, rootReads, rootPartials],
  ];
  let visited = 1;

  /**
   * Link `node → parent` (creating + enqueueing the parent when new).
   * Shared by data-edge expansion (read→write) and control-edge expansion
   * (D3). One CausalEdge per distinct (parent, kind, key, overlap) link; `parents`
   * keeps its historical one-entry-per-parent dedup. `overlap`: why the parent is
   * only a possible source of the read (`readWindow.ts · overlapOf`).
   */
  function linkParent(
    node: CausalNode,
    parentPos: number,
    kind: 'data' | 'control',
    key: string | undefined,
    depth: number,
    overlap?: SourceOverlap,
    builtOn?: BuiltOn,
  ): void {
    const parentCommit = commitLog[parentPos];
    const parentId = parentCommit.runtimeStageId;
    // The parent wrote `key` at `parentPos`. When that write did not replace the value, the parent
    // owes a link to what it was built on (followed when the parent is expanded).
    const partials = kind === 'data' && key !== undefined ? partialWrite(parentId, key, parentPos) : [];
    // the dedup scans below, and the parent's trace when it is new — counted for the scaling test
    queryWork.units += 1 + node.parents.length + node.parentEdges.length;
    // #P1: the parent's expansion reads, resolved LAZILY (only for new nodes
    // or per-write re-expansion — duplicate links under 'stage' pay nothing).
    // Data links expand through the reads that fed the parent's write of
    // `key`; control links expand the decider at stage level (a decision
    // depends on everything it read).
    const resolveLinkReads = (): [string[], boolean] =>
      kind === 'data'
        ? readsForLinks(parentCommit, key !== undefined ? [key] : undefined)
        : [getKeysRead(parentId), true];

    let parentNode = nodeMap.get(parentId);
    if (!parentNode) {
      // New node — create and enqueue (respecting the node budget)
      if (visited >= maxNodes) {
        truncatedByNodes = true; // D4: a discovered parent was dropped
        return;
      }

      const parentIdx = idxMap.get(parentId);
      if (parentIdx === undefined) return;

      queryWork.units += parentCommit.trace.length;
      parentNode = {
        runtimeStageId: parentId,
        stageId: parentCommit.stageId,
        stageName: parentCommit.stage,
        keysWritten: parentCommit.trace.map((t) => t.path),
        // linkedBy stays a DATA-key concept (back-compat) — control-linked
        // nodes carry their label on the edge instead.
        linkedBy: kind === 'data' ? key ?? '' : '',
        depth: depth + 1,
        parents: [],
        parentEdges: [],
        ...incompleteSourcesFragment(parentCommit),
      };
      nodeMap.set(parentId, parentNode);
      visited++;
      const [linkReads, linkIsFull] = resolveLinkReads();
      expandedReads.set(parentId, new Set(linkReads));
      if (linkIsFull) fullyExpanded.add(parentId);
      queue.push([parentNode, parentIdx, depth + 1, linkReads, partials]);
    } else {
      // An EXISTING node. Two things may still be owed, and neither creates a node (the node budget
      // is untouched). Re-expansion keeps the node's ORIGINAL depth so its parents get a consistent
      // depth+1.
      //  - #P1 worklist: linked via another key under 'per-write', it may owe the reads that fed
      //    THAT write: only the reads not yet expanded are enqueued (monotone, so it terminates).
      //  - the link under its write of this key, when that write did not replace the value.
      let delta: string[] = [];
      if (perWrite && !fullyExpanded.has(parentId)) {
        const [linkReads, linkIsFull] = resolveLinkReads();
        const expanded = expandedReads.get(parentId)!;
        delta = linkReads.filter((k) => !expanded.has(k));
        if (linkIsFull) fullyExpanded.add(parentId);
        for (const k of delta) expanded.add(k);
      }
      if (delta.length > 0 || partials.length > 0) {
        const parentIdx = idxMap.get(parentId);
        if (parentIdx !== undefined) queue.push([parentNode, parentIdx, parentNode.depth, delta, partials]);
      }
    }

    // DAG merge: one parents[] entry per distinct parent (historical shape)
    if (!node.parents.some((p) => p.runtimeStageId === parentId)) {
      node.parents.push(parentNode);
    }
    // Which edges the child keeps to this parent for this key is one rule, the same whatever order
    // the walk meets the links in (`parentEdges.ts · takeLink`). The weigher (D4) stamps the weight
    // when an edge is made; `undefined` → 1.0 — the engine never computes weights itself.
    const sameLink = (e: CausalEdge): boolean =>
      e.parent.runtimeStageId === parentId && e.kind === kind && e.key === key;
    if (takeLink(node.parentEdges, sameLink, { overlap, builtOn })) {
      // Error isolation (review finding): a consumer weigher that throws
      // must degrade to the default weight, never crash the slice — the
      // same contract every other consumer callback in the library gets.
      let weight = 1.0;
      if (weigh) {
        try {
          weight = weigh(node, parentNode, key, kind) ?? 1.0;
        } catch {
          /* weigher threw — keep 1.0, the slice stays usable */
        }
      }
      const nested = kind === 'data' && key !== undefined && writesOnlyInside(parentCommit, key);
      node.parentEdges.push({
        parent: parentNode,
        kind,
        key,
        weight,
        ...(nested && { basis: 'nested-rows' as const }),
        ...(overlap && { overlap }),
        ...(builtOn !== undefined && { builtOn }),
      });
    }
  }

  while (queue.length > 0) {
    const [node, commitIdx, depth, keysToExpand, partials] = queue.shift()!;
    queryWork.units += 1 + keysToExpand.length + partials.length;

    if (depth >= maxDepth) {
      // D4: only a node that still HAD something to expand counts as a cut
      // (a leaf at the horizon truncates nothing).
      if (keysToExpand.length > 0 || partials.length > 0 || controlDeps?.(node.runtimeStageId) !== undefined) {
        truncatedByDepth = true;
      }
      continue;
    }

    // Data edges: for each key in this expansion's read-set, find who wrote
    // it. Under 'stage' this is the node's full read-set (historical
    // behavior); under 'per-write' it is the linking writes' temporal prefix
    // (or a worklist delta on re-expansion).
    // What each read could have seen is `readWindow.ts`'s rule: the last writer before the step
    // began, and every writer inside its read window (none for a step with no window).
    const keysRead = keysToExpand;
    const window = windowAt(commitIdx);
    for (const key of keysRead) {
      const sources = readSourcesOf(key, window, findWriter);
      if (sources.before < 0) {
        // F4b: say why there is no edge — no commit before this node began wrote the key. With
        // writers in its window the read may still be of that earlier value, so it is said then too.
        node.preRunReads ??= { code: 'pre-run-origin', keys: [] };
        if (!node.preRunReads.keys.includes(key)) node.preRunReads.keys.push(key);
      } else {
        linkParent(node, sources.before, 'data', key, depth, overlapOf(sources, sources.before));
      }
      for (const at of sources.during) linkParent(node, at, 'data', key, depth, overlapOf(sources, at));
    }

    // Built-on edges: for each write of this node that did not replace its key, the commit that
    // write was folded onto (`builtOn.ts`). A certain read of the same key from the same parent keeps
    // its own edge and no second one is added, whichever of the two the walk meets first (`linkParent`).
    //
    // The rule answers in commits; a node here is a step. When the commit underneath is an earlier one
    // of this SAME step there is no edge to draw (a step does not rest on itself): the walk passes
    // through it to what THAT commit was folded onto, or ends there when it replaced the value. Each
    // (step, key, commit) is followed once (`partialWrite`), so a step that committed many times costs
    // one lookup per commit, however often the walk comes to it.
    //
    // A `'view'` item is dated differently: the row holds what the step's VIEW held, so its sources
    // are the read rule's, asked with the view of the commit that carries the row (`CommitBundle.
    // viewAt`; a later commit of a step has a view of its own). That is one write, for certain. Only
    // where the view cannot be placed at one position of the array (`windowPlacement.ts`) is there
    // more than one, and then each is a possible source and its edge says so (`overlap`).
    const pending = [...partials];
    while (pending.length > 0) {
      const [key, at, from] = pending.pop()!;
      const under: Array<[position: number, overlap: SourceOverlap | undefined]> = [];
      if (from === 'fold') {
        const position = builtOnBefore(key, at, bundleAt, findWriter);
        if (position === undefined) continue; // not for a write `partialWrite` handed out; kept for the type
        under.push([position, undefined]);
      } else {
        const seen = readSourcesOf(key, places.view(at), findWriter);
        // One word for every write an unplaced view could have held: the reason is the array's, not a
        // running step's, and it is the same for the write before the range and for those inside it.
        const possible = viewOverlapOf(seen);
        under.push([seen.before, possible]);
        for (const position of seen.during) under.push([position, possible]);
      }
      for (const [position, overlap] of under) {
        if (position < 0) {
          // Nothing in the log is under this link: say why there is no edge, in the field of the link.
          // Folded onto what the key held before the run, or built on a view that held it, are two
          // statements (`CausalNode.preRunBase`, `preRunView`): only the first leaves the value partial.
          const keys =
            from === 'fold'
              ? (node.preRunBase ??= { code: 'from-initial-state', keys: [] }).keys
              : (node.preRunView ??= { code: 'pre-run-view', keys: [] }).keys;
          if (!keys.includes(key)) keys.push(key);
        } else if (commitLog[position].runtimeStageId === node.runtimeStageId) {
          pending.push(...partialWrite(node.runtimeStageId, key, position));
        } else {
          linkParent(node, position, 'data', key, depth, overlap, from === 'fold' ? 'partial-write' : 'built-on-view');
        }
      }
    }

    // Control edge (RFC-003 D3): link the governing decider, labeled by the
    // decide() rule label when present. The decider node then expands
    // normally through its own data reads (and its own control parent).
    if (controlDeps) {
      const dep = controlDeps(node.runtimeStageId);
      if (dep) {
        const deciderIdx = idxMap.get(dep.deciderId);
        if (deciderIdx !== undefined) {
          linkParent(node, deciderIdx, 'control', dep.label, depth);
        }
      }
    }
  }

  // RFC-003 D4 — truncation visibility on the root (absent when complete). It is DATA, and only
  // data: a reader reads `root.truncated` (and `formatCausalChain` prints it); the record writes no
  // console line (the dev-mode warning went in C6 — the record imports nothing outside itself).
  if (truncatedByDepth || truncatedByNodes) {
    root.truncated = { byDepth: truncatedByDepth, byNodes: truncatedByNodes };
  }

  return root;
}
