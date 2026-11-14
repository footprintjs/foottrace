import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalizeJson } from '../canonical-json/canonical.js';
import { createValueTable } from './writer.js';
import { readValueRecord, readValueTable } from './reader.js';
import { VALUE_RECORD_FORMAT, ValueTableError } from './types.js';
import type { ValueWriteResult } from './types.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const identity = (value: unknown) => value;
function reference(result: ValueWriteResult) {
  if (result.status !== 'stored') throw new Error('Expected a stored value: ' + result.reason);
  return result.reference;
}
// Known SHA-256 vectors were independently generated with Node crypto, not this implementation.
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('a bounded table of already-served JSON values', () => {
  it('stores equal canonical values once, independently of labels, key order or object identity', async () => {
    const writer = createValueTable({ redact: identity });
    const a = await writer.intern('first', { b: 2, a: 1 });
    const b = await writer.intern('second', { a: 1, b: 2 });
    expect(reference(a)).toEqual(reference(b));
    expect(a.status === 'stored' && a.reused).toBe(false);
    expect(b.status === 'stored' && b.reused).toBe(true);
    expect(writer.snapshot().entries).toHaveLength(1);
    expect(reference(a).ref).toBe('sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777');
    expect(reference(await writer.intern('changed', { a: 2, b: 2 }))).not.toEqual(reference(a));
  });
  it('redacts before hashing or retaining anything, and never freezes the caller', async () => {
    const raw = { secret: 'DO-NOT-STORE', keep: { n: 1 } };
    const writer = createValueTable({ redact: () => ({ secret: '[redacted]', keep: raw.keep }) });
    const result = await writer.intern('safe label', raw);
    expect(JSON.stringify(writer.snapshot())).not.toContain('DO-NOT-STORE');
    expect(reference(result).ref).toBe('sha256:004ec408dcd570a4791c66d4c0cc734bb04ce661f64d6fb66ccd0979d58e306c');
    expect(Object.isFrozen(raw.keep)).toBe(false);
    raw.keep.n = 8;
    expect(writer.snapshot().entries[0].value).toEqual({ secret: '[redacted]', keep: { n: 1 } });
  });
  it('owns the value before the first crypto await and exposes immutable snapshots', async () => {
    const real = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
      await gate;
      return real(algorithm, data);
    });
    const value = { text: 'before' };
    const writer = createValueTable({ redact: identity });
    const pending = writer.intern('piece', value);
    expect(writer.snapshot().pending).toBe(1);
    value.text = 'after';
    finish();
    await pending;
    const first = writer.snapshot();
    expect(first.entries[0].value).toEqual({ text: 'before' });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.entries[0].value)).toBe(true);
    await writer.intern('next', 'next');
    expect(first.entries).toHaveLength(1);
  });
  it('preserves exact strings and literal reference-shaped data through a serialized table', async () => {
    const writer = createValueTable({ redact: identity });
    const text = '\r\nRule: e\u0301 / \u00e9 / \ud83d\ude00\n';
    const a = reference(await writer.intern('rule', text));
    const literal = { ref: a.ref };
    const b = reference(await writer.intern('literal', literal));
    const reader = await readValueTable(copy(writer.snapshot()));
    expect(reader.resolve(a)).toBe(text);
    expect(reader.resolve(b)).toEqual(literal);
    expect(reader.resolve(b)).not.toBe(literal);
  });
  it('admits concurrent identical writes without a duplicate entry', async () => {
    const writer = createValueTable({ redact: identity });
    const results = await Promise.all([writer.intern('a', { x: 1 }), writer.intern('b', { x: 1 })]);
    expect(reference(results[0])).toEqual(reference(results[1]));
    expect(writer.snapshot().entries).toHaveLength(1);
    expect(writer.snapshot().pending).toBe(0);
  });
  it.each([
    [{ maxEntries: 1 }, 'entry-limit'],
    [{ maxBytes: 3 }, 'byte-limit'],
    [{ maxAttempts: 1 }, 'attempt-limit'],
    [{ maxDigestBytes: 3 }, 'digest-budget'],
  ] as const)('discloses each refused write under %j without minting a dangling reference', async (limits, reason) => {
    const writer = createValueTable({ redact: identity, limits });
    await writer.intern('a', 'a'); // canonical bytes: 3
    const result = await writer.intern('b', 'b');
    expect(result).toEqual({ status: 'omitted', reason });
    expect(writer.snapshot().omissions[reason]).toBe(1);
    expect(writer.snapshot().entries).toHaveLength(1);
  });
  it('reuses retained values even after the entry/byte caps are reached', async () => {
    const writer = createValueTable({ redact: identity, limits: { maxEntries: 1, maxBytes: 3 } });
    const a = await writer.intern('a', 'a');
    expect(reference(await writer.intern('again', 'a'))).toEqual(reference(a));
    expect(writer.snapshot().omissions['entry-limit']).toBe(0);
  });
  it('bounds admission before crypto and counts unsupported values and bad labels', async () => {
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest');
    const writer = createValueTable({ redact: identity, limits: { maxValueBytes: 3 } });
    expect(await writer.intern('long value', 'long')).toEqual({ status: 'omitted', reason: 'value-limit' });
    expect(await writer.intern('invalid', undefined)).toEqual({ status: 'omitted', reason: 'invalid-value' });
    expect(await writer.intern('x'.repeat(81), null)).toEqual({ status: 'omitted', reason: 'invalid-label' });
    expect(digest).not.toHaveBeenCalled();
  });
  it('contains a redaction exception without retaining its message or original value', async () => {
    const writer = createValueTable({
      redact: () => {
        throw new Error('SECRET');
      },
    });
    expect(await writer.intern('rule', 'SECRET')).toEqual({ status: 'omitted', reason: 'redaction-failed' });
    expect(JSON.stringify(writer.snapshot())).not.toContain('SECRET');
  });
  it('counts absent or rejected crypto and never substitutes another digest algorithm', async () => {
    vi.stubGlobal('crypto', undefined);
    const writer = createValueTable({ redact: identity });
    expect(await writer.intern('rule', 'text')).toEqual({ status: 'omitted', reason: 'crypto-unavailable' });
    expect(writer.snapshot().entries).toEqual([]);
  });
  it('counts crypto rejection and digest collisions without exposing values', async () => {
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest').mockRejectedValueOnce(new Error('SECRET'));
    const writer = createValueTable({ redact: identity });
    expect(await writer.intern('failure', 'SECRET')).toEqual({ status: 'omitted', reason: 'digest-failed' });
    digest.mockResolvedValue(new Uint8Array(32).buffer);
    await writer.intern('a', 'a');
    expect(await writer.intern('b', 'b')).toEqual({ status: 'omitted', reason: 'digest-collision' });
    expect(JSON.stringify(writer.snapshot())).not.toContain('SECRET');
  });
  it('bounds waiting, ignores a late digest and stops scheduling new hashes after timeout', async () => {
    let finish!: (value: ArrayBuffer) => void;
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const writer = createValueTable({ redact: identity, limits: { digestTimeoutMs: 10 } });
    expect(await writer.intern('a', 'a')).toEqual({ status: 'omitted', reason: 'digest-timeout' });
    finish(new Uint8Array(32).buffer);
    await Promise.resolve();
    expect(writer.snapshot().entries).toEqual([]);
    expect(await writer.intern('b', 'b')).toEqual({ status: 'omitted', reason: 'digest-timeout' });
    expect(digest).toHaveBeenCalledTimes(1);
  });
  it('bounds concurrent crypto work and discloses unfinished exports', async () => {
    let finish!: (value: ArrayBuffer) => void;
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const writer = createValueTable({ redact: identity, limits: { maxInFlight: 1 } });
    const first = writer.intern('a', 'a');
    expect(writer.record({ n: 1 }).valueTable.pending).toBe(1);
    expect(await writer.intern('b', 'b')).toEqual({ status: 'omitted', reason: 'concurrency-limit' });
    finish(new Uint8Array(32).buffer);
    await first;
    expect(writer.snapshot().pending).toBe(0);
  });
  it('requires an explicit redaction law and refuses option accessors without invoking them', () => {
    let reads = 0;
    const options = Object.defineProperty({}, 'redact', { get: () => ++reads });
    for (const bad of [
      {},
      options,
      { redact: identity, limits: { maxEntries: Infinity } },
      { redact: identity, extra: 1 },
    ])
      expect(() => createValueTable(bad as never)).toThrow();
    expect(reads).toBe(0);
  });
});

describe('a table reader and the explicit record envelope', () => {
  it('keeps old records unchanged without touching payloads, getters or crypto', async () => {
    vi.stubGlobal('crypto', undefined);
    const old = { snapshot: {}, events: [], structure: {} };
    expect((await readValueRecord(old)).record).toBe(old);
    const getter = Object.defineProperty({}, 'format', {
      get: () => {
        throw new Error('SECRET');
      },
    });
    expect((await readValueRecord(getter)).record).toBe(getter);
  });
  it('opens a new envelope and resolves only explicit reference positions', async () => {
    const writer = createValueTable({ redact: identity });
    const ref = reference(await writer.intern('rule', 'exact text'));
    const envelope = copy(writer.record({ context: ref }));
    const opened = await readValueRecord(envelope);
    expect(opened.record).toEqual({ context: ref });
    expect(opened.values?.resolve(ref)).toBe('exact text');
    expect(() => opened.values?.resolve({ ref: 'sha256:' + 'f'.repeat(64) })).toThrow(
      expect.objectContaining({ code: 'dangling-reference' }),
    );
    expect(() => opened.values?.resolve({ ref: ref.ref, other: true })).toThrow();
  });
  it('owns all entries before awaiting verification and keeps borrowed input mutable', async () => {
    const writer = createValueTable({ redact: identity });
    const ref = reference(await writer.intern('one', { n: 1 }));
    const secondRef = reference(await writer.intern('two', { n: 2 }));
    const table = copy(writer.snapshot());
    const real = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
      await gate;
      return real(algorithm, data);
    });
    const pending = readValueTable(table);
    (table.entries[0].value as { n: number }).n = 8;
    (table.entries[1].value as { n: number }).n = 9;
    finish();
    const reader = await pending;
    expect(reader.resolve(ref)).toEqual({ n: 1 });
    expect(reader.resolve(secondRef)).toEqual({ n: 2 });
    expect(Object.isFrozen(table)).toBe(false);
  });
  it('rejects tampering, duplicate ids, unsupported formats and table limits by name', async () => {
    const writer = createValueTable({ redact: identity });
    await writer.intern('one', 'one');
    await writer.intern('two', 'two');
    const table = writer.snapshot();
    const changed = copy(table) as unknown as { entries: { value: unknown }[] };
    changed.entries[0].value = 'bad';
    await expect(readValueTable(changed)).rejects.toMatchObject({ code: 'digest-mismatch' });
    await expect(readValueTable({ ...table, entries: [table.entries[0], table.entries[0]] })).rejects.toMatchObject({
      code: 'invalid-table',
    });
    await expect(
      readValueRecord({ format: 'foottrace.value-record.v2', record: {}, valueTable: table }),
    ).rejects.toMatchObject({ code: 'unsupported-format' });
    await expect(readValueTable(table, { maxEntries: 1 })).rejects.toMatchObject({ code: 'table-limit' });
  });
  it('does not invoke untrusted envelope, entry or reference getters', async () => {
    let reads = 0;
    const writer = createValueTable({ redact: identity });
    const ref = reference(await writer.intern('one', 'one'));
    const table = writer.snapshot();
    const entry = Object.defineProperty({ id: ref.ref, label: 'one' }, 'value', {
      enumerable: true,
      get: () => ++reads,
    });
    await expect(readValueTable({ ...table, entries: [entry] })).rejects.toMatchObject({ code: 'invalid-table' });
    const envelope = Object.defineProperty({ format: VALUE_RECORD_FORMAT, record: {} }, 'valueTable', {
      enumerable: true,
      get: () => ++reads,
    });
    await expect(readValueRecord(envelope)).rejects.toMatchObject({ code: 'invalid-record' });
    const reader = await readValueTable(table);
    expect(() => reader.resolve(Object.defineProperty({}, 'ref', { enumerable: true, get: () => ++reads }))).toThrow();
    expect(reads).toBe(0);
  });
  it('measures actual repeated-content bytes and exactly recovers each stored string', async () => {
    const text = 'A repeated context rule. '.repeat(100);
    const before = { events: Array.from({ length: 30 }, () => ({ content: text })) };
    const writer = createValueTable({ redact: identity });
    const events = [];
    for (const event of before.events) events.push({ content: reference(await writer.intern('rule', event.content)) });
    const packed = writer.record({ events });
    const opened = await readValueRecord(copy(packed));
    const after = { events: events.map((event) => ({ content: opened.values!.resolve(event.content) })) };
    expect(after).toEqual(before);
    const bytesBefore = new TextEncoder().encode(JSON.stringify(before)).length;
    const bytesAfter = new TextEncoder().encode(JSON.stringify(packed)).length;
    expect(bytesAfter).toBeLessThan(bytesBefore);
    expect(canonicalizeJson(after)).toBe(canonicalizeJson(before));
  });
});

it('sanitizes a forged public table error from a proxy trap', async () => {
  const forged = new ValueTableError('invalid-table');
  forged.message = 'SECRET';
  const input = new Proxy(
    {},
    {
      getPrototypeOf: () => {
        throw forged;
      },
    },
  );
  await expect(readValueTable(input)).rejects.toMatchObject({ message: 'Value table refused: invalid-table' });
});
