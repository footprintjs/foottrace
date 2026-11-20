import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bindSourceLinkWrite } from '../../../cause.js';
import {
  adapters,
  address,
  bundle,
  encodings,
  exactPolicy,
  linkFor,
  parents,
  scopeFor,
  servedWrite,
  witness,
} from '../../../../test/fixtures/source-links/recordHarness.js';
import type { Encoding } from '../../../../test/fixtures/source-links/recordHarness.js';
import {
  inputWindowPair,
  outputWindowPair,
  placements,
  relations,
  type WindowRecipe,
} from '../../../../test/fixtures/source-links/windowPairs.js';
import type { CommitBundle, TraceEntry } from '../../memory/types.js';
import { DELIM } from '../../record-paths/codec.js';

const hiddenCases = ['sibling', 'entry', 'long base text', 'number', 'name'] as const;
const unionRoles = ['input', 'output', 'witness'] as const;
const cases = [...hiddenCases, ...unionRoles] as const;
const selections = ['pointer', 'element', 'nested position', 'whole key'] as const;
type Scenario = (typeof cases)[number];
type Recipe = {
  scenario: Scenario;
  selection: (typeof selections)[number];
  text: string;
  number: number;
  suffix: number[];
  mergeBeside: boolean;
};

const recipes = fc.record({
  scenario: fc.constantFrom(...cases),
  selection: fc.constantFrom(...selections),
  text: fc.string({ minLength: 1, maxLength: 16 }),
  number: fc.integer({ min: -50, max: 50 }),
  mergeBeside: fc.boolean(),
  suffix: fc.array(fc.integer({ min: 0, max: 20 }), { maxLength: 3 }),
});

type Write = (idx: number, recipe: Recipe, encoding: Encoding, list: readonly unknown[]) => CommitBundle;
// Delta exercises every trace verb. Full represents append and nested delete as overwrites.
const writeCases = {
  set: (idx, recipe) => bundle(idx, 'set', { scratch: { obsolete: true, rows: recipe.suffix } }),
  append: (idx, _, encoding, list) =>
    encoding === 'delta'
      ? bundle(idx, 'append', { auxiliary: ['new'] }, [{ path: 'auxiliary', verb: 'append' }])
      : bundle(idx, 'append', { auxiliary: [...list, 'new'] }),
  merge: (idx, recipe) =>
    bundle(idx, 'merge', {}, [{ path: 'scratch', verb: 'merge' }], { scratch: { name: recipe.text } }),
  delete: (idx, recipe, encoding) => {
    const path = `scratch${DELIM}obsolete`;
    return encoding === 'delta'
      ? bundle(idx, 'delete', { scratch: { obsolete: undefined } }, [{ path, verb: 'delete' }])
      : bundle(idx, 'delete', { scratch: { rows: recipe.suffix, name: recipe.text } });
  },
} satisfies Record<TraceEntry['verb'], Write>;
const writes: readonly Write[] = Object.values(writeCases);

const value = (recipe: Recipe, twin: boolean): string => (twin ? `${recipe.text}!` : recipe.text);

function materialize(recipe: Recipe, encoding: Encoding, twin: boolean) {
  const { scenario } = recipe;
  const selected = { answer: 'retained input' };
  const texts = [scenario === 'entry' ? value(recipe, twin) : 'hidden', 'second', selected];
  const profile = {
    selected: { ...selected },
    items: structuredClone(texts),
    note: scenario === 'long base text' && twin ? 'x'.repeat(100_000) : recipe.text,
    number: scenario === 'number' && twin ? recipe.number + 1 : recipe.number,
    metadata: { name: scenario === 'name' ? value(recipe, twin) : 'same' },
  };
  const auxiliary = [...recipe.suffix];
  const initialState: Record<string, unknown> = { auxiliary, profile, history: texts, plain: { ...selected } };
  const input =
    scenario === 'input' || recipe.selection === 'element'
      ? { key: 'history', element: 2 }
      : recipe.selection === 'nested position'
      ? { key: 'profile', pointer: '/items/2/answer' }
      : recipe.selection === 'whole key'
      ? { key: 'plain' }
      : { key: 'profile', pointer: '/selected' };
  const output = { key: 'answer', checkedIn: 'written' as const, ...(scenario === 'output' ? { element: 2 } : {}) };
  const row = witness(input, output);
  const log = writes.map((write, i) => write(i, recipe, encoding, auxiliary));
  if (scenario === 'entry') {
    // Only the ungranted slot of the container holding an addressed item changes.
    if (input.key === 'history') initialState.profile = { ...profile, items: ['other', 'second', { ...selected }] };
    else initialState.history = ['other', 'second', selected];
  }
  if (scenario === 'sibling') {
    // Put this difference in one committed payload and keep its trace identical.
    const note = value(recipe, twin);
    const path = `profile${DELIM}note`;
    log.push(
      encoding === 'full'
        ? bundle(log.length, 'sibling', { profile: { ...profile, note } })
        : bundle(log.length, 'sibling', { profile: { note } }, [{ path, verb: 'set' }]),
    );
  }
  log.push(
    servedWrite(log.length, [{ key: input.key, ...(input.element === undefined ? {} : { elements: [[0, 3]] }) }]),
  );
  if (recipe.mergeBeside) {
    log.push(
      bundle(log.length, 'merge-beside', {}, [{ path: 'profile', verb: 'merge' }], {
        profile: { counter: recipe.number },
      }),
    );
  }
  const union = (
    key: string,
    tail: readonly unknown[],
    overwrite: CommitBundle['overwrite'],
    idx: number,
    stage: string,
  ) =>
    bundle(
      idx,
      stage,
      overwrite,
      [
        ...Object.keys(overwrite)
          .filter((path) => path !== key)
          .map((path): TraceEntry => ({ path, verb: 'set' })),
        { path: key, verb: 'merge' },
      ],
      { [key]: tail },
    );
  if (scenario === 'input') {
    initialState.history = [twin ? 'second' : 'first', 'second', selected];
    log.push(union('history', ['second'], {}, log.length, 'between'));
  }
  const door = { runtimeStageId: 'door', commitIdx: log.length };
  const link = linkFor(row, door, { ...door, key: 'evidence', element: scenario === 'witness' ? 2 : 0 });
  if (scenario === 'output') {
    initialState.answer = [twin ? 'second' : 'first', 'second'];
    log.push(union('answer', ['second', 'cited answer'], { evidence: [row] }, door.commitIdx, door.runtimeStageId));
  } else if (scenario === 'witness') {
    initialState.evidence = [twin ? 'second' : 'first', 'second'];
    log.push(union('evidence', ['second', row], { answer: 'cited answer' }, door.commitIdx, door.runtimeStageId));
  } else {
    log.push(bundle(door.commitIdx, door.runtimeStageId, { answer: 'cited answer', evidence: [row] }));
  }
  return { scope: scopeFor(initialState, log, [link]), link };
}

async function checkPair(recipe: Recipe, encoding: Encoding) {
  const one = materialize(recipe, encoding, false);
  const two = materialize(recipe, encoding, true);
  if (recipe.scenario === 'output' || recipe.scenario === 'long base text') {
    const first = bindSourceLinkWrite(one.scope, one.link.witness);
    const second = bindSourceLinkWrite(two.scope, two.link.witness);
    expect(second, 'public binding twin').toEqual(first);
    expect(first).toEqual(
      recipe.scenario === 'output'
        ? undefined
        : {
            runtimeStageId: one.link.output.runtimeStageId,
            commitIdx: one.link.output.commitIdx,
          },
    );
  }
  const options = { sourceLinkPolicy: exactPolicy(address, one.link) };
  for (const adapter of adapters) {
    const first = await parents(adapter, one.scope, one.link.output, options);
    const second = await parents(adapter, two.scope, two.link.output, options);
    // On failure fast-check prints this compact recipe and its seed/path. Avoid dumping reconstructed long text.
    expect(JSON.stringify(second), `${adapter} twin`).toBe(JSON.stringify(first));
    if (recipe.scenario === 'input' || recipe.scenario === 'output') {
      expect(first.sourceLinks).toBeUndefined();
      expect(first.sourceLinkGaps?.map(({ code }) => code)).toEqual(['ambiguous']);
    } else {
      expect(first.sourceLinks?.map(({ standing }) => standing)).toEqual([
        recipe.scenario === 'witness' ? 'declared' : 'witnessed',
      ]);
      expect(first.sourceLinkGaps?.map(({ code }) => code)).toEqual(['unavailable']);
    }
  }
}

const fixedSeed = 20261120;
const explorationSeed = process.env.FOOTTRACE_PAIR_EXPLORATION_SEED;
const seed = explorationSeed === undefined ? fixedSeed : Number(explorationSeed);

describe.each(encodings)('%s source-link paired records', (encoding) => {
  it.each(cases)('keeps a deterministic %s pair', async (scenario) => {
    await checkPair(
      { scenario, selection: 'pointer', text: 'sample', number: 1, suffix: [], mergeBeside: false },
      encoding,
    );
  });

  it('returns the same complete pages when only an ungranted value changes', async () => {
    expect(Number.isSafeInteger(seed)).toBe(true);
    if (explorationSeed !== undefined) console.log(`Source-link ${encoding} exploration seed ${seed}`);
    await fc.assert(
      fc.asyncProperty(recipes, (recipe) => checkPair(recipe, encoding)),
      {
        seed,
        numRuns: 512,
        ...(process.env.FOOTTRACE_PAIR_PATH === undefined ? {} : { path: process.env.FOOTTRACE_PAIR_PATH }),
      },
    );
  }, 30_000);
});

const overlapVerbs = ['set', 'append', 'merge', 'delete'] as const satisfies readonly TraceEntry['verb'][];
const windowRecipes = fc.record({
  placement: fc.constantFrom(...placements),
  relation: fc.constantFrom(...relations),
  hidden: fc.string({ maxLength: 16 }),
});
const overlap = (recipe: WindowRecipe) => recipe.placement === 'window' && recipe.relation !== 'beside';

async function checkInputWindow(recipe: WindowRecipe, encoding: Encoding) {
  for (const adapter of adapters) {
    const [first, second] = await inputWindowPair(recipe, encoding, adapter);
    expect(JSON.stringify(second), `${adapter} input window twin`).toBe(JSON.stringify(first));
    expect(first.sourceLinks?.map(({ standing }) => standing)).toEqual(overlap(recipe) ? undefined : ['witnessed']);
    expect(first.sourceLinkGaps?.map(({ code }) => code)).toEqual([overlap(recipe) ? 'ambiguous' : 'unavailable']);
  }
}

function checkOutputWindow(recipe: WindowRecipe, encoding: Encoding) {
  const [first, second] = outputWindowPair(recipe, encoding);
  expect(second.binding, 'read-checked output window twin').toEqual(first.binding);
  expect(first.binding).toEqual(overlap(recipe) ? undefined : first.checkedWrite);
}

describe.each(encodings)('%s tracked nested windows', (encoding) => {
  it.each(overlapVerbs)('uses the path of an above-key %s for both window checks', async (verb) => {
    const recipe = { placement: 'window', relation: 'above', hidden: 'sample', verb } as const;
    await checkInputWindow(recipe, encoding);
    checkOutputWindow(recipe, encoding);
  });

  it('classifies input by row placement and relation to the tracked key', async () => {
    await fc.assert(
      fc.asyncProperty(windowRecipes, (recipe) => checkInputWindow(recipe, encoding)),
      {
        seed,
        numRuns: 256,
      },
    );
  }, 30_000);

  it('binds read-checked output by row placement and relation to the tracked key', () => {
    fc.assert(
      fc.property(windowRecipes, (recipe) => checkOutputWindow(recipe, encoding)),
      { seed, numRuns: 256 },
    );
  });
});
