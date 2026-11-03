import type { RegisteredCode } from './honesty.js';
import type { UntrackedSource } from './types.js';
import type { SliceTruncation, SliceWalkOptions } from './queryLimits.js';

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
   * Parent nodes — stages this node depends on. DAG: multiple parents
   * possible. KEPT for compatibility; with the `controlDeps` option
   * (RFC-003 D3) governing deciders appear here too. For typed/keyed/
   * weighted detail use {@link parentEdges}.
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
  truncated?: SliceTruncation;
  /**
   * F4b (9.33.0) — the keys this node read that NO commit before it wrote (under the writer rule), so the
   * walk has no edge to follow for them: their value came from the initial state, frozen run input or a
   * closure — outside the commit log. The code says so (`'pre-run-origin'`, registered in
   * `memory/honesty.ts · HONESTY_CODES`); `keys` are in the order the walk met them. ABSENT when every key
   * the node expanded had a writer, so such a node keeps its 9.32.0 shape. Before 9.33.0 these reads were
   * dropped without a word.
   */
  preRunReads?: { code: RegisteredCode<'pre-run-origin'>; keys: string[] };
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
export interface CausalChainOptions extends SliceWalkOptions {
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
   * Ignored under `'stage'`. Unset → root expands at stage level.
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
