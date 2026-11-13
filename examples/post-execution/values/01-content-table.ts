/** Record actual sink notes, keep repeated content once, then restore the same saved entries. */
import { EventLog, memorySink } from 'foottrace/write';
import { readStoredRecord } from 'foottrace';
import { createValueTable, readValueRecord } from 'foottrace/values';
import type { ValueReference } from 'foottrace/values';

async function main(): Promise<void> {
  const sink = memorySink();
  const log = new EventLog({}, { sink, address: { logRunId: 'value-example', drillPath: [] } });
  const content = 'A repeated context rule. '.repeat(100);
  for (let i = 0; i < 30; i++) log.note('context', { content });
  log.close('ok');
  const before = { entries: sink.entries };
  const table = createValueTable({ redact: (served) => served });
  const entries: unknown[] = [];
  for (const entry of sink.entries) {
    if (entry.kind !== 'note') {
      entries.push(entry);
      continue;
    }
    const result = await table.intern('context', entry.data);
    if (result.status !== 'stored') throw new Error('The example value was omitted: ' + result.reason);
    entries.push({ ...entry, data: result.reference });
  }
  const packed = table.record({ entries });
  const opened = await readValueRecord(JSON.parse(JSON.stringify(packed)));
  const saved = opened.record as { entries: { kind: string; data?: ValueReference }[] };
  const expanded = {
    entries: saved.entries.map((entry) =>
      entry.kind === 'note' ? { ...entry, data: opened.values!.resolve(entry.data) } : entry,
    ),
  };
  const restored = JSON.stringify(expanded) === JSON.stringify(before);
  if (!restored) throw new Error('The recorded notes did not round-trip');
  const notes = readStoredRecord(expanded.entries).root('value-example')?.notes.length;
  console.log(
    JSON.stringify({
      beforeBytes: new TextEncoder().encode(JSON.stringify(before)).byteLength,
      afterBytes: new TextEncoder().encode(JSON.stringify(packed)).byteLength,
      restored,
      notes,
    }),
  );
}
void main();
