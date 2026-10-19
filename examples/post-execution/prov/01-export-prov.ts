/**
 * Export a hand-built record without an executor, model, network call or values.
 *
 * Prepared for the optional foottrace/prov entry; not in published 1.5.0.
 * A later commit by one execution remains one activity. Each write remains a
 * distinct occurrence. Reads are candidate evidence, not proven derivations.
 */
import { exportProv } from 'foottrace/prov';

async function main(): Promise<void> {
  const record = {
    commitLog: [
      {
        runtimeStageId: 'prepare#0',
        trace: [{ path: 'total', verb: 'set', readKeys: [] }],
        overwrite: { total: 25 },
      },
      {
        runtimeStageId: 'prepare#0',
        phase: 'repeat',
        trace: [{ path: 'total', verb: 'set', readKeys: [] }],
        overwrite: { total: 30 },
      },
      {
        runtimeStageId: 'present#1',
        trace: [
          { path: 'label', verb: 'set', readKeys: ['total'] },
          { path: 'private-contact', verb: 'set', readKeys: [] },
        ],
        redactedPaths: ['private-contact'],
        overwrite: { label: 'Your total', 'private-contact': 'PRIVATE_VALUE' },
      },
    ],
  };

  const exported = await exportProv(record, {
    base: 'urn:example:order:123/',
    values: 'none',
    maxCommits: 100,
  });
  const graph = exported.document['@graph'];
  const count = (type: string): number => graph.filter((node) => node['@type'] === type).length;
  console.log('Activities:', count('prov:Activity')); // 2; prepare saved twice.
  console.log('Commit metadata:', count('ft:Commit')); // 3.
  console.log('Write occurrences:', count('prov:Entity')); // 4; no values exported.
  console.log('Candidate dependencies:', count('ft:PossibleDerivation'));
  console.log('Complete:', exported.complete); // false: native capture/end attestation is unavailable.
  console.log(
    'Gaps:',
    exported.gaps.map((gap) => gap.code),
  );

  // Store/share the WHOLE envelope so missing evidence is not lost.
  const serialized = JSON.stringify(exported);
  if (serialized.includes('PRIVATE_VALUE') || serialized.includes('private-contact')) {
    throw new Error('The example must not disclose a redacted name or value');
  }
  console.log('Export bytes:', new TextEncoder().encode(serialized).length);
  // A redacted placeholder still exposes its original commit/row position.
}

void main();
