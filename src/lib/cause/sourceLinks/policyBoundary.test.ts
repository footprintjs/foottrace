import { describe, expect, it, vi } from 'vitest';
import type { SourceLinkLocator, SourceLinkPolicy } from '../../../cause.js';
import {
  adapters,
  address,
  bundle,
  context,
  encodings,
  exactPolicy,
  linkFor,
  parents,
  reader,
  scopeFor,
  servedWrite,
  witness,
} from '../../../../test/fixtures/source-links/recordHarness.js';
import type { Encoding } from '../../../../test/fixtures/source-links/recordHarness.js';
import { resolveLink } from './resolve.js';

function record(encoding: Encoding, scopeAddress = address) {
  const input = { key: 'history', element: 1 };
  const output = { key: 'answer', checkedIn: 'written' as const };
  const door = { runtimeStageId: 'door', commitIdx: 3 };
  const row = witness(input, output);
  const link = linkFor(row, door, { ...door, key: 'evidence', element: 0 });
  const log = [
    bundle(0, 'first', { history: ['first', 'retained'] }),
    servedWrite(1, [{ key: input.key, elements: [[0, 2]] }]),
    encoding === 'delta'
      ? bundle(2, 'tail', { history: ['third'] }, [{ path: 'history', verb: 'append' }])
      : bundle(2, 'tail', { history: ['first', 'retained', 'third'] }),
    bundle(3, 'door', { answer: 'cited result', evidence: [row] }),
  ];
  return { scope: scopeFor({}, log, [link], scopeAddress), link };
}

const roles = ['output', 'witness', 'served', 'view', 'origin'] as const;
type Role = (typeof roles)[number];
function roleOf(locator: SourceLinkLocator): Role {
  if (locator.at === 'view') return 'view';
  if (locator.key === 'answer') return 'output';
  if (locator.key === 'evidence') return 'witness';
  if (locator.key === 'served') return 'served';
  if (locator.key === 'history') return 'origin';
  throw new Error(`Unexpected grant ${locator.key}`);
}

const responses = ['throw', 'allow then deny', 'deny then allow'] as const;
const allowAll = () => true;

describe.each(encodings)('host policies on %s records', (encoding) => {
  const { scope, link } = record(encoding);

  it.each(roles)('withholds a refused %s on either adapter', async (denied) => {
    for (const response of responses) {
      for (const adapter of adapters) {
        let calls = 0;
        const sourceLinkPolicy: SourceLinkPolicy = (locator) => {
          if (roleOf(locator) !== denied) return true;
          if (response === 'throw') throw new Error('host failed');
          return response === 'allow then deny' ? calls++ === 0 : calls++ !== 0;
        };
        const page = await parents(adapter, scope, link.output, { sourceLinkPolicy });
        if (denied === 'origin') {
          expect(page.sourceLinks?.map(({ standing, input }) => [standing, input.origin])).toEqual([
            ['witnessed', undefined],
          ]);
          expect(page.sourceLinkGaps?.map(({ code }) => code)).toEqual(['unavailable']);
        } else {
          expect(page.sourceLinks).toBeUndefined();
          expect(page.sourceLinkGaps?.map(({ code }) => code)).toEqual(['not-permitted']);
          if (denied === 'output') expect(page.sourceLinkGaps?.[0].output).toBeUndefined();
        }
      }
    }
  });

  it.each(adapters)(
    'keeps its own locator when %s host tries to edit, replace, delete or add fields',
    async (adapter) => {
      const granted = exactPolicy(scope.address, link);
      const baseline = await parents(adapter, scope, link.output, { sourceLinkPolicy: granted });
      expect(baseline.sourceLinks?.[0].standing).toBe('witnessed');
      const saw = new Set<Role>();
      const page = await parents(adapter, scope, link.output, {
        sourceLinkPolicy(locator, query) {
          saw.add(roleOf(locator));
          Reflect.set(locator, 'key', 'overwritten');
          Reflect.set(locator, 'address', { logRunId: 'replacement', drillPath: [] });
          Reflect.set(locator.address.drillPath, 0, 'foreign-scope');
          Reflect.deleteProperty(locator, 'element');
          Reflect.defineProperty(locator, 'extra', { value: true });
          return granted(locator, query);
        },
      });
      expect(JSON.stringify(page)).toBe(JSON.stringify(baseline));
      expect([...saw].sort()).toEqual([...roles].sort());
    },
  );

  it.each(adapters)('isolates identical locators in a root and child scope in %s', async (adapter) => {
    const child = record(encoding, { ...address, drillPath: ['child#1'] });
    for (const [granted, denied] of [
      [{ scope, link }, child],
      [child, { scope, link }],
    ] as const) {
      const graph = reader(adapter, [scope, child.scope], {
        sourceLinkPolicy: exactPolicy(granted.scope.address, granted.link),
      });
      const accepted = await graph.parents(graph.nodeId(granted.scope.address, granted.link.output), context());
      const withheld = await graph.parents(graph.nodeId(denied.scope.address, denied.link.output), context());
      expect(accepted.sourceLinks?.[0].standing).toBe('witnessed');
      expect(withheld.sourceLinks).toBeUndefined();
      expect(withheld.sourceLinkGaps).toEqual([{ code: 'not-permitted' }]);
      const cancelled = new AbortController();
      cancelled.abort();
      const stopped = await graph.parents(graph.nodeId(granted.scope.address, granted.link.output), {
        signal: cancelled.signal,
      });
      expect(stopped.sourceLinks).toBeUndefined();
    }
  });

  it.each(adapters)('returns matching normal relations with and without policy in %s', async (adapter) => {
    const noPolicy = await parents(adapter, scope, link.output, {});
    const open = await parents(adapter, scope, link.output, { sourceLinkPolicy: allowAll });
    const closedGraph = reader(adapter, [scope], {});
    const openGraph = reader(adapter, [scope], { sourceLinkPolicy: allowAll });
    const origin = { runtimeStageId: 'first', commitIdx: 0, key: 'history' };
    const closedChildren = await closedGraph.children(closedGraph.nodeId(scope.address, origin), context());
    const openChildren = await openGraph.children(openGraph.nodeId(scope.address, origin), context());
    expect(closedChildren.sourceLinks).toBeUndefined();
    expect(openChildren.sourceLinks?.[0].standing).toBe('witnessed');
    expect(openChildren.edges).toEqual(closedChildren.edges);
    expect(noPolicy.sourceLinkGaps).toEqual([{ code: 'not-permitted' }]);
    expect(open.sourceLinks?.[0].input.origin?.write).toMatchObject(origin);
    expect(noPolicy.edges).toEqual(open.edges);
  });
});

it.each(['output', 'witness', 'served', 'view'] as const)(
  'does not enter the replay if the %s grant is absent',
  (denied) => {
    const { link } = record('delta');
    const replay = vi.fn(() => undefined);
    const policy: SourceLinkPolicy = (locator) => roleOf(locator) !== denied;
    expect(resolveLink(link, address, context(), policy, ({ key }) => key, replay).gaps[0].code).toBe('not-permitted');
    expect(replay).not.toHaveBeenCalled();
  },
);
