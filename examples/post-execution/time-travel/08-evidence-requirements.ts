/** The host binds artifacts, identity and policy; Foottrace reads reference-only records. */
import { readRequirementResults, type RequirementResult } from 'foottrace';

// requirementRef names the definition. The result's containing artifact reference
// is minted separately by the host's store/resolver after the record is stored.
const produced: RequirementResult = {
  id: 'result:connection:1',
  requirementRef: 'policy:client-workload-connection',
  findingRef: 'finding:latency:1',
  windowRef: 'window:incident:1',
  affects: ['claim:workload-attribution:1'],
  state: 'unresolved',
  reason: 'not-collected',
  detail: 'storage:workload-inventory',
  evidenceRefs: ['evidence:latency-summary:1'],
  checks: [],
  actionRefs: [],
};

const stored: unknown = JSON.parse(JSON.stringify([produced]));
const [read] = readRequirementResults(stored);
console.log(read.reason, read.affects);
// No lookup or attempt was invented. The absent connection blocks only this
// attribution claim; the host may still render independently supported latency.
// Even a structurally satisfied state would need authenticated source, current
// query/run/scope, expected requirement membership and domain-validity checks.
