import { readEngineSourceLinksFixture as fixture } from '../../../../test/fixtures/source-links/read.js';
import { describe, expect, it } from 'vitest';
import { bindSourceLinkWrite, readSourceLinkRow } from '../../../cause.js';
import type { RecordScope, RecordSourceLink } from '../../../cause.js';
import type { CommitBundle } from '../../memory/types.js';
import {
  adapters,
  encodings,
  linkFor,
  parents,
  scopeFor,
} from '../../../../test/fixtures/source-links/recordHarness.js';
import type { Encoding } from '../../../../test/fixtures/source-links/recordHarness.js';

interface EngineRecord {
  initialState: Record<string, unknown>;
  commitLog: CommitBundle[];
  reads?: RecordScope['reads'];
}
type Encoded<T = EngineRecord> = Record<Encoding, T>;

// The paired written/read record was produced by make-real-engine-record.cjs with footprintjs 14.0.0.
const writtenAndRead = fixture<Encoded>('real-engine-record-full-and-delta');
// The other three footprintjs 14.0.0 recordings come from make-real-engine-record-append-between.cjs,
// make-real-engine-record-path-rule.cjs and make-real-engine-record-union.cjs, respectively.
const between = fixture<Encoded>('real-record-between');
const paths = fixture<Record<string, Encoded>>('real-record-path-rule');
const unions = fixture<Record<string, EngineRecord>>('real-record-union');

const allowAll = () => true;

function recordScope(record: EngineRecord, links: readonly RecordSourceLink[]) {
  return { ...scopeFor(record.initialState, record.commitLog, links), reads: record.reads ?? {} };
}

function linkAt(record: EngineRecord, witnessIdx: number, element: number, outputIdx = witnessIdx) {
  const evidence = record.commitLog[witnessIdx];
  const door = record.commitLog[outputIdx];
  const rows = evidence.overwrite.evidence ?? evidence.updates.evidence;
  const row = readSourceLinkRow(element === 0 ? rows[0] : rows.at(-1));
  if (!row) throw new Error(`Invalid engine evidence at ${witnessIdx}:${element}`);
  return linkFor(
    row,
    { runtimeStageId: door.runtimeStageId, commitIdx: outputIdx },
    {
      runtimeStageId: evidence.runtimeStageId,
      commitIdx: witnessIdx,
      key: 'evidence',
      element,
    },
  );
}

function finalLinks(record: EngineRecord) {
  const index = record.commitLog.length - 1;
  const door = record.commitLog[index];
  const evidence = door.overwrite.evidence ?? door.updates.evidence;
  return (evidence as readonly unknown[]).map((raw, element) => {
    const row = readSourceLinkRow(raw);
    if (!row) throw new Error(`Invalid engine evidence at ${index}:${element}`);
    return linkFor(
      row,
      { runtimeStageId: door.runtimeStageId, commitIdx: index },
      {
        runtimeStageId: door.runtimeStageId,
        commitIdx: index,
        key: 'evidence',
        element,
      },
    );
  });
}

const profile = ['profile', 'profile/selected'];
const allSelections = ['history[1]', ...profile];
const selectedPathCases = [
  ['between: entry 1 replaced, cited field changed', [], ['stale']],
  ['between: same values written again', allSelections, []],
  ['call commit: appends its own message (the agent shape)', allSelections, []],
  ['call commit: rewrites entry 1 after serving it', profile, ['stale']],
  ['check commit: rewrites entry 1 itself', profile, ['stale']],
  ['check commit: appends only', allSelections, []],
  ['between: entry 1 deleted (list shortened to one)', profile, ['stale']],
  ['between: an entry inserted BEFORE entry 1', profile, ['stale']],
] as const;

function decisions(page: Awaited<ReturnType<typeof parents>>) {
  const inputs = (page.sourceLinks ?? []).map(({ input: { view }, standing }) => {
    expect(standing).toBe('witnessed');
    return view.key + (view.element === undefined ? '' : `[${view.element}]`) + (view.pointer ?? '');
  });
  return { inputs: inputs.sort(), gaps: (page.sourceLinkGaps ?? []).map(({ code }) => code) };
}

describe.each(encodings)('real engine source-link records, %s', (encoding) => {
  it.each(adapters)('binds written and read outputs and preserves their origins in %s', async (adapter) => {
    const record = writtenAndRead[encoding];
    const written = linkAt(record, 2, 0);
    const read = linkAt(record, 5, 1, 4);
    const scope = recordScope(record, [written, read]);
    for (const [link, origin] of [
      [written, { runtimeStageId: 'load#0', commitIdx: 0 }],
      [read, { runtimeStageId: 'more#3', commitIdx: 3 }],
    ] as const) {
      expect(bindSourceLinkWrite(scope, link.witness)).toEqual({
        runtimeStageId: link.output.runtimeStageId,
        commitIdx: link.output.commitIdx,
      });
      const result = await parents(adapter, scope, link.output, { sourceLinkPolicy: allowAll });
      expect(result.sourceLinks).toMatchObject([{ standing: 'witnessed', input: { origin: { write: origin } } }]);
      expect(result.sourceLinkGaps).toBeUndefined();
    }
    const noReadMap = { ...scope, reads: {} };
    const traceOnly = await parents(adapter, noReadMap, read.output, { sourceLinkPolicy: allowAll });
    expect(traceOnly.sourceLinks?.[0]?.standing).toBe('witnessed');
    const stripped = {
      ...noReadMap,
      commitLog: record.commitLog.map((bundle) => ({
        ...bundle,
        trace: bundle.trace.map(({ readKeys: _, ...entry }) => entry),
      })),
    };
    expect(
      (await parents(adapter, stripped, read.output, { sourceLinkPolicy: allowAll })).sourceLinks?.[0]?.standing,
    ).toBe('declared');
  });

  it.each(adapters)(
    'keeps the element and pointer when there is an intervening append and sibling write in %s',
    async (adapter) => {
      const record = between[encoding];
      const links = finalLinks(record);
      const page = await parents(adapter, recordScope(record, links), links[0].output, { sourceLinkPolicy: allowAll });
      expect(decisions(page)).toEqual({ inputs: ['history[1]', 'profile/selected'], gaps: ['stale'] });
    },
  );

  it.each(selectedPathCases)('keeps the selected-path result for %s', async (name, inputs, gaps) => {
    const record = paths[name][encoding];
    const links = finalLinks(record);
    for (const adapter of adapters) {
      const page = await parents(adapter, recordScope(record, links), links[0].output, { sourceLinkPolicy: allowAll });
      expect(decisions(page)).toEqual({ inputs, gaps });
    }
  });

  it.each(['update', 'assign'] as const)('keeps real engine %s paired outcomes', async (operation) => {
    for (const adapter of adapters) {
      const pages = [];
      for (const twin of ['a', 'b']) {
        const record = unions[`${operation}/${encoding}/${twin}`];
        const links = finalLinks(record);
        pages.push(await parents(adapter, recordScope(record, links), links[0].output, { sourceLinkPolicy: allowAll }));
      }
      expect(JSON.stringify(pages[0])).toBe(JSON.stringify(pages[1]));
      expect(decisions(pages[0])).toEqual(
        operation === 'update'
          ? { inputs: ['profile/selected'], gaps: ['ambiguous'] }
          : { inputs: ['profile/selected', 'profile/tags/1', 'tags[2]'], gaps: [] },
      );
    }
  });
});
