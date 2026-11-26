import type { JsonValue } from '../../canonical-json/types.js';
import { recordName, RecordRefusal, recordRefusalCode, spend } from '../../evidence/recordData.js';
import { isDeniedSegment } from '../../memory/pathOps.js';
import { pathSegments } from '../../record-paths/codec.js';
import { text } from '../../run-evidence/fields.js';
import { RUN_EVIDENCE_LIMITS } from '../../run-evidence/kinds.js';
import type { NormalizedChoice, NormalizedControl, NormalizedSkippedStage, SkippedWork } from './types.js';

export interface NormalizedSkippedChart {
  readonly stages: ReadonlyMap<string, NormalizedSkippedStage>;
  readonly controlsByStage: ReadonlyMap<string, readonly NormalizedControl[]>;
}

type Fields = Record<string, JsonValue | undefined>;

function field(value: object, key: string): JsonValue {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new RecordRefusal();
  return descriptor.value;
}

/** canonicalSnapshot owns the input; projection admission still requires exact data fields. */
function object(
  value: unknown,
  required: readonly string[],
  budget: SkippedWork,
  optional: readonly string[] = [],
): Fields {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== null || !Object.isFrozen(value))
    throw new RecordRefusal();
  const keys = Reflect.ownKeys(value);
  spend(budget, keys.length + 1);
  if (required.some((key) => !keys.includes(key))) throw new RecordRefusal();
  const copy = Object.create(null) as Fields;
  for (const key of keys) {
    if (typeof key !== 'string' || (!required.includes(key) && !optional.includes(key))) throw new RecordRefusal();
    copy[key] = field(value, key);
  }
  return copy;
}

function list<T>(value: unknown, budget: SkippedWork, read: (item: JsonValue) => T): readonly T[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || !Object.isFrozen(value))
    throw new RecordRefusal();
  const length: unknown = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) throw new RecordRefusal();
  spend(budget, length + 1);
  if (Reflect.ownKeys(value).length !== length + 1) throw new RecordRefusal();
  const result: T[] = [];
  for (let index = 0; index < length; index++) result.push(read(field(value, String(index))));
  return Object.freeze(result);
}

function stageOf(value: JsonValue, budget: SkippedWork): NormalizedSkippedStage {
  const { id, stageId, role, edges, writes } = object(value, ['id', 'stageId', 'role', 'edges'], budget, ['writes']);
  if (role !== 'stage' && role !== 'mount' && role !== 'loop-reference' && role !== 'join') throw new RecordRefusal();
  const writePaths =
    writes === undefined
      ? undefined
      : list(writes, budget, (raw) => {
          const path = recordName(raw, true);
          if (pathSegments(path).some(isDeniedSegment)) throw new RecordRefusal();
          return path;
        });
  return Object.freeze({
    id: recordName(id),
    stageId: recordName(stageId),
    role,
    edges: list(edges, budget, recordName),
    ...(writePaths !== undefined && { writes: writePaths }),
  });
}

function choiceOf(value: JsonValue, budget: SkippedWork): NormalizedChoice {
  const { entry, name: label, fallback, loopBack } = object(value, ['entry', 'name'], budget, ['fallback', 'loopBack']);
  if (fallback !== undefined && fallback !== true) throw new RecordRefusal();
  let loop: NormalizedChoice['loopBack'];
  if (loopBack !== undefined) {
    const { body, exit, owner } = object(loopBack, ['body', 'exit', 'owner'], budget);
    loop = Object.freeze({ body: recordName(body), exit: recordName(exit), owner: recordName(owner) });
  }
  return Object.freeze({
    entry: recordName(entry),
    name: text(label, RUN_EVIDENCE_LIMITS.text),
    ...(fallback && { fallback }),
    ...(loop && { loopBack: loop }),
  });
}

function controlOf(value: JsonValue, budget: SkippedWork): NormalizedControl {
  const { placementId, kind, choices, continuation } = object(
    value,
    ['placementId', 'kind', 'choices', 'continuation'],
    budget,
  );
  if (kind !== 'decider' && kind !== 'selector') throw new RecordRefusal();
  return Object.freeze({
    placementId: recordName(placementId),
    kind,
    choices: list(choices, budget, (choice) => choiceOf(choice, budget)),
    continuation: continuation === null ? null : recordName(continuation),
  });
}

function admitChoices(
  stage: NormalizedSkippedStage,
  control: NormalizedControl,
  stages: ReadonlyMap<string, NormalizedSkippedStage>,
  budget: SkippedWork,
): void {
  const { continuation } = control;
  if (continuation !== null) {
    spend(budget, 1);
    if (continuation === stage.id || !stages.has(continuation)) throw new RecordRefusal();
  }
  spend(budget, stage.edges.length);
  const direct = new Set(stage.edges);
  const choices = new Map<string, NormalizedChoice>();
  let hasFallback = false;
  for (const choice of control.choices) {
    spend(budget, 1);
    if (choice.entry === stage.id || choices.has(choice.entry) || !direct.has(choice.entry)) throw new RecordRefusal();
    if (choice.fallback) {
      if (hasFallback || control.kind !== 'decider') throw new RecordRefusal();
      hasFallback = true;
    }
    choices.set(choice.entry, choice);
  }
  for (const edge of direct) {
    spend(budget, 1);
    if (edge !== continuation && !choices.has(edge)) throw new RecordRefusal();
  }
  for (const choice of choices.values()) {
    spend(budget, 1);
    const loop = choice.loopBack;
    if (!loop) {
      if (stages.get(choice.entry)?.role === 'loop-reference') throw new RecordRefusal();
      continue;
    }
    spend(budget, 3);
    const exit = choices.get(loop.exit);
    if (
      !stages.has(loop.body) ||
      !stages.has(loop.owner) ||
      !exit ||
      exit === choice ||
      loop.body === loop.exit ||
      exit.loopBack ||
      stages.get(exit.entry)?.role === 'loop-reference'
    )
      throw new RecordRefusal();
  }
}

/** Admit the captured description before any decision can use it as a graph. */
export function normalizeSkippedChart(
  graph: JsonValue,
  budget: SkippedWork,
): NormalizedSkippedChart | 'graph-ambiguous' | 'truncated' {
  try {
    const raw = object(graph, ['stages', 'controls'], budget);
    const stages = new Map<string, NormalizedSkippedStage>();
    for (const stage of list(raw.stages, budget, (value) => stageOf(value, budget))) {
      if (stages.has(stage.id)) throw new RecordRefusal();
      stages.set(stage.id, stage);
    }
    for (const stage of stages.values()) {
      for (const edge of stage.edges) {
        spend(budget, 1);
        if (!stages.has(edge)) throw new RecordRefusal();
      }
    }

    const controlsByStage = new Map<string, NormalizedControl[]>();
    const placements = new Set<string>();
    for (const control of list(raw.controls, budget, (value) => controlOf(value, budget))) {
      const stage = stages.get(control.placementId);
      if (stage?.role !== 'stage' || placements.has(stage.id)) throw new RecordRefusal();
      placements.add(stage.id);
      admitChoices(stage, control, stages, budget);
      const sameStage = controlsByStage.get(stage.stageId);
      if (sameStage) sameStage.push(control);
      else controlsByStage.set(stage.stageId, [control]);
    }
    for (const controls of controlsByStage.values()) Object.freeze(controls);
    return Object.freeze({ stages, controlsByStage });
  } catch (error) {
    return recordRefusalCode(error) === 'node-limit' ? 'truncated' : 'graph-ambiguous';
  }
}
