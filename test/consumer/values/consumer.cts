import { createValueTable, readValueRecord, type ValueWriteResult, type ValueReference } from 'foottrace/values';
import { canonicalizeJson, type CanonicalJsonOptions } from 'foottrace/canonical-json';
const options: CanonicalJsonOptions = { maxBytes: 1024 };
const text: string = canonicalizeJson({ b: 2, a: 1 }, options);
const table = createValueTable({ redact: (value) => value });
const written: Promise<ValueWriteResult> = table.intern('rule', text);
async function consume(): Promise<void> {
  const result = await written;
  if (result.status === 'stored') {
    const reference: ValueReference = result.reference;
    const opened = await readValueRecord(table.record({ reference }));
    opened.values?.resolve(reference);
  } else {
    const reason: string = result.reason;
    void reason;
    // @ts-expect-error An omitted value supplies no reference.
    result.reference;
  }
}
void consume;
// @ts-expect-error A writer requires an explicit serving/redaction law.
createValueTable({});
