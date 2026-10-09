/** Exercise the built exports: separate entry bundles must not duplicate freeze metadata. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const checks = `
  const record = writer.freezeRecord({ when: new Date(5), nested: { bytes: new Uint8Array([1, 2]) }, sealed: { value: 3 } });
  const first = reader.serveRecord(record);
  assert.notEqual(first, record);
  assert.equal(first.sealed, record.sealed);
  first.when.setTime(99);
  first.nested.bytes[0] = 99;
  const second = reader.serveRecord(record);
  assert.equal(second.when.getTime(), 5);
  assert.equal(second.nested.bytes[0], 1);
  assert.notEqual(reader.serveRecord(first), first);
  assert.equal(reader.serveRecord(writer.freezeRecord({ value: 1 })).value, 1);
  const log = new writer.EventLog({});
  log.record({ stage: 'S', stageId: 's', runtimeStageId: 's#0', overwrite: { when: new Date(7) }, updates: {}, trace: [{ path: 'when', verb: 'set' }], redactedPaths: [] });
  const servedBundle = reader.serveRecord(log.recorded()[0]);
  servedBundle.overwrite.when.setTime(99);
  assert.equal(log.list()[0].overwrite.when.getTime(), 7);
`;

describe('built package public doors share record state', () => {
  it.each(['ESM', 'CJS'])('%s root and /write share freeze metadata', (format) => {
    const code =
      format === 'ESM'
        ? `import assert from 'node:assert/strict'; import * as reader from 'foottrace'; import * as writer from 'foottrace/write'; ${checks}`
        : `const assert = require('node:assert/strict'); const reader = require('foottrace'); const writer = require('foottrace/write'); ${checks}`;
    const result = spawnSync(process.execPath, [...(format === 'ESM' ? ['--input-type=module'] : []), '-e', code], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
  });
});
