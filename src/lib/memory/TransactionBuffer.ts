/**
 * TransactionBuffer — Per-stage STAGING buffer for state mutations
 *
 * What it IS: a staging buffer with read-your-writes and net-change commits.
 * - Changes are staged here during stage execution and flushed to
 *   SharedMemory in ONE batch per stage (`commit()`) — other stages and
 *   parallel siblings never observe a stage's half-finished writes.
 * - Read-after-write consistency within a stage — a stage sees its own
 *   staged writes immediately.
 * - `commit()` records the stage's NET change (see {@link commit}), plus an
 *   operation trace for deterministic replay.
 *
 * What it is NOT: a rollback mechanism. Despite the name, there is no
 * abort/rollback path — when a stage THROWS, the engine still commits
 * everything staged so far before re-throwing (commit-on-error in
 * `FlowchartTraverser`). That is deliberate: the audit trail must record
 * what the failing stage changed. Do not rely on "stage failed → its
 * writes vanished".
 *
 * The patch trees hold REFERENCES until commit (9.23.0). A `set` stores the
 * caller's own value in `overwritePatch` exactly as it always did in
 * `workingCopy`; the copy the record needs is taken ONCE per surviving path
 * when the payload leaves the buffer (`toChangeOnlyPayload` /
 * `toDeltaPayload`, whose rows are laid out in `fullRows.ts` / `deltaRows.ts`
 * — every value they emit passes through `structuredClone` there). The law
 * "the record never aliases a caller's object" is kept at
 * the commit boundary instead of at every write, which is what makes N
 * writes to one path O(N) instead of O(N × size). Consequence, by design: a
 * caller who mutates its own object AFTER the write and BEFORE the stage
 * ends commits the value as the stage read it back — the record agrees with
 * the stage (CLAUDE.md landmine 3's first bite, closed). The one place the
 * engine itself edits THROUGH a staged value — a later nested op under a
 * `set` path — detaches that value first ({@link detachHeldAncestors}), so
 * `workingCopy` and `overwritePatch` never share a container the engine
 * mutates on one side only.
 *
 * COPY-ON-WRITE (9.29.0 — docs/design/2026-10-copy-on-write-commit.md). The
 * buffer no longer clones the committed state it starts from. `baseSnapshot`
 * IS the committed generation the stage first touched (held by reference —
 * committed state is immutable-after-swap), and `workingCopy` starts as a
 * copy of its ROOT only: each write copies the containers on its own path
 * ({@link ownSpine}), and the first READ after the stage's first write of a
 * container still shared with committed state takes a private deep copy of
 * it ({@link privatise}) — what the whole-state clone used to give every
 * read, so an in-place edit of a read value stays private exactly as it did.
 * An unresolved read not covered by a hard write may use live state; the
 * buffer then replaces that path of its diff base
 * with a private copy ({@link detachBase}), as the clone had it.
 *
 * THE ADMITTED RECORD (9.30.0 — docs/design/2026-10-admitted-record.md). A
 * commit is admitted only if its bundle folds back to the stage's
 * read-your-writes view at every path the stage touched (and at every
 * container its writes created on the way there, below the stage's address).
 * Both encoders commit the value the stage read: a compact row — a `merge`
 * delta, an `append` tail — is kept where it provably folds back; a family of
 * rows that does not is recorded as `set` rows of the values the stage read
 * ({@link admit}). Before 9.30.0 the one accumulated merge delta per path was
 * replayed at every `merge` row of that path, which lied across a hard write
 * (`$update(k,{x}); k = {y}; $update(k,{z})` committed `{y, x, z}` for a
 * read-back of `{y, z}`), an `[]` clear, a kind change or an array union
 * deduplicated by reference. Verified when the stage staged a `merge` or a
 * nested op; a stage that staged only `set` / `delete` of keys directly under
 * its address is coherent by construction — both trees receive the same
 * write — and is admitted without the fold.
 *
 * WHAT IS IN THIS FILE, AND WHAT IS NOT. Here: staging (`set` / `merge` /
 * `delete`), the copy-on-write reads, and the commit that hands the staged
 * stage to an encoder and admits the result. Not here, because they only READ
 * what was staged and each is a job of its own: the two row layouts
 * (`fullRows.ts`, `deltaRows.ts`), the read-back of a family that does not fold
 * back (`readBack.ts`), and the view they are handed (`staged.ts`).
 */

import { putOwn } from '../capture/ownData.js';
import { type Lossy, type Rows, addressDepthOf, lossyFamilies } from './admission.js';
import { deltaRows } from './deltaRows.js';
import type { OpVerb } from './deltaEncoding.js';
import { changeOnlyRows, fullRowsValue } from './fullRows.js';
import { hardWriteCovers } from './hardWriteCoverage.js';
import { relation } from './keyPaths.js';
import {
  adopt,
  isContainer,
  nativeGet as _get,
  nativeSet as _set,
  own,
  ownChild,
  ownedRootOf,
  ownSpine,
  shallowCopy,
} from './pathOps.js';
import { type BufferOp, type Staged, survivingRedactedPaths } from './staged.js';
import type { CommitValuesMode, MemoryPatch, TraceEntry } from './types.js';
import type { NativeReadObservation } from './pathOps.js';
import type { SourceStaging } from '../read-sources/staging.js';
import { deepSmartMerge, normalisePath } from './utils.js';

export class TransactionBuffer {
  /**
   * The net-change diff base: the committed generation the stage first
   * touched, by reference — except where {@link detachBase} replaced a path
   * of it with a private copy (its root and the containers on the way are
   * then copies too, owned by {@link baseOwned}).
   */
  private baseSnapshot: any;
  private workingCopy: any;

  private overwritePatch: MemoryPatch = {};
  private updatePatch: MemoryPatch = {};
  private opTrace: BufferOp[] = [];
  private redactedPaths = new Set<string>();
  private hardWriteKeys = new Set<string>();
  /**
   * Paths whose `overwritePatch` value is the caller's own object (9.23.0):
   * a `set` of a container stores the reference, and this is the ledger of
   * which ones are still shared with the caller (and with `workingCopy`).
   * Consulted only by the engine's nested ops — see
   * {@link detachHeldAncestors}; the commit payload clones every surviving
   * value anyway and never asks. Cleared with the rest at `commit()`.
   */
  private heldRefs = new Set<string>();
  /** Commit-value encoding policy (#13c-B). `'full'` = historical bytes. */
  private readonly commitValues: CommitValuesMode;

  /** Per-write read-provenance source (#P1). When set (the
   *  `writeProvenance: 'reads-prefix'` dial), every staged op snapshots the
   *  keys tracked-read so far — the temporal-prefix attribution consumed by
   *  causal slicing. Undefined (default) = zero cost, byte-identical ops. */
  private readonly readKeysProvider?: () => string[];

  /**
   * The containers in `workingCopy` this buffer CREATED: its root copy, the
   * path copies its writes made, the merge results it built, and every
   * container of the private copies its reads took. A write edits these in
   * place. Everything else in `workingCopy` is SHARED — with the committed
   * generation the stage first touched, or with a value the stage staged —
   * and is copied before a write passes through it ({@link ownSpine}).
   */
  private owned = new WeakSet<object>();

  /**
   * Container values the stage staged with {@link set} — its own objects,
   * held by reference (9.23.0). A read hands them back as they are, exactly
   * as the private working copy always did, and never privatises them: a
   * private copy of a staged value would leave `workingCopy` and
   * `overwritePatch` disagreeing about a value the stage wrote.
   */
  private staged = new WeakSet<object>();

  /**
   * Owned containers with no container still shared with committed state
   * anywhere below them (a private deep copy, a merge result built on a
   * private base, a path copy whose shared children were privatised). A read
   * that lands on one needs no walk — see {@link privatiseBelow}.
   */
  private privateTrees = new WeakSet<object>();

  /**
   * The containers of {@link baseSnapshot} that {@link detachBase} created:
   * its root copy and the copies on the way to a detached path. Allocated
   * only by the first detach — the in-contract stage never pays for it.
   */
  private baseOwned?: WeakSet<object>;

  /**
   * The private deep copies {@link detachBase} put into the diff base: nothing
   * at or below one is committed state, so a later detach inside it is a no-op.
   */
  private detachedBase?: WeakSet<object>;

  /**
   * Where the stage writes (9.30.0): a path prefix its frame computed and
   * hands over as data (C2 — for the engine, the frame's run namespace, or
   * `[]` for the root). Its containers are the stage's ADDRESS, not a value
   * the stage reads (every read it makes is a key below it), so a shell a
   * write leaves there is no part of the read-back the record must hold.
   */
  private readonly address: readonly string[];

  /** `merge` ops staged since the last commit — see {@link admit}. */
  private stagedMerges = 0;
  /** Ops staged deeper than one key below the stage's address — see {@link admit}. */
  private nestedOps = 0;
  private declare sourceStaging?: SourceStaging;

  constructor(
    base: any,
    commitValues: CommitValuesMode = 'full',
    readKeysProvider?: () => string[],
    address: readonly string[] = [],
    sourceStaging?: SourceStaging,
    private readonly readAttemptsProvider?: () => Pick<TraceEntry, 'readAttempts' | 'readAttemptsOmitted'> | undefined,
  ) {
    // `base` is the committed generation the stage first touched —
    // immutable-after-swap, the invariant the first-touch view already rests
    // on — so the diff base is held by REFERENCE, and the working copy starts
    // as a copy of its ROOT only. Before 9.29.0 these two lines were two
    // `structuredClone`s of the whole state, paid by every stage that wrote.
    this.baseSnapshot = base;
    this.workingCopy = ownedRootOf(base, this.owned);
    this.commitValues = commitValues;
    this.readKeysProvider = readKeysProvider;
    this.address = address;
    if (sourceStaging) this.sourceStaging = sourceStaging;
  }

  /** Stamp the current read prefix onto a staged op — only when the
   *  provenance dial is on (provider present), so the default path allocates
   *  nothing and commit bundles stay byte-identical. */
  private stampReadKeys(op: BufferOp): BufferOp {
    if (this.readKeysProvider) op.readKeys = this.readKeysProvider();
    const attempts = this.readAttemptsProvider?.();
    if (attempts?.readAttempts?.length) {
      op.readAttempts = [...attempts.readAttempts];
      if (attempts.readAttemptsOmitted) op.readAttemptsOmitted = attempts.readAttemptsOmitted;
    }
    return op;
  }

  /** Stage an op into `opTrace`, counting what decides whether {@link admit} must fold. */
  private stage(path: (string | number)[], key: string, verb: OpVerb): void {
    if (verb === 'merge') this.stagedMerges++;
    if (path.length - addressDepthOf(path, this.address) > 1) this.nestedOps++;
    this.sourceStaging?.write(path, verb, this.redactedPaths.has(key));
    this.opTrace.push(this.stampReadKeys({ path: key, verb }));
    if (verb === 'set' || verb === 'delete') this.hardWriteKeys.add(key);
  }

  /**
   * Hard overwrite at the specified path. Stores the REFERENCE in both trees
   * (9.23.0) — the record's copy is taken once, at commit; see the header.
   */
  set(path: (string | number)[], value: any, shouldRedact = false): void {
    const source = this.sourceStaging;
    source?.beginMutation();
    let succeeded = false;
    try {
      const key = normalisePath(path);
      this.detachHeldAncestors(path);
      ownSpine(this.workingCopy, path, this.owned);
      _set(this.workingCopy, path, value);
      _set(this.overwritePatch, path, value);
      if (isContainer(value)) {
        this.heldRefs.add(key);
        this.staged.add(value);
      } else {
        this.heldRefs.delete(key);
      }
      if (shouldRedact) {
        this.redactedPaths.add(key);
      }
      this.stage(path, key, 'set');
      succeeded = true;
    } finally {
      source?.endMutation(succeeded);
    }
  }

  /**
   * A nested op is about to write THROUGH a path whose `overwritePatch`
   * value is a held reference (9.23.0). Today's law is that the two trees
   * receive the same nested `set`/`delete` mutations but ONLY `workingCopy`
   * receives a nested `merge`'s result (`updatePatch` gets the delta) — so a
   * container shared between the trees would leak the merged value into the
   * overwrite payload, and a shared container is also the caller's own
   * object, which the engine must not edit on the record's behalf. Replacing
   * the held ancestor with its clone in `overwritePatch` restores exactly
   * the private tree the per-write clone used to give it, paid once per
   * ancestor and only on the nested-op path the public surface never takes
   * (the scope proxy writes ROOT keys). `workingCopy` keeps the reference,
   * as it always did.
   */
  private detachHeldAncestors(path: (string | number)[]): void {
    if (this.heldRefs.size === 0) return;
    for (let i = 1; i < path.length; i++) {
      const ancestor = path.slice(0, i);
      const key = normalisePath(ancestor);
      if (!this.heldRefs.has(key)) continue;
      const held = _get(this.overwritePatch, ancestor);
      if (held !== null && typeof held === 'object') _set(this.overwritePatch, ancestor, structuredClone(held));
      this.heldRefs.delete(key);
    }
  }

  /**
   * Explicit key deletion at the specified path (#13c-B; absorbs backlog B8).
   *
   * Stages EXACTLY the same buffer mutations as `set(path, undefined)` —
   * `workingCopy`/`overwritePatch` get an own `undefined` at the path (the
   * historical flattening, preserving patch bytes and the dedup diff base
   * across modes) — but records the op verb as `'delete'`. At commit:
   * `'full'` mode maps it back to a `'set'` trace entry (byte-identical to
   * today); `'delta'` mode emits a real `'delete'` entry whose replay
   * REMOVES the key instead of leaving `key: undefined` behind.
   *
   * The net-change filter reads that staged own `undefined` as ABSENT
   * (`deepEqual`, 9.19.1) — so under `'delta'`, whose committed state really
   * lacks the key, deleting an absent key inside a container the stage also
   * re-wrote is the no-op it is, not a `set` of the whole container.
   */
  delete(path: (string | number)[], shouldRedact = false): void {
    const source = this.sourceStaging;
    source?.beginMutation();
    let succeeded = false;
    try {
      const key = normalisePath(path);
      this.detachHeldAncestors(path);
      ownSpine(this.workingCopy, path, this.owned);
      _set(this.workingCopy, path, undefined);
      _set(this.overwritePatch, path, undefined);
      this.heldRefs.delete(key);
      if (shouldRedact) {
        this.redactedPaths.add(key);
      }
      this.stage(path, key, 'delete');
      succeeded = true;
    } finally {
      source?.endMutation(succeeded);
    }
  }

  /** Deep union merge at the specified path. `deepSmartMerge` builds fresh
   *  containers, so neither tree ever holds the merge INPUT by reference;
   *  the nested-op detach guards the ancestor it writes INTO.
   *
   *  The value merged INTO is made private first (`privatise`), as the
   *  whole-state clone made it before 9.29.0. Not only for the reads that
   *  follow: `deepSmartMerge` unions arrays BY REFERENCE, so whether an
   *  element the stage passes in is "already there" depends on which objects
   *  the base holds — a committed array would dedup an element the stage
   *  read from it before its first write, where the private copy (and
   *  9.28.0) appends it. */
  merge(path: (string | number)[], value: any, shouldRedact = false): void {
    const source = this.sourceStaging;
    source?.beginMutation();
    let succeeded = false;
    try {
      const key = normalisePath(path);
      this.detachHeldAncestors(path);
      this.privatise(path);
      const existing = _get(this.workingCopy, path) ?? {};
      const merged = deepSmartMerge(existing, value);
      ownSpine(this.workingCopy, path, this.owned);
      own(merged, this.owned);
      if (isContainer(merged)) this.privateTrees.add(merged);
      _set(this.workingCopy, path, merged);
      _set(this.updatePatch, path, deepSmartMerge(_get(this.updatePatch, path) ?? {}, value));
      if (shouldRedact) {
        this.redactedPaths.add(key);
      }
      this.stage(path, key, 'merge');
      succeeded = true;
    } finally {
      source?.endMutation(succeeded);
    }
  }

  /**
   * Field-level redaction (9.19.0): mark dot-paths INSIDE the value staged at
   * `path` as secret, so `scrubPatch` scrubs them in the commit log and the
   * mirror the same way a whole-key redaction is scrubbed. A field is
   * registered as a literal key AND, when dotted, as the nested path it
   * names — whichever exists in the patch is the one `scrubPatch` finds.
   * Marked paths survive commit only while the op path they sit under does
   * (see {@link survivingRedactedPaths}).
   */
  markRedactedFields(path: (string | number)[], fields: readonly string[]): void {
    if (fields.length) this.sourceStaging?.redact(path);
    for (const field of fields) {
      this.redactedPaths.add(normalisePath([...path, field]));
      if (field.includes('.')) this.redactedPaths.add(normalisePath([...path, ...field.split('.')]));
    }
  }

  /**
   * Read current value at path (includes uncommitted changes). The value is
   * the stage's own — private to it, as the whole-state clone made every read
   * after the first write before 9.29.0 (`privatise`).
   */
  get(path: (string | number)[], defaultValue?: any, observation?: NativeReadObservation) {
    this.privatise(path);
    return _get(this.workingCopy, path, defaultValue, observation);
  }

  /**
   * Read the working copy at `path` WITHOUT taking a private copy — for a
   * reader that only compares (the dev-mode borrowed-mutation report in
   * `StageContext.commit`), never for a value handed to a stage.
   */
  peek(path: (string | number)[]): unknown {
    return _get(this.workingCopy, path);
  }

  /**
   * Keep the diff base exact under a read the working copy cannot answer.
   *
   * Only an unresolved path not covered by a staged hard set/delete may
   * fall back to LIVE state. Its returned container can also be held in
   * the diff base. A borrowed in-place edit would then move that base and
   * make a later write-back appear unchanged. Replace the base's value at
   * `path` with a private deep copy before the live value goes out, copying
   * its root and ancestors shallowly. The net-change test and delta replay
   * use that private base, as the old whole-state clone did. The returned
   * value remains live, preserving the existing borrowed-read behavior.
   *
   * Not `privatise`: returning a private copy would also keep the edit out
   * of live state. A namespace read falling back to a global key retains
   * the existing borrowed-reference behavior.
   *
   * Copies nothing when the base holds no container at `path`, and nothing
   * twice: a path at or below an earlier detach is already private. O(path)
   * otherwise, plus O(value) once per detached path.
   */
  detachBase(path: (string | number)[]): void {
    if (path.length === 0 || !isContainer(this.baseSnapshot)) return;
    let at: object = this.baseSnapshot;
    for (const k of path) {
      if (this.detachedBase?.has(at)) return;
      const child = ownChild(at, k);
      if (!isContainer(child)) return;
      at = child;
    }
    if (this.detachedBase?.has(at)) return;
    const owned = (this.baseOwned ??= new WeakSet<object>());
    if (!owned.has(this.baseSnapshot)) this.baseSnapshot = ownedRootOf(this.baseSnapshot, owned);
    ownSpine(this.baseSnapshot, path, owned);
    const copy: object = structuredClone(at);
    (this.detachedBase ??= new WeakSet<object>()).add(copy);
    _set(this.baseSnapshot, path, copy);
  }

  /**
   * Private reads (9.29.0): make the value at `path` the stage's own before
   * a read hands it out — so a read after the stage's first write behaves
   * exactly as it did when the buffer began with a deep clone of the whole
   * state. An in-place edit of what the read returned (out of contract —
   * reads are borrowed) stays inside the buffer, and committed state is never
   * touched. Whether the RECORD keeps it is the admitted record's law
   * (9.30.0, owner ruling R1 — the record keeps what the stage read back): it
   * is kept when the edited value lies at or below a path the stage wrote in
   * this stage — set, merged or written back alike — and lost otherwise.
   *
   * Walking the path from the (owned) root:
   *  - a container still SHARED with committed state at the same position is
   *    replaced by a private deep copy when it is the value read, or by a
   *    shallow copy when it is a container on the way to it (so a read of
   *    `k` under a fork child's address copies `k`, not every child's namespace);
   *  - a container the stage STAGED (or anything else the buffer did not
   *    take from committed state) is handed back by reference, as before;
   *  - a container the buffer owns is walked on — and when it is the value
   *    read, its still-shared descendants are privatised
   *    ({@link privatiseBelow}).
   *
   * Cost: O(path) per read, plus O(value) ONCE per shared container a stage
   * reads after its first write. A stage that never reads after writing pays
   * nothing; a read before the first write never reaches the buffer.
   */
  private privatise(path: (string | number)[]): void {
    if (path.length === 0) return;
    // Resolve first: a read that lands on nothing (a missing key, a refused
    // segment, a primitive) returns nothing and must copy nothing.
    const chain: object[] = [];
    let at: unknown = this.workingCopy;
    for (const k of path) {
      at = ownChild(at, k);
      if (!isContainer(at)) return;
      chain.push(at);
    }
    let parent: any = this.workingCopy;
    let base: unknown = this.baseSnapshot;
    for (let i = 0; i < path.length; i++) {
      const k = path[i];
      const atBase = ownChild(base, k);
      let value = chain[i];
      if (!this.owned.has(value)) {
        if (value !== atBase || this.staged.has(value)) return;
        if (i === path.length - 1) {
          putOwn(parent, k, this.privateCopyOf(value));
          return;
        }
        value = shallowCopy(value);
        this.owned.add(value);
        putOwn(parent, k, value);
      }
      parent = value;
      base = atBase;
    }
    this.privatiseBelow(parent, base);
  }

  /**
   * An OWNED container is about to be read whole (a path copy a nested write
   * made, say): its descendants still shared with committed state are
   * replaced by private deep copies, so nothing the read hands out is
   * committed state. Walks owned containers only; marks each one finished
   * ({@link privateTrees}), so a container is scanned once per stage.
   */
  private privatiseBelow(container: object, base: unknown): void {
    const work: Array<[object, unknown]> = [[container, base]];
    while (work.length > 0) {
      const [node, nodeBase] = work.pop()!;
      if (this.privateTrees.has(node)) continue;
      for (const key of Object.keys(node)) {
        const child = ownChild(node, key);
        if (!isContainer(child)) continue;
        const atBase = ownChild(nodeBase, key);
        if (this.owned.has(child)) work.push([child, atBase]);
        else if (child === atBase && !this.staged.has(child)) {
          putOwn(node as Record<string, unknown>, key, this.privateCopyOf(child));
        }
      }
      this.privateTrees.add(node);
    }
  }

  /** A private deep copy of a committed container — owned through and through. */
  private privateCopyOf(value: object): object {
    const copy = structuredClone(value);
    adopt(copy, this.owned);
    this.privateTrees.add(copy);
    return copy;
  }

  /** Does a successful staged hard set/delete own this path or an ancestor? */
  hasHardWrite(path: (string | number)[]): boolean {
    return hardWriteCovers(this.hardWriteKeys, path);
  }

  /**
   * Did any staged op touch `path`, or a path above or below it?
   *
   * The dev-mode borrowed-read check (`StageContext.commit`) asks this before
   * accusing a stage of mutating a value in place: a key the stage legitimately
   * WROTE is expected to differ from what it read, and writes reach the buffer
   * from paths that bypass user-level write tracking too (the subflow seed,
   * `outputMapper` merge-back, the resume re-seed). Dev-mode only — nothing on
   * the hot path calls it.
   */
  wasStaged(path: (string | number)[]): boolean {
    const target = normalisePath(path);
    for (const op of this.opTrace) {
      // On the path, below it or above it — the one path relation every key query asks.
      if (relation(op.path, target) !== undefined) return true;
    }
    return false;
  }

  /**
   * Flush all staged mutations and return the commit bundle — recording the
   * stage's NET CHANGE, not its raw write log.
   *
   * ── WHY (the defect this fixes) ─────────────────────────────────────────
   * Previously every `set`/`merge` was recorded verbatim, so the commit bundle
   * was a log of *operations* rather than *changes*. Two operations produce no
   * net change yet were still committed as "mutations":
   *
   *   1. No-op write   — writing a key the value it already holds (e.g. an
   *                      agent context slot re-emitting identical content every
   *                      turn). base K=1, stage writes K=1.
   *   2. Write-revert  — changing then restoring a key within one stage.
   *                      base K=1, stage writes K=2 then K=1.
   *
   * Recording these as mutations (a) bloated causal slicing / backtracking with
   * spurious dependencies on intermediate values that never reach final state,
   * and (b) made downstream "what changed here?" consumers light up stages that
   * changed nothing — most visibly the lens highlight flagging every slot.
   *
   * ── HOW ─────────────────────────────────────────────────────────────────
   * At commit we hold BOTH `baseSnapshot` (state when the stage began) and
   * `workingCopy` (state after all its writes). For each path the stage touched
   * we keep it in the bundle ONLY if its final value differs from the base
   * value (`deepEqual`, asked by `staged.ts · changedSinceBase`). No-op AND write-revert paths drop out, because
   * both compare equal to base. This is a single net-delta diff at commit time
   * — one deep compare per touched path, O(changed state), paid once per stage
   * (NOT per write). A naive per-write deep-equal skip would be more expensive
   * and would still miss write-revert (the intermediate write differs from the
   * value present at the moment of writing).
   *
   * ── TWO HONEST TIERS (by design — do not "unify" them) ──────────────────
   *   • commit (here)   = CHANGE-level — truthful net delta. Feeds the commit
   *                       log, causal chain, narrative, and the lens highlight.
   *   • `onWrite` event = OP-level — fires on EVERY write attempt regardless of
   *                       net change. Feeds metrics / behavioural observability
   *                       (a debugger wants to see "wrote 2, then reverted").
   * `onWrite` is unchanged by this method; only the COMMIT becomes change-only.
   *
   * ── EMPTY COMMITS ARE INTENTIONAL ───────────────────────────────────────
   * A stage that nets no change commits an EMPTY patch — NOT nothing.
   * {@link StageContext.commit} still records the bundle unconditionally, so
   * every executed stage remains a time-travel cursor stop (its `runtimeStageId`
   * marker is preserved); only its PATCH is empty. This is what keeps the
   * commit-indexed slider stable while making the highlight truthful.
   *
   * ── KNOWN LIMITATIONS / FUTURE ──────────────────────────────────────────
   *   • Explicit key DELETION under the default 'full' mode is still
   *     flattened to set-of-`undefined` (a removed key cannot be expressed
   *     in MemoryPatch alone). CLOSED under `commitValues: 'delta'` (#13c-B):
   *     {@link delete} stages a distinct op and the bundle carries a real
   *     `delete` trace verb whose replay removes the key.
   *   • Array-merge dedup in {@link deepSmartMerge} still uses reference equality
   *     (`new Set`), so deep-equal *objects* in a merged array are not deduped.
   *     Orthogonal to this change; tracked separately.
   *
   * Resets the buffer to empty state after commit.
   */
  commit(): {
    overwrite: MemoryPatch;
    updates: MemoryPatch;
    redactedPaths: Set<string>;
    trace: TraceEntry[];
  } {
    const rows = this.commitValues === 'delta' ? this.toDeltaPayload() : this.toChangeOnlyPayload();
    const redactedPaths = survivingRedactedPaths(this.redactedPaths, new Set(rows.trace.map((t) => t.path)));
    // The bundle's key order is `recordCommit`'s; a direct caller keeps this same order.
    const payload = { overwrite: rows.overwrite, updates: rows.updates, redactedPaths, trace: rows.trace };

    this.overwritePatch = {};
    this.updatePatch = {};
    this.opTrace.length = 0;
    this.hardWriteKeys.clear();
    this.redactedPaths.clear();
    this.heldRefs.clear();
    this.workingCopy = {};
    this.owned = new WeakSet();
    this.owned.add(this.workingCopy);
    this.staged = new WeakSet();
    this.privateTrees = new WeakSet();
    this.stagedMerges = 0;
    this.nestedOps = 0;

    return payload;
  }

  /**
   * What the stage staged, as the encoders read it (`staged.ts · Staged`). Built once per commit, out of
   * the buffer's own objects by reference. Nothing is staged while a commit lays its rows out, so
   * the view stays true until the reset at the end of {@link commit}.
   */
  private atCommit(): Staged {
    return {
      base: this.baseSnapshot,
      final: this.workingCopy,
      overwritePatch: this.overwritePatch,
      updatePatch: this.updatePatch,
      ops: this.opTrace,
      hardWriteKeys: this.hardWriteKeys,
      redactedPaths: this.redactedPaths,
      needsFold: this.stagedMerges !== 0 || this.nestedOps !== 0,
    };
  }

  /**
   * The DEFAULT (`commitValues: 'full'`) payload: the stage's net change, one row per surviving op,
   * ADMITTED ({@link admit}). The layout is `fullRows.ts · changeOnlyRows`.
   */
  private toChangeOnlyPayload(): Rows {
    const staged = this.atCommit();
    return this.admit((lossy) => changeOnlyRows(staged, lossy));
  }

  /**
   * The delta-encoded payload (`commitValues: 'delta'`, #13c-B): one row per surviving path, its verb
   * chosen per path, ADMITTED ({@link admit}) like the 'full' payload. The layout is
   * `deltaRows.ts · deltaRows`; the values it encodes come from the one replay of the stage's 'full'
   * rows (`fullRows.ts · fullRowsValue`), taken once and shared by both layouts of an admission.
   */
  private toDeltaPayload(): Rows {
    const staged = this.atCommit();
    const fullValueAt = fullRowsValue(staged);
    return this.admit((lossy) => deltaRows(staged, lossy, fullValueAt));
  }

  // ── The admitted record (9.30.0) ───────────────────────────────────────

  /**
   * THE ADMISSION — a commit is admitted only if its bundle folds back to the
   * stage's read-your-writes view at every path the stage touched. `build`
   * lays the rows out (one encoder: `'full'` or `'delta'`); the candidate is
   * checked ({@link lossyFamilies}), and when some family's rows do not fold
   * back the rows are laid out again with those families written as what the
   * stage read (`readBack.ts · emitReadBack`) — every other family's bytes
   * exactly as the first layout made them.
   */
  private admit(build: (lossy: Lossy | undefined) => Rows): Rows {
    const candidate = build(undefined);
    const lossy = this.lossyFamilies(candidate);
    return lossy === undefined ? candidate : build(lossy);
  }

  /**
   * The families whose rows do not fold back to what the stage read —
   * `undefined` when there are none (`admission.ts · lossyFamilies`: the
   * candidate replayed onto the diff base by `dryFold`, every family of
   * touched paths compared with the working copy at its root and on the way
   * down to it).
   *
   * Without a fold, when the stage staged no `merge` and no nested op: its
   * rows are `set` / `delete` of keys directly under its address, each
   * writing the SAME value into `workingCopy` and `overwritePatch` — the
   * record is the read-back by construction (the property's ROOT-ONLY arm
   * pins this). That keeps the commit of the typed scope's root-key writes
   * exactly as cheap as it was.
   */
  private lossyFamilies(candidate: Rows): Lossy | undefined {
    if (this.stagedMerges === 0 && this.nestedOps === 0) return undefined;
    return lossyFamilies(candidate, this.baseSnapshot, this.workingCopy, this.opTrace, this.address);
  }
}
