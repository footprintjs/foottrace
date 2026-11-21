/** Project real engine events into the evidence envelope ahead of the engine-side writer. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RecordEntry, RunDecisionNote } from '../../src/write.js';

interface EngineLoopFixture {
  readonly name: string;
  readonly commitValues: 'full' | 'delta';
  readonly entries: readonly RecordEntry[];
  readonly legs: readonly string[];
  readonly resumes: Readonly<Record<string, string>>;
  readonly live: readonly {
    readonly id: string;
    readonly parent?: string;
    readonly control?: { readonly deciderId: string; readonly label?: string };
  }[];
  readonly decisions: Readonly<Record<string, Omit<RunDecisionNote, 'id'>>>;
  readonly loops: Readonly<Record<string, string>>;
}

export const loopFixtures: readonly EngineLoopFixture[] = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/run-evidence/engine-loops-14.1.0.json'), 'utf8'),
);

export function loopRecord(
  fixture: EngineLoopFixture,
  version: 1 | 2,
  loops: Readonly<Record<string, string>> = fixture.loops,
): unknown[] {
  const parents = new Map(fixture.live.map(({ id, parent }) => [id, parent]));
  const seqs = new Map<string, number>();
  const rows: unknown[] = [];

  for (const entry of fixture.entries) {
    const { address, at } = entry;
    const log = JSON.stringify(address);
    if (entry.kind === 'opened') {
      seqs.set(log, 0);
      rows.push({ ...entry, collects: { v: version, reads: 'keys' } });
    } else if (entry.kind === 'commit' && entry.bundle.phase === undefined) {
      const id = entry.bundle.runtimeStageId;
      const parent = parents.get(id);
      if (!parents.has(id)) throw new Error(`Missing engine execution ${id}`);
      const resumes = fixture.resumes[id];
      rows.push({
        ...entry,
        about: { ...(parent !== undefined && { parent }), ...(resumes !== undefined && { resumes }) },
      });
      let seq = seqs.get(log)!;
      const decision = fixture.decisions[id];
      if (decision !== undefined)
        rows.push({ address, at, kind: 'note', note: 'run.decision', data: { id, seq: seq++, ...decision } });
      const target = loops[id];
      if (version === 2 && target !== undefined)
        rows.push({ address, at, kind: 'note', note: 'run.loop', data: { id, seq: seq++, target } });
      seqs.set(log, seq);
    } else if (entry.kind === 'closed') {
      rows.push({ ...entry, runNotes: seqs.get(log) });
    } else {
      rows.push(entry);
    }
  }
  return rows;
}
