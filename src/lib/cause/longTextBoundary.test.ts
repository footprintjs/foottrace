import fc from 'fast-check';
import { bindSourceLinkWrite } from '../../cause.js';
import { describe, expect, it } from 'vitest';
import type { RecordScope, RecordSourceLink } from '../../cause.js';
import { LOG_PLACEHOLDER } from '../memory/placeholders.js';
import { DELIM } from '../record-paths/codec.js';
import {
  adapters,
  address,
  bundle,
  context,
  exactPolicy,
  linkFor,
  reader,
  scopeFor,
  servedWrite,
  witness,
} from '../../../test/fixtures/source-links/recordHarness.js';
import type { Adapter, Encoding } from '../../../test/fixtures/source-links/recordHarness.js';

const chosen = `profile${DELIM}chosen`;
const output = { runtimeStageId: 'door', commitIdx: 1, key: 'answer' };
const origin = { runtimeStageId: 'start', commitIdx: 0, key: chosen };

function primaryScope(hiddenName: string, hidden: string, encoding: Encoding): RecordScope {
  const source = bundle(0, 'start', { profile: { chosen: 'shown', [hiddenName]: hidden } });
  const use = bundle(1, 'door', { answer: 'finished' }, [{ verb: 'set', path: 'answer', readKeys: [chosen] }]);
  const rewrite =
    encoding === 'full'
      ? bundle(2, 'update', { profile: { chosen: 'shown', [hiddenName]: hidden } })
      : bundle(2, 'update', {}, [{ verb: 'merge', path: 'profile' }], { profile: { [hiddenName]: hidden } });
  return { ...scopeFor({}, [source, use, rewrite], []), sourceLinks: undefined, reads: { door: [chosen] } };
}

async function recordPages(adapter: Adapter, scope: RecordScope) {
  const graph = reader(adapter, [scope], {});
  const after = await graph.parents(graph.nodeId(address, output), context());
  const before = await graph.children(graph.nodeId(address, origin), context());
  expect(after.edges.length).toBeGreaterThan(0);
  expect(before.edges.length).toBeGreaterThan(0);
  expect(after.sourceLinkGaps).toBeUndefined();
  expect(before.sourceLinks).toBeUndefined();
  return [after, before];
}

const hiddenPlaces = ['sibling', 'list entry', 'another key', 'copied root'] as const;

function linkScope(hidden: string, encoding: Encoding, place: (typeof hiddenPlaces)[number] = 'sibling') {
  const input = { key: 'profile', pointer: '/chosen' };
  const door = { commitIdx: 2, runtimeStageId: 'door' };
  const row = witness(input, { key: 'answer', checkedIn: 'written' });
  const link = linkFor(row, door, { ...door, key: 'evidence', element: 0 });
  const profile =
    place === 'sibling'
      ? { hidden }
      : place === 'list entry'
      ? { items: ['stable', hidden] }
      : place === 'copied root'
      ? { detail: { payload: { body: hidden } } }
      : {};
  const keep = place === 'another key' ? { scratch: hidden } : {};
  const update =
    place === 'another key' || encoding === 'full'
      ? bundle(1, 'update', { profile: { chosen: 'shown', ...profile }, ...keep })
      : bundle(1, 'update', {}, [{ path: 'profile', verb: 'merge' }], { profile });
  const log = [
    servedWrite(0, [{ key: 'profile' }]),
    update,
    bundle(2, 'door', { answer: 'finished', evidence: [row] }),
  ];
  return { scope: scopeFor({ profile: { chosen: 'shown', hidden: 'before' } }, log, [link]), link };
}

async function linkedPage(adapter: Adapter, fixture: ReturnType<typeof linkScope>) {
  const { scope, link } = fixture;
  const graph = reader(adapter, [scope], { sourceLinkPolicy: exactPolicy(address, link) });
  return graph.parents(graph.nodeId(address, link.output), context());
}

function baseScope(text: string): { scope: RecordScope; link: RecordSourceLink } {
  const fixture = linkScope('short', 'delta');
  return { ...fixture, scope: { ...fixture.scope, initialState: { profile: { chosen: 'shown', hidden: text } } } };
}

describe.each(adapters)('long record text in %s', (adapter) => {
  it.each(['full', 'delta'] as const)(
    'keeps byte-identical source-link pages for hidden %s commit text',
    async (encoding) => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...hiddenPlaces),
          fc.integer({ min: 65_537, max: 120_000 }),
          fc.constantFrom('x', `${LOG_PLACEHOLDER}\n\u2028`),
          async (place, size, motif) => {
            const first = linkScope(motif, encoding, place);
            const second = linkScope(motif.repeat(Math.ceil(size / motif.length)).slice(0, size), encoding, place);
            const short = await linkedPage(adapter, first);
            expect(short.sourceLinks?.[0]?.standing).toBe('witnessed');
            expect(JSON.stringify(await linkedPage(adapter, second))).toBe(JSON.stringify(short));
            for (const { scope, link } of [first, second]) {
              expect(bindSourceLinkWrite(scope, link.witness)).toEqual({
                commitIdx: link.output.commitIdx,
                runtimeStageId: link.output.runtimeStageId,
              });
            }
          },
        ),
        { seed: 20261120, numRuns: 64 },
      );
    },
  );

  it('keeps an earlier source link when later commits change only text on the same path', async () => {
    const fixture = linkScope('short', 'full');
    const extra = (text: string) => ({
      ...fixture,
      scope: {
        ...fixture.scope,
        commitLog: [
          ...fixture.scope.commitLog,
          bundle(3, 'after', { profile: { chosen: text, hidden: 'same' } }),
          bundle(4, 'later', { profile: { chosen: text, hidden: 'another change' } }),
        ],
      },
    });
    const first = await linkedPage(adapter, extra('later'));
    expect(first.sourceLinks?.[0].standing).toBe('witnessed');
    expect(JSON.stringify(await linkedPage(adapter, extra('x'.repeat(100_000))))).toBe(JSON.stringify(first));
  });

  it('bases the truncation threshold only on selected text', async () => {
    const length = 512;
    const selected = 's'.repeat(length);
    const control = async (hidden: string, maxFields: number) => {
      const first = bundle(0, 'start', { profile: { chosen: selected, hidden } });
      const second = bundle(1, 'rewrite', { profile: { chosen: selected, hidden: 'replacement' } });
      const scope = { ...scopeFor({}, [first, second], []), sourceLinks: undefined };
      const graph = reader(adapter, [scope], { maxFields });
      const node = graph.nodeId(address, origin);
      return { page: await graph.children(node, context()), gaps: await graph.gaps(node, context()) };
    };
    for (const limit of [length - 1, length + 1]) {
      const short = await control('short', limit);
      const long = await control('x'.repeat(100_000), limit);
      expect(JSON.stringify(long)).toBe(JSON.stringify(short));
      if (limit < length) {
        expect(short.page).toEqual({
          edges: [],
          complete: false,
          gaps: [{ code: 'truncated', evidence: [] }],
        });
      } else {
        expect(short.page.gaps).toBeUndefined();
        expect(short.page.edges).toEqual([]);
      }
    }
  });

  it('keeps the pinned nested view independent of text outside the granted pointer', async () => {
    const input = { key: `outer${DELIM}profile`, pointer: '/chosen' };
    const door = { runtimeStageId: 'door', commitIdx: 2 };
    const row = witness(input, { key: 'answer', checkedIn: 'written' });
    const link = linkFor(row, door, { ...door, key: 'evidence', element: 0 });
    const text = 'x'.repeat(100_000);
    const log = [
      bundle(0, 'crossing', { outer: { profile: { chosen: 'shown', hidden: text } } }),
      { ...servedWrite(1, [{ key: input.key }]), beganAt: 0, sawUntil: 1 },
      bundle(2, 'door', { answer: 'finished', evidence: [row] }),
    ];
    const read = (hidden: string) =>
      linkedPage(adapter, {
        link,
        scope: scopeFor({ outer: { profile: { chosen: 'shown', hidden } } }, log, [link]),
      });
    const shorter = await read('brief');
    const identical = await read(text);
    expect(JSON.stringify(identical), 'hidden sibling in a nested tracked read').toBe(JSON.stringify(shorter));
  });

  it('opens a long base without a source-link policy', async () => {
    const check = async (size: number) => {
      const { scope, link } = baseScope('x'.repeat(size));
      const graph = reader(adapter, [scope], {});
      return graph.parents(graph.nodeId(address, link.output), context());
    };
    const short = await check(65_536);
    expect(short.sourceLinkGaps?.map(({ code }) => code)).toEqual(['not-permitted']);
    expect(JSON.stringify(await check(65_537))).toBe(JSON.stringify(short));
  });

  it.each(['full', 'delta'] as const)(
    'keeps policy-free %s pages equal when text outside the queried key changes',
    async (encoding) => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('comment', 'response', 'title', 'payload'),
          fc.string({ minLength: 1, maxLength: 16 }),
          fc.integer({ min: 65_537, max: 120_000 }),
          async (name, motif, size) => {
            const short = await recordPages(adapter, primaryScope(name, motif, encoding));
            const long = await recordPages(
              adapter,
              primaryScope(name, motif.repeat(Math.ceil(size / motif.length)).slice(0, size), encoding),
            );
            expect(JSON.stringify(long)).toBe(JSON.stringify(short));
          },
        ),
        { seed: 20261120, numRuns: 128 },
      );
    },
  );
});
