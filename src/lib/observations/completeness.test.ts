import { describe, expect, it } from 'vitest';
import { readObservationRecord, readStoredRecord } from '../../index.js';
import { address, gapCodes, reopen, saved, subject } from '../../../test/lib/observations/fixtures.js';

const { attemptId: _unused, ...withoutAttempt } = subject;
const noteIndexes = (entries: ReturnType<typeof saved>) =>
  entries.flatMap((entry, i) => (entry.kind === 'note' ? [i] : []));
const meta = (entry: ReturnType<typeof saved>[number]) => {
  if (!('meta' in entry) || !entry.meta) throw new Error('fixture');
  return entry.meta.observations as Record<string, unknown>;
};

describe('persisted observation completeness and subject boundaries', () => {
  it('detects a missing LAST note that the generic commit reader cannot detect', () => {
    const entries = saved(),
      tail = noteIndexes(entries).at(-1)!;
    entries.splice(tail, 1);
    const stored = readStoredRecord(entries);
    expect(stored.log(address)?.complete).toBe(true);
    const evidence = readObservationRecord(stored, { address, subject });
    expect(evidence.status).toBe('partial');
    expect(evidence.rows).toHaveLength(1);
    expect(evidence.gaps.map((gap) => gap.code)).toContain('count-mismatch');
  });
  it('distinguishes collected EMPTY from an absent collection', () => {
    expect(reopen(saved(0)).status).toBe('collected');
    expect(reopen([])).toMatchObject({ status: 'not-collected', rows: [], authenticity: 'unverified' });
  });
  it('never reports a missing close as collected', () => {
    const entries = saved().filter((entry) => entry.kind !== 'closed');
    expect(gapCodes(entries)).toContain('incomplete-record');
    expect(gapCodes(entries)).toContain('count-mismatch');
    expect(reopen(entries).status).toBe('partial');
  });
  it('never reports an unknown close declaration as collected', () => {
    const entries = saved();
    meta(entries.at(-1)!).v = 2;
    expect(gapCodes(entries)).toContain('unsupported-version');
    expect(reopen(entries).status).toBe('partial');
  });
  it.each([undefined, { v: 2, subject }])('refuses a missing or unknown opened declaration', (declaration) => {
    const entries = saved(),
      first = entries[0];
    if (first.kind !== 'opened') throw new Error('fixture');
    Object.assign(first, { meta: declaration === undefined ? {} : { observations: declaration } });
    expect(reopen(entries).status).toBe('not-collected');
  });
  it.each([
    { ...subject, runId: 'another-run' },
    { ...subject, nativeAddress: { logRunId: 'another-native', drillPath: [] } },
    { ...subject, runtimeStageId: 'other#0', attemptId: 'other#0@1.1@1' },
    { ...subject, attemptId: 'request#0@1.2@1' },
    { ...subject, operationRef: 'operation-2' },
    withoutAttempt,
  ])('refuses a different exact host subject', (changed) => {
    const evidence = readObservationRecord(readStoredRecord(saved()), { address, subject: changed });
    expect(evidence).toMatchObject({ status: 'not-collected', subjectBinding: 'unmatched', rows: [] });
  });
  it('does not take an observation log from another address', () => {
    expect(
      readObservationRecord(readStoredRecord(saved()), { address: { ...address, drillPath: ['other#0'] }, subject })
        .status,
    ).toBe('not-collected');
  });
  it('detects a hole, a duplicate and a reorder in real persisted note entries', () => {
    const hole = saved(3);
    hole.splice(noteIndexes(hole)[1], 1);
    expect(gapCodes(hole)).toContain('missing-note');
    const duplicate = saved();
    duplicate.splice(2, 0, structuredClone(duplicate[1]));
    expect(gapCodes(duplicate)).toContain('duplicate-sequence');
    const swapped = saved();
    [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
    expect(gapCodes(swapped)).toContain('missing-note');
  });
  it('detects contradictory close counts and invalid omission declarations', () => {
    const count = saved();
    meta(count.at(-1)!).rows = 1;
    expect(gapCodes(count)).toContain('count-mismatch');
    const omissions = saved();
    meta(omissions.at(-1)!).omissions = { 'invalid-data': 0, 'row-limit': 0, 'byte-limit': -1 };
    expect(gapCodes(omissions)).toContain('incomplete-record');
  });
  it('does not promote self-consistent edited contents to authentication', () => {
    const entries = saved(1),
      note = entries.find((entry) => entry.kind === 'note');
    if (!note || note.kind !== 'note') throw new Error('fixture');
    Object.assign(note.data, { facts: { status: 200 } });
    expect(reopen(entries)).toMatchObject({
      status: 'collected',
      authenticity: 'unverified',
      rows: [{ facts: { status: 200 } }],
    });
  });
  it('marks generic unread entries conservatively', () => {
    expect(reopen([...saved(), { kind: 'unrecognized' }]).gaps.map((gap) => gap.code)).toContain('unread-entry');
  });
});
