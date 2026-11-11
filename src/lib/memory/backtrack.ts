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

import { builtOnBefore, readFromView, replacesValue, viewOverlapOf } from './builtOn.js';
import { buildCommitIndex, lastWriterPosition } from './commitLogUtils.js';
import type { RegisteredCode } from './honesty.js';
import { queryWork, relation, writesOnlyInside } from './keyPaths.js';
import { logModel } from './logModel.js';
import { type LastWriterBefore, overlapOf, readSourcesOf } from './readWindow.js';
import { type BuiltOn, type SourceOverlap, takeLink } from './parentEdges.js';
import { placesOf } from './windowPlacement.js';
import { shownPath } from '../record-paths/codec.js';
import type { CommitBundle, TraceEntry, UntrackedSource } from './types.js';

// ── Types ──────────────────────────────────────────────────────────────

/** A single node in the causal DAG. */
export interface CausalNode {
  /** Unique execution step identifier. */
  runtimeStageId: string;
  /** Stable stage identifier. */
  stageId: string;
  /** Human-readable stage name. */
  stageName: string;
  /** Keys this stage wrote (from its CommitBundle.trace). */
  keysWritten: string[];
  /** The key whose read→write dependency linked this node to its child. Empty for the root. */
  linkedBy: string;
  /** BFS depth from the starting node (0 = start). */
  depth: number;
  /**
   * Parent nodes — stages this node depends on. Multiple parents are
   * possible, a parent can be shared, and two steps whose commits
   * interleave on one key can each be the other's parent (see the file
   * header): visit a node once. KEPT for compatibility; with the
   * `controlDeps` option (RFC-003 D3) governing deciders appear here too.
   * For typed/keyed/weighted detail use {@link parentEdges}.
   */
  parents: CausalNode[];
  /**
   * RFC-003 D3 — one edge per dependency LINK (not per parent): a node
   * reading two keys from the same writer has ONE entry in {@link parents}
   * but TWO `'data'` edges here. Control dependencies (via the
   * `controlDeps` option) add a `'control'` edge to the governing decider.
   */
  parentEdges: CausalEdge[];
  /**
   * RFC-003 D2 honesty marker — stamped from the stage's
   * `CommitBundle.untrackedSources`. Present when this stage ALSO consumed
   * untracked read paths (`args` / `env` / unshadowed `silent` reads): the
   * backward slice through this node may be incomplete, because those reads
   * produce no read→write edge to follow. `formatCausalChain` renders this
   * as a `⚠ … slice may be incomplete here` line. Absent when the stage's
   * reads were fully tracked.
   *
   * Registry code: `'incomplete-sources'` (`memory/honesty.ts ·
   * HONESTY_CODES`, served on `foottrace`) says what this field
   * means. The field carries no `code` — its values are the
   * {@link UntrackedSource}s.
   */
  incompleteSources?: ReadonlyArray<UntrackedSource>;
  /**
   * RFC-003 D4 truncation visibility — set on the ROOT node only, and only
   * when a limit actually cut the slice: `byDepth` when a node at the
   * `maxDepth` horizon still had edges to expand, `byNodes` when the
   * `maxNodes` budget blocked creating a discovered parent. Absent when the
   * slice is complete. `formatCausalChain` appends a `⚠ slice truncated …`
   * line — a consumer must never mistake a truncated slice for a full one.
   * (Until 9.48.0 dev mode also warned on the console; the field is the
   * signal, read it.)
   *
   * Registry code: `'truncated'` (`memory/honesty.ts · HONESTY_CODES`, served
   * on `foottrace`) says what this field means; the field carries no
   * `code`.
   */
  truncated?: { byDepth: boolean; byNodes: boolean };
  /**
   * F4b (9.33.0) — the keys this node read that NO commit before it wrote (under the writer rule), so the
   * walk has no edge to follow for them: their value came from the initial state, frozen run input or a
   * closure — outside the commit log. The code says so (`'pre-run-origin'`, registered in
   * `memory/honesty.ts · HONESTY_CODES`); `keys` are in the order the walk met them. ABSENT when every key
   * the node expanded had a writer, so such a node keeps its 9.32.0 shape. Before 9.33.0 these reads were
   * dropped without a word.
   */
  preRunReads?: { code: RegisteredCode<'pre-run-origin'>; keys: string[] };
  /**
   * The keys this node wrote WITHOUT replacing them (a merge, an append, a row inside the key) when no
   * commit before it had written them: what it left under such a key was folded onto the value the key
   * held before the run, which the commit log cannot see, so the walk has no edge to follow for that
   * part. The code says so (`'from-initial-state'`, registered in `memory/honesty.ts · HONESTY_CODES`);
   * `keys` are in the order the walk met them. Only for a key the walk came through (a child read it
   * from this node, or it is the key a slice is about). ABSENT otherwise, so a node keeps its shape.
   * It speaks of the FOLD only: a `set` row the writer built on a view that held no write of the key
   * is in `preRunView`.
   */
  preRunBase?: { code: RegisteredCode<'from-initial-state'>; keys: string[] };
  /**
   * The keys for which this node holds a `set` row the WRITER built on its step's view
   * (`TraceEntry.builtOnView`; on the key, around it, or on a path inside it) when no commit had
   * written the key before that view was pinned: what the row holds of the key beyond the step's own
   * writes was absent or came from the state before the run, which the commit log cannot see, so the
   * walk has no edge to follow for that part. The code says so (`'pre-run-view'`, registered in
   * `memory/honesty.ts · HONESTY_CODES`); `keys` are in the order the walk met them. Said too where
   * the record does not show where the view sits and it only MAY have been pinned that early: the
   * writes it could have held instead are then edges with `overlap: 'view-not-placed'`. Only for a
   * key the walk came through. ABSENT otherwise, so a node keeps its shape.
   *
   * WHY A FIELD OF ITS OWN. Not `preRunReads`: no code of the step read the key, the same reason the
   * edge to a write a view held is marked `builtOn: 'built-on-view'`. Not `preRunBase`: that one says
   * the write was FOLDED onto the pre-run value, with no write of the whole value under it, so the
   * value there may be partial. A marked `set` of the key replaced the value in the fold and holds
   * all of it. What the log cannot see here is only where part of it came from.
   */
  preRunView?: { code: RegisteredCode<'pre-run-view'>; keys: string[] };
}

/**
 * RFC-003 D3 — a typed dependency edge from a child node to one parent.
 *
 * - `kind: 'data'`    — read→write dependency; `key` is the state key.
 * - `kind: 'control'` — the parent is the decider/selector whose decision
 *   allowed the child to run; `key` is the decide() rule label when present.
 *
 * `weight` defaults to 1.0; the `weigh` hook (RFC-003 D4) can override it.
 * The engine itself NEVER computes weights — semantics belong to the
 * consumer-injected weigher.
 */
export interface CausalEdge {
  parent: CausalNode;
  kind: 'data' | 'control';
  key?: string;
  weight: number;
  /**
   * F4b (9.33.0) — present only on a `'data'` edge whose parent wrote `key` ONLY through rows inside it
   * (a subflow's input seed, an outputMapper merge-back, a fork child's namespace): that write made part
   * of the value, and earlier writers may account for the rest. Registered as `'nested-rows'` in
   * `memory/honesty.ts · HONESTY_CODES`. Absent for a write on or around the key, so an exact edge keeps
   * its 9.32.0 shape.
   */
  basis?: RegisteredCode<'nested-rows'>;
  /**
   * Present only on a `'data'` edge whose `key` was written inside the child's read window
   * (`CommitBundle.beganAt` / `sawUntil`: steps side by side, and the child looked at state again
   * after a sibling committed; or an array that does not show where that window sits, so that a write
   * which could lie in it is taken to). The record cannot say which value the read saw, so EVERY edge of the
   * child for that key carries a mark and is a possible source, not a certain one; the real source is
   * among them (or is the value from before the run, when `preRunReads` lists the key):
   *   - `'replaced-while-running'`: the parent wrote the value the key held when the child began;
   *   - `'written-while-running'`: the parent wrote the key inside the window.
   * An edge a view made (`builtOn: 'built-on-view'`) is only possible for another reason, and says
   * it in a word of its own:
   *   - `'view-not-placed'`: the array does not show where the view of the child's row sits, so the
   *     parent is one of the writes that view could have held (`memory/builtOn.ts · ViewOverlap`).
   * All are registered in `memory/honesty.ts · HONESTY_CODES`. Absent on a certain edge, so the
   * edge of a step with no window keeps its shape.
   */
  overlap?: SourceOverlap;
  /**
   * Present only on a `'data'` edge that no READ by the child's code made: what the child left under
   * `key` still holds part of what the parent had written, and the record's rows say why
   * (`memory/builtOn.ts`):
   *   - `'partial-write'`: the child's own write of `key` did not replace the value (it merged into
   *     it, appended to it, or wrote a path inside it). The parent is the last commit that wrote
   *     `key` before the child's write, in commit order: a fold applies commits in that order, so
   *     this edge is exact;
   *   - `'built-on-view'`: the child's write is a `set` row the WRITER built on the step's view
   *     (`TraceEntry.builtOnView`). The parent is the write that view held, found by the moment the
   *     view was pinned (`CommitBundle.viewAt`): one write, for certain. Only where the reader
   *     cannot place that moment at one position of the array it was handed (`windowPlacement.ts`
   *     has the cases; bundles that say no index are the usual one) does the edge carry `overlap`,
   *     with the view's own word (`'view-not-placed'`): the parent is then one of the writes the
   *     view could have held.
   * Both are registered in `memory/honesty.ts · HONESTY_CODES`. Absent on an edge a read made, so
   * such an edge keeps its shape. When the child ALSO read `key` from this parent, for certain, the
   * read's edge stands alone and no second one is added; beside a read that is only a possible
   * source (`overlap`), both edges are there when this one is certain. Where both reasons name one
   * parent for certain there is one edge, and it says `'partial-write'`. One that is only possible
   * is dropped as soon as any certain edge names that parent. The rule is `parentEdges.ts`, and it
   * does not depend on the order the walk meets the links in.
   */
  builtOn?: BuiltOn;
}

/**
 * RFC-003 D3 — a control dependency resolved for one execution step:
 * which decider/selector execution allowed this stage to run.
 */
export interface ControlDependency {
  /** runtimeStageId of the governing decider/selector execution step. */
  deciderId: string;
  /** The decide() rule label for the chosen branch, when present. */
  label?: string;
}

/**
 * RFC-003 D3 — callback resolving the governing decider for an execution
 * step. Return `undefined` when the step is not control-dependent on any
 * recorded decision. Build one with `controlDepRecorder()` from
 * `footprintjs/trace`, or supply your own.
 */
export type ControlDepLookup = (runtimeStageId: string) => ControlDependency | undefined;

/**
 * RFC-003 D4 — consumer-injected edge weigher. Called once per created
 * edge; return a weight, or `undefined` to keep the default 1.0. The
 * ENGINE never computes weights (zero new dependencies — semantics like
 * embedding similarity or FDL influence belong to downstream libraries,
 * the same plug-in pattern as `NarrativeFormatter`). Weights render in
 * `formatCausalChain` as `← via systemPrompt (0.18)`.
 */
export type EdgeWeigher = (
  child: CausalNode,
  parent: CausalNode,
  key: string | undefined,
  kind: 'data' | 'control',
) => number | undefined;

/** Options for causalChain(). */
export interface CausalChainOptions {
  /** Maximum BFS depth (default: 20). Prevents runaway traversal. */
  maxDepth?: number;
  /** Maximum total nodes to visit (default: 100). Hard cap for safety. */
  maxNodes?: number;
  /**
   * RFC-003 D3 — control-dependence lookup. When provided, expanding a node
   * ALSO links a `'control'` edge to its governing decider (labeled by the
   * decide() rule label when present); the decider node then expands
   * normally through its own data reads, so chains like
   * `status ← [control] ClassifyRisk ← [data: creditScore] PullBureau`
   * resolve end-to-end. Without this option behavior is unchanged.
   */
  controlDeps?: ControlDepLookup;
  /**
   * RFC-003 D4 — edge weigher. Stamps `CausalEdge.weight` at edge creation;
   * `undefined` (or no weigher) → 1.0. See {@link EdgeWeigher}.
   */
  weigh?: EdgeWeigher;
  /**
   * #P1 — how a node's expansion read-set is derived:
   *
   * - `'stage'` (default, historical) — every visited node expands through
   *   ALL of its stage's reads (`getKeysRead`). A stage reading `a,b` and
   *   writing `x,y` links both reads as causes of both writes — a sound but
   *   coarse over-approximation.
   * - `'per-write'` — when the commit log carries per-write read provenance
   *   (`TraceEntry.readKeys`, recorded under the executor's
   *   `writeProvenance: 'reads-prefix'` dial), a node reached via key `k`
   *   expands through ONLY the reads that preceded its write of `k`
   *   (temporal prefix). Nodes linked later via additional keys are
   *   incrementally re-expanded with just the new reads (worklist — the
   *   slice only ever GROWS toward the stage-level ceiling). HONEST
   *   FALLBACK: any link whose trace entry lacks `readKeys` expands that
   *   node at stage level — mixed or dial-off logs degrade to `'stage'`
   *   behavior exactly, never to silence.
   */
  edgeAttribution?: 'stage' | 'per-write';
  /**
   * #P1 — the written keys that anchor the ROOT's expansion under
   * `'per-write'` (e.g. `sliceForKey` passes the sliced key, so the root
   * expands through the reads that fed THAT write, not the whole stage).
   * Unset → root expands at stage level. Under `'stage'` they do not narrow
   * the root's reads.
   *
   * Under BOTH settings they also say which of the root's writes the walk is
   * about: a root that wrote one of these keys without replacing it is
   * linked to what that write was built on (`CausalEdge.builtOn`). A root
   * that is only a reader (plain `causalChain`, no keys given) has no such
   * edge of its own.
   */
  rootLinkKeys?: string[];
}

/**
 * Callback that returns the keys a stage read during execution.
 * The backtracker calls this for each visited node to determine
 * which read→write edges to follow.
 *
 * Implementors: QualityRecorder tracks keysRead per step,
 * or build a Map<runtimeStageId, string[]> from ScopeRecorder.onRead events.
 */
export type KeysReadLookup = (runtimeStageId: string) => string[];

// ── Staged optimization: writer lookup strategies ──────────────────────

/**
 * Threshold for switching from linear scan to reverse index.
 * Below this, O(N) scan is faster (no index build cost).
 * Above this, O(log N) binary search wins.
 */
const REVERSE_INDEX_THRESHOLD = 256;

/**
 * Writer lookup function signature.
 * Returns the ARRAY position of the commit that last wrote `key` before position `beforeIdx`, or -1.
 */
type WriterLookup = LastWriterBefore;

/** Strategy 1: Linear scan — O(N) per lookup, zero setup cost. */
function linearScanLookup(commitLog: CommitBundle[]): WriterLookup {
  return (key, beforeIdx) => lastWriterPosition(commitLog, key, beforeIdx);
}

/**
 * Strategy 2: Reverse index — one O(rows) build, O(depth + log N) per lookup.
 * The log's read model (`logModel.ts`: a path trie, each top-level key folded at
 * most once) answers the writer rule — rows on, inside or around the key — by
 * binary search for the last write on or inside it, then a verdict only for the
 * around-candidates after it. The same answer `findLastWriter` gives, so the
 * strategy switch below never changes a slice.
 */
function reverseIndexLookup(commitLog: CommitBundle[]): WriterLookup {
  const model = logModel(commitLog);
  return (key: string, beforeIdx: number): number => model.lastWriterBefore(key, beforeIdx);
}

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

/**
 * Staged optimization: pick the right writer-lookup strategy based on data size.
 *
 * Like a database query optimizer choosing between sequential scan and index scan:
 *
 * - **Small log (≤ 256):** the scan (`findLastWriter`). No model is built for the call unless
 *   a lookup needs one; a frozen log is answered from its memoised read model.
 *
 * - **Large log (> 256):** the read model. One O(rows) build is amortized across all BFS
 *   hops, and each lookup is a binary search instead of a scan. For an agent loop with 500
 *   iterations and 5 keys per hop, this is 500×5×log(500)≈22K ops vs 500×5×500=1.25M ops
 *   with a scan.
 *
 * The caller never sees this — `causalChain()` picks automatically.
 */
function createWriterLookup(commitLog: CommitBundle[]): WriterLookup {
  if (commitLog.length <= REVERSE_INDEX_THRESHOLD) {
    return linearScanLookup(commitLog);
  }
  return reverseIndexLookup(commitLog);
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

// ── Utilities ──────────────────────────────────────────────────────────

/**
 * Flatten the causal DAG into a BFS-ordered list of nodes.
 * Each node appears exactly once (first occurrence by BFS order).
 * Useful for linear display or iteration.
 */
export function flattenCausalDAG(root: CausalNode): CausalNode[] {
  const result: CausalNode[] = [];
  const visited = new Set<string>();
  const queue: CausalNode[] = [root];

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (visited.has(node.runtimeStageId)) continue;
    visited.add(node.runtimeStageId);
    result.push(node);

    for (const parent of node.parents) {
      if (!visited.has(parent.runtimeStageId)) {
        queue.push(parent);
      }
    }
  }

  return result;
}

/**
 * Format a causal DAG as human-readable indented text.
 * Shows the dependency chain with depth indentation and linked-by keys.
 *
 * RFC-003 D2: nodes that consumed untracked read paths render an extra
 * `⚠ also consumed … — slice may be incomplete here` line, so a consumer
 * (human or LLM) debugging from the slice is TOLD when it is incomplete.
 *
 * RFC-003 D3: control edges render as `← [control: <rule label>]`
 * (label omitted when the decision carried none). A data edge renders as
 * `← via <key>`: the key of the edge from the child the node is shown under
 * (the first one, when that child read several keys from this node). A parent
 * that is only a possible source of a key (`CausalEdge.overlap`) says why:
 * `← via x (as the reader began; written again while it ran)` or
 * `← via x (written while the reader ran)`, naming the keys when they are not
 * the one shown.
 *
 * An edge no read made (`CausalEdge.builtOn`: the child's write of the key did not replace the value,
 * or the writer built it on the step's view, so it kept part of what the parent had written) renders
 * as `← built on <key>`.
 *
 * RFC-003 D4: edge weights from the `weigh` hook render as a suffix —
 * `← via systemPrompt (0.18)` — only when ≠ 1.0, so unweighted output is
 * unchanged. A truncated slice (root.truncated) appends a final
 * `⚠ slice truncated …` line.
 */
/** How a tree line says each mark. Short on purpose: the full sentence is the registry's. */
const OVERLAP_WORDS: Record<SourceOverlap, string> = {
  'replaced-while-running': 'as the reader began; written again while it ran',
  'written-while-running': 'written while the reader ran',
  'view-not-placed': 'possibly: the array does not show where the view sits',
};

export function formatCausalChain(root: CausalNode): string {
  const lines: string[] = [];
  const visited = new Set<string>();

  const weightSuffix = (edge: CausalEdge | undefined): string =>
    edge !== undefined && edge.weight !== 1 ? ` (${edge.weight})` : '';
  // The keys this parent is only a possible source of, said per mark (`CausalEdge.overlap`).
  const overlapSuffix = (edges: CausalEdge[] | undefined, shown: CausalEdge): string =>
    (Object.keys(OVERLAP_WORDS) as SourceOverlap[])
      .map((mark) => {
        const keys = [...new Set((edges ?? []).filter((e) => e.overlap === mark && e.key).map((e) => e.key as string))];
        if (keys.length === 0) return '';
        const only = keys.length === 1 && keys[0] === shown.key;
        return only ? ` (${OVERLAP_WORDS[mark]})` : ` (${OVERLAP_WORDS[mark]}: ${keys.map(shownPath).join(', ')})`;
      })
      .join('');

  function walk(node: CausalNode, indent: number, edgesFromChild?: CausalEdge[]): void {
    if (visited.has(node.runtimeStageId)) {
      lines.push(`${'  '.repeat(indent)}↳ ${node.runtimeStageId} (see above)`);
      return;
    }
    visited.add(node.runtimeStageId);

    // The key is the DISPLAYED child's own edge to this node. `node.linkedBy` is the key of whichever
    // child discovered the node first (breadth-first), and this walk is depth-first: under another
    // child it named a key that child never read.
    const linkParts: string[] = [];
    // A read's edge is shown before one no read made (`CausalEdge.builtOn`): `via x` says the child
    // read `x` from this node; `built on x` says the child's own write of `x` kept part of what this
    // node had written there.
    const dataEdge =
      edgesFromChild?.find((e) => e.kind === 'data' && e.builtOn === undefined) ??
      edgesFromChild?.find((e) => e.kind === 'data');
    if (dataEdge?.key)
      linkParts.push(
        `${dataEdge.builtOn === undefined ? 'via' : 'built on'} ${shownPath(dataEdge.key)}${weightSuffix(
          dataEdge,
        )}${overlapSuffix(edgesFromChild, dataEdge)}`,
      );
    const controlEdge = edgesFromChild?.find((e) => e.kind === 'control');
    if (controlEdge) {
      linkParts.push(`[control${controlEdge.key ? `: ${controlEdge.key}` : ''}]${weightSuffix(controlEdge)}`);
    }
    const link = linkParts.length > 0 ? ` ← ${linkParts.join(' ← ')}` : '';

    const writes = node.keysWritten.length > 0 ? ` [wrote: ${node.keysWritten.map(shownPath).join(', ')}]` : '';
    lines.push(`${'  '.repeat(indent)}${node.stageName} (${node.runtimeStageId})${link}${writes}`);

    if (node.incompleteSources && node.incompleteSources.length > 0) {
      lines.push(
        `${'  '.repeat(indent + 1)}⚠ also consumed ${node.incompleteSources.join('/')} — slice may be incomplete here`,
      );
    }

    for (const parent of node.parents) {
      walk(
        parent,
        indent + 1,
        node.parentEdges.filter((e) => e.parent === parent),
      );
    }
  }

  walk(root, 0);

  if (root.truncated) {
    const causes = [root.truncated.byDepth && 'maxDepth reached', root.truncated.byNodes && 'maxNodes reached']
      .filter(Boolean)
      .join(', ');
    lines.push(`⚠ slice truncated (${causes}) — older causes exist beyond this horizon`);
  }

  return lines.join('\n');
}

// ── Exported for testing (internal) ────────────────────────────────────

/** @internal Exposed for testing the strategy selection. */
export const _REVERSE_INDEX_THRESHOLD = REVERSE_INDEX_THRESHOLD;
