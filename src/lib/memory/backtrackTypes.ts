/**
 * backtrackTypes.ts — what a walk back hands out and takes in: the node and the edge of a result, the
 * control link a caller may supply, the hook that weighs an edge, and the options of one walk.
 *
 * WHY ITS OWN FILE: `backtrack.ts` had grown to 976 lines, and a third of it was these declarations.
 * They are read far more often than the walk itself (every reader in `slice/`, `cause/` and `prov/`
 * imports one of them), and they import nothing that runs. The walk is `backtrack.ts`; it hands these
 * names out again, so an importer names one file.
 */

import type { RegisteredCode } from './honesty.js';
import type { BuiltOn, SourceOverlap } from './parentEdges.js';
import type { UntrackedSource } from './types.js';

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
