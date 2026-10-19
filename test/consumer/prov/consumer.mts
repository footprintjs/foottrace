import { exportProv, ProvExportRefusal, type ProvExport, type ProvExportOptions } from 'foottrace/prov';

const options: ProvExportOptions = { base: 'urn:example:consumer/', values: 'none', maxCommits: 10 };
const result: Promise<ProvExport> = exportProv({ commitLog: [] }, options);
void result;
const refusal: TypeError = new ProvExportRefusal();
void refusal;

// @ts-expect-error Digest values are outside the initial one-scope export contract.
const digest: ProvExportOptions = { base: 'urn:example:consumer/', values: 'digest' };
void digest;
// @ts-expect-error The caller must supply its own absolute namespace.
void exportProv({ commitLog: [] }, { values: 'none' });
// @ts-expect-error P1 does not execute host agent callbacks.
const callbacks: ProvExportOptions = { base: 'urn:example:consumer/', agents: () => [] };
void callbacks;
