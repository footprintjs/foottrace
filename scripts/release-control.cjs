'use strict';
const SHA = /^[a-f0-9]{40}$/;
const validSha = (value) => typeof value === 'string' && SHA.test(value);
const sameRepo = (a, b) =>
  a && b && Number.isSafeInteger(a.id) && a.id > 0 && a.id === b.id && a.full_name === b.full_name;
const success = (x) => x?.status === 'completed' && x.conclusion === 'success';
const hold = (reason) => ({ authorized: false, mode: 'hold', reason });
function decideAuthority(w) {
  try {
    const e = w.expected,
      ev = w.event;
    if (
      !e ||
      !validSha(e.mergeSha) ||
      !validSha(e.headSha) ||
      !validSha(e.tree) ||
      e.package !== 'foottrace' ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(e.version) ||
      e.tag !== `v${e.version}`
    )
      return hold('identity');
    if (
      !['push', 'workflow_dispatch'].includes(ev?.name) ||
      ev.ref !== 'refs/heads/main' ||
      ev.sha !== e.mergeSha ||
      !sameRepo(ev.repository, e.repository)
    )
      return hold('event');
    if (
      w.commit?.sha !== e.mergeSha ||
      w.commit.tree?.sha !== e.tree ||
      w.headCommit?.sha !== e.headSha ||
      w.headCommit.tree?.sha !== e.tree
    )
      return hold('reviewed-tree');
    if (
      w.pullsComplete !== true ||
      w.reviewsComplete !== true ||
      w.permissionsComplete !== true ||
      !Array.isArray(w.pulls) ||
      w.pulls.length !== 1 ||
      !Array.isArray(w.reviews) ||
      !Array.isArray(w.reviewerPermissions)
    )
      return hold('incomplete');
    const p = w.pulls[0],
      app = w.app;
    if (
      !app ||
      typeof app.expectedSlug !== 'string' ||
      !/^[a-z0-9-]+$/.test(app.expectedSlug) ||
      !app.expectedClientId ||
      app.metadata?.slug !== app.expectedSlug ||
      app.metadata.client_id !== app.expectedClientId ||
      app.bot?.login !== `${app.expectedSlug}[bot]` ||
      app.bot.type !== 'Bot' ||
      !Number.isSafeInteger(app.bot.id)
    )
      return hold('app');
    if (
      p.number !== e.pr ||
      p.state !== 'closed' ||
      !p.merged_at ||
      p.merge_commit_sha !== e.mergeSha ||
      p.head?.sha !== e.headSha ||
      p.head.ref !== 'release/next' ||
      p.base?.ref !== 'main' ||
      !sameRepo(p.head.repo, e.repository) ||
      !sameRepo(p.base.repo, e.repository) ||
      p.user?.id !== app.bot.id ||
      p.user.type !== 'Bot'
    )
      return hold('release-pr');
    const effective = new Map();
    for (const r of [...w.reviews].sort((a, b) => a.id - b.id)) {
      if (!Number.isSafeInteger(r.id) || !r.user || !Number.isSafeInteger(r.user.id)) return hold('review-shape');
      if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) effective.set(r.user.id, r);
    }
    // Do not turn a later objection into authority through another old approval.
    if ([...effective.values()].some((r) => r.state === 'CHANGES_REQUESTED')) return hold('changes-requested');
    const approved = [...effective.values()].some((r) => {
      const permissions = w.reviewerPermissions.filter(
        (p) => p.user?.id === r.user.id && p.user.login === r.user.login,
      );
      return (
        r.state === 'APPROVED' &&
        r.commit_id === e.headSha &&
        r.user.type === 'User' &&
        r.user.id !== p.user.id &&
        permissions.length === 1 &&
        ['write', 'admin'].includes(permissions[0].permission)
      );
    });
    return approved ? { authorized: true, identity: e } : hold('approval');
  } catch {
    return hold('invalid-evidence');
  }
}
function decideCiReuse(w) {
  const no = (reason) => ({ tested: false, fallback: 'both-full-runtime-gates', reason });
  try {
    if (
      w.runsComplete !== true ||
      w.jobsComplete !== true ||
      w.workflow?.path !== '.github/workflows/ci.yml' ||
      !Array.isArray(w.runs) ||
      !Array.isArray(w.jobs)
    )
      return no('incomplete');
    const e = w.expected;
    const runs = w.runs
      .filter(
        (r) => r.head_sha === e.headSha && r.event === 'pull_request' && sameRepo(r.head_repository, e.repository),
      )
      .sort((a, b) => b.id - a.id);
    const r = runs[0],
      a = w.attempt;
    if (
      !r ||
      r.workflow_id !== w.workflow.id ||
      r.path !== w.workflow.path ||
      !success(r) ||
      !Number.isSafeInteger(r.run_attempt) ||
      !a ||
      a.id !== r.id ||
      a.run_attempt !== r.run_attempt ||
      !success(a) ||
      a.head_sha !== e.headSha
    )
      return no('run');
    for (const name of ['check (22)', 'check (24)', 'tested-tree']) {
      const selected = w.jobs.filter((j) => j.name === name);
      if (
        selected.length !== 1 ||
        !success(selected[0]) ||
        selected[0].run_id !== r.id ||
        selected[0].run_attempt !== r.run_attempt
      )
        return no('jobs');
    }
    const marks = w.jobs.find((j) => j.name === 'tested-tree').steps.filter((s) => s.name?.startsWith('tested tree '));
    if (
      marks.length !== 1 ||
      marks[0].name !== `tested tree ${e.tree}` ||
      marks[0].conclusion !== 'success' ||
      !validSha(e.tree)
    )
      return no('tree');
    return { tested: true, runId: r.id, attempt: r.run_attempt };
  } catch {
    return no('invalid-evidence');
  }
}
function decideProposalState(w) {
  const no = { action: 'hold', force: false };
  if (
    !validSha(w.base) ||
    w.base !== w.currentMain ||
    w.complete !== true ||
    !Array.isArray(w.pulls) ||
    w.pulls.length > 1
  )
    return no;
  if (!w.existing) return w.pulls.length ? no : { action: 'create', force: false };
  if (w.existing.parent !== w.base || w.existing.tree !== w.expectedTree || !validSha(w.existing.head)) return no;
  if (
    w.pulls.length !== 1 ||
    w.pulls[0].head?.sha !== w.existing.head ||
    w.pulls[0].base?.ref !== 'main' ||
    w.pulls[0].state !== 'open'
  )
    return no;
  return { action: 'no-op', force: false };
}
function validateArtifactBinding(w) {
  try {
    const e = w.expected,
      a = w.artifact,
      p = w.producer,
      m = w.manifest;
    for (const n of ['repositoryId', 'runId', 'runAttempt', 'jobId', 'artifactId'])
      if (!Number.isSafeInteger(e[n]) || e[n] <= 0) return { valid: false };
    if (
      a.id !== e.artifactId ||
      a.name !== e.artifactName ||
      a.expired !== false ||
      a.workflow_run?.id !== e.runId ||
      a.workflow_run.head_sha !== e.sourceSha ||
      a.workflow_run.repository_id !== e.repositoryId ||
      !success(p) ||
      p.id !== e.jobId ||
      p.name !== e.jobName ||
      p.run_id !== e.runId ||
      p.run_attempt !== e.runAttempt ||
      p.uploadArtifactId !== e.artifactId
    )
      return { valid: false };
    for (const key of ['repositoryId', 'runId', 'runAttempt', 'jobId', 'sourceSha', 'tree', 'package', 'version'])
      if (m[key] !== e[key]) return { valid: false };
    return { valid: true };
  } catch {
    return { valid: false };
  }
}
function decideSubmission(w) {
  if (w.registry && w.registry.integrity !== w.expected.integrity) return { action: 'hold', mayPublish: false };
  if (w.journal || w.registry) return { action: 'verify-only', mayPublish: false };
  return { action: 'reserve', mayPublish: false };
}
function validatePublishGrant({ expected, marker, grant }) {
  try {
    const good =
      grant.fresh === true &&
      grant.runId === expected.runId &&
      grant.runAttempt === expected.runAttempt &&
      Number.isSafeInteger(grant.assetId) &&
      grant.assetId > 0 &&
      ['version', 'runId', 'runAttempt', 'sha', 'integrity'].every((k) => marker[k] === expected[k]);
    return { mayPublish: good };
  } catch {
    return { mayPublish: false };
  }
}
function outputLines(result) {
  const rows = [];
  for (const [key, value] of Object.entries(result)) {
    if (!/^[a-z]+$/.test(key) || typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('output-shape');
    rows.push(`${key}=${value}\n`);
  }
  const text = rows.join('');
  // Application budget below GitHub's 1 MB/job UTF-16 limit. No truncation.
  if (Buffer.byteLength(text, 'utf16le') > 65536) throw new Error('output-limit');
  return text;
}
module.exports = {
  outputLines,
  validatePublishGrant,
  validSha,
  sameRepo,
  success,
  decideAuthority,
  decideCiReuse,
  decideProposalState,
  validateArtifactBinding,
  decideSubmission,
};
