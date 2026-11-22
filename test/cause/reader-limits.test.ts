import { expect, it, vi } from 'vitest';
import { bindSourceLinkWrites } from '../../src/cause.js';
import { readStoredRecord } from '../../src/index.js';
import { prepareRecordScope } from '../../src/lib/cause/recordScope.js';
import { bundleOf, recordRefusalCode } from '../../src/lib/cause/recordValidation.js';
import { recordTextEquality } from '../../src/lib/cause/recordValueWork.js';
import { admitSourceLinks } from '../../src/lib/cause/sourceLinks/admission.js';
import * as replay from '../../src/lib/cause/sourceLinks/replay.js';
import { readerLimits } from '../../src/lib/evidence/readerLimits.js';
import { DELIM } from '../../src/lib/record-paths/codec.js';
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
} from '../fixtures/source-links/recordHarness.js';

const row = witness({ key: 'seed' }, { key: 'answer', checkedIn: 'written' });
const output = { runtimeStageId: 'door', commitIdx: 1, key: 'answer' };
const locator = { ...output, key: 'evidence', element: 0 };
const log = [servedWrite(0, [{ key: 'seed' }]), bundle(1, 'door', { answer: 1, evidence: [row] })];
const bindingScope = scopeFor({ seed: 'fixture' }, log, []);
const write = { runtimeStageId: 'door', commitIdx: 1 };

function refusalOf(read: () => unknown): string | undefined {
  try {
    read();
    return undefined;
  } catch (error) {
    const reason = recordRefusalCode(error);
    if (reason === undefined) throw error;
    return reason;
  }
}

type Boundary = keyof typeof readerLimits;
const probe: Record<Boundary, (size: number, above: boolean) => void | Promise<void>> = {
  async sourceLinkInventory(size, above) {
    const selected = { ...output, commitIdx: 2 };
    const link = linkFor(row, selected, { ...locator, commitIdx: 2 });
    // Keep just one link relevant to the query so the separate page-size limit
    // does not decide this inventory test.
    const unrelated = { ...link, output: { ...link.output, key: 'other' } };
    const links = [link, ...Array.from({ length: size - 1 }, () => unrelated)];
    const history = [
      bundle(0, 'source', { seed: 'fixture' }),
      servedWrite(1, [{ key: 'seed' }]),
      bundle(2, 'door', { answer: 1, evidence: [row] }),
    ];
    const scope = scopeFor({}, history, links);
    const expected = above ? [readerLimits.sourceLinkInventory.reason] : [];
    expect(admitSourceLinks(scope.sourceLinks, { left: readerLimits.binderWork.maximum }).gaps).toEqual(expected);
    for (const adapter of adapters) {
      const graph = reader(adapter, [scope], {
        maxFields: readerLimits.causeTextWork.maximum,
        sourceLinkPolicy: exactPolicy(address, link),
      });
      const page = await graph.parents(graph.nodeId(address, selected), context());
      // The accepted witness has the existing neutral origin gap. Above the
      // inventory boundary that row is refused before origin resolution.
      expect((page.sourceLinkGaps ?? []).map(({ code }) => code)).toEqual(above ? expected : ['unavailable']);
      expect(page.sourceLinks?.length ?? 0).toBe(above ? 0 : 1);
    }
  },
  async causeCommits(size, above) {
    const { maximum, reason } = readerLimits.causeCommits;
    const maximumFields = readerLimits.causeTextWork.maximum;
    const records = Array.from({ length: size }, (_, i) => bundle(i, `step-${i}`, { value: i }));
    const scope = scopeFor({}, records, []);
    expect(refusalOf(() => prepareRecordScope(scope, address, maximum, maximumFields))).toBe(
      above ? reason : undefined,
    );
    for (const adapter of adapters) {
      const graph = reader(adapter, [scope], { maxCommits: maximum, maxFields: maximumFields });
      const node = graph.nodeId(address, { runtimeStageId: 'step-0', commitIdx: 0, key: 'value' });
      const page = await graph.parents(node, context());
      expect((page.gaps ?? []).map(({ code }) => code)).toEqual(above ? [reason] : []);
      if (above) expect(page.complete).toBe(false);
    }
  },
  async traceRows(size, above) {
    const { reason } = readerLimits.traceRows;
    const writes = Object.fromEntries(Array.from({ length: size }, (_, i) => [`k${i}`, i]));
    const record = bundle(0, 'step-0', writes);
    expect(refusalOf(() => bundleOf(record, -1, { left: 20_000 }))).toBe(above ? reason : undefined);
    const scope = scopeFor({}, [record], []);
    for (const adapter of adapters) {
      const graph = reader(adapter, [scope], {});
      const node = graph.nodeId(address, { runtimeStageId: 'step-0', commitIdx: 0, key: 'k0' });
      const page = await graph.parents(node, context());
      expect((page.gaps ?? []).map(({ code }) => code)).toEqual(above ? [reason] : []);
      if (above) expect(page.complete).toBe(false);
    }
  },
  binderLocators(size, above) {
    const { maximum, reason } = readerLimits.binderLocators;
    const locators = Array.from({ length: size }, () => locator);
    expect(bindSourceLinkWrites(bindingScope, locators)).toEqual({
      writes: Array.from({ length: Math.min(maximum, size) }, () => write),
      complete: !above,
      ...(above && { reason }),
    });
  },
  binderWork(size, above) {
    const { maximum, reason } = readerLimits.binderWork;
    const accounting = vi.spyOn(replay, 'sourceLinkReplay');
    try {
      expect(bindSourceLinkWrites(bindingScope, [locator])).toEqual({ writes: [write], complete: true });
      const unitsForPadding = size - (maximum - accounting.mock.calls.at(-1)![1].left) - 1;
      // One unit for the array, plus one for each slot and one for its value.
      const initialState = {
        ...bindingScope.initialState,
        pad: Array<number>(Math.floor(unitsForPadding / 2)).fill(0),
        ...(unitsForPadding % 2 === 1 && { extra: 0 }),
      };
      expect(bindSourceLinkWrites({ ...bindingScope, initialState }, [locator])).toEqual({
        writes: [above ? undefined : write],
        complete: !above,
        ...(above && { reason }),
      });
      expect(maximum - accounting.mock.calls.at(-1)![1].left).toBe(size);
    } finally {
      accounting.mockRestore();
    }
  },
  async causeTextWork(size, above) {
    const { maximum, reason } = readerLimits.causeTextWork;
    const text = 's'.repeat(size);
    const compared = () => recordTextEquality(maximum)(text, `${text.slice(0, -1)}r`);
    if (above) expect(refusalOf(compared)).toBe(reason);
    else expect(compared()).toBe(false);

    const first = bundle(0, 'start', { profile: { chosen: text, hidden: 'old' } });
    const second = bundle(1, 'rewrite', { profile: { chosen: text, hidden: 'new' } });
    const scope = { ...scopeFor({}, [first, second], []), sourceLinks: undefined };
    for (const adapter of adapters) {
      const graph = reader(adapter, [scope], { maxFields: maximum });
      const node = graph.nodeId(address, { runtimeStageId: 'start', commitIdx: 0, key: `profile${DELIM}chosen` });
      const page = await graph.children(node, context());
      expect((page.gaps ?? []).map(({ code }) => code)).toEqual(above ? [reason] : []);
    }
  },
  storedAddress(size, above) {
    const result = readStoredRecord([
      { kind: 'opened', at: 0, address: { logRunId: 'r'.repeat(size), drillPath: [] }, initialState: {} },
    ]);
    expect(result.unread.map(({ reason }) => reason)).toEqual(
      above ? [`address is longer than the reader's limit of ${readerLimits.storedAddress.maximum} characters`] : [],
    );
  },
};

for (const name of Object.keys(readerLimits) as Boundary[]) {
  const { maximum } = readerLimits[name];
  it.each([-1, 0, 1])(`${name} at limit offset %i`, (offset) => probe[name](maximum + offset, offset > 0));
}
