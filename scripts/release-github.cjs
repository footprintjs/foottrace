'use strict';
const { prepareRelease } = require('./release-prepare.cjs');
const control = require('./release-control.cjs');
const fail = (code) => {
  const e = new Error(code);
  e.code = code;
  throw e;
};
const enc = encodeURIComponent;
const prefix = (context) => {
  if (context.repository?.full_name !== 'footprintjs/foottrace' || !Number.isSafeInteger(context.repository.id))
    fail('repository');
  return `/repos/${context.repository.full_name}`;
};
async function pages(api, route, key) {
  const result = [],
    seen = new Set();
  for (let page = 1; page <= 50; page++) {
    const response = await api('GET', `${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const rows = key ? response.data?.[key] : response.data;
    if (!Array.isArray(rows) || rows.length > 100) fail('incomplete-pages');
    for (const row of rows) {
      if (!Number.isSafeInteger(row.id) || seen.has(row.id)) fail('incomplete-pages');
      seen.add(row.id);
      result.push(row);
    }
    if (rows.length < 100) {
      if (key && response.data.total_count !== undefined && response.data.total_count !== result.length)
        fail('incomplete-pages');
      return result;
    }
  }
  fail('incomplete-pages');
}
async function assertCurrentMain(api, context) {
  const current = (await api('GET', `${prefix(context)}/git/ref/heads/main`)).data;
  if (current.object?.sha !== context.sha) fail('main-moved');
}
async function content(api, context, path) {
  if (!control.validSha(context.sha)) fail('source-sha');
  const data = (await api('GET', `${prefix(context)}/contents/${path}?ref=${context.sha}`)).data;
  if (
    data.type !== 'file' ||
    data.encoding !== 'base64' ||
    typeof data.content !== 'string' ||
    data.size > 2 * 1024 * 1024
  )
    fail('source-content');
  const bytes = Buffer.from(data.content, 'base64');
  if (bytes.length !== data.size) fail('source-content');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('source-content');
  }
}
async function sourceInput(api, context) {
  const commit = (await api('GET', `${prefix(context)}/git/commits/${context.sha}`)).data;
  if (commit.sha !== context.sha || !control.validSha(commit.tree?.sha)) fail('source-commit');
  const tree = (await api('GET', `${prefix(context)}/git/trees/${commit.tree.sha}?recursive=1`)).data;
  if (tree.truncated !== false || !Array.isArray(tree.tree)) fail('source-tree');
  const files = {};
  for (const path of ['package.json', 'package-lock.json', 'CHANGELOG.md', 'README.md', 'docs/metadata.md'])
    files[path] = await content(api, context, path);
  const fragments = {};
  for (const row of tree.tree.filter((x) => x.path.startsWith('.changes/') && x.path !== '.changes/README.md')) {
    const name = row.path.slice(9);
    if (
      row.type !== 'blob' ||
      row.mode !== '100644' ||
      !/^[a-z0-9][a-z0-9-]*\.md$/.test(name) ||
      Object.keys(fragments).length >= 100
    )
      fail('fragment-path');
    fragments[name] = await content(api, context, row.path);
  }
  const date = new Date(commit.committer?.date).toISOString().slice(0, 10);
  const prepared = prepareRelease({ files, fragments, date });
  return { commit, files, fragments, date, prepared };
}
async function plan(api, context) {
  if (
    !['push', 'workflow_dispatch'].includes(context.eventName) ||
    context.ref !== 'refs/heads/main' ||
    !control.validSha(context.sha)
  )
    fail('event');
  const repo = (await api('GET', prefix(context))).data;
  if (!control.sameRepo(repo, context.repository)) fail('repository');
  await assertCurrentMain(api, context);
  const input = await sourceInput(api, context),
    pkg = JSON.parse(input.files['package.json']);
  if (pkg.name !== 'foottrace') fail('package');
  if (context.verify === true && input.prepared) fail('verify-unreleased-main');
  const mode = context.verify === true ? 'verify' : input.prepared ? 'prepare' : 'publish';
  return {
    mode,
    repository: context.repository,
    sha: context.sha,
    tree: input.commit.tree.sha,
    version: input.prepared?.version ?? pkg.version,
    package: pkg.name,
    date: input.date,
  };
}
async function prepareProposal(api, context, pinned) {
  await assertCurrentMain(api, context);
  const input = await sourceInput(api, context);
  if (
    !input.prepared ||
    input.commit.tree.sha !== pinned.tree ||
    input.prepared.version !== pinned.version ||
    input.date !== pinned.date
  )
    fail('proposal-plan');
  return { base: context.sha, tree: pinned.tree, repository: context.repository, prepared: input.prepared };
}
async function collectAuthority(api, context, settings) {
  await assertCurrentMain(api, context);
  const base = prefix(context),
    commit = (await api('GET', `${base}/git/commits/${context.sha}`)).data;
  const linked = await pages(api, `${base}/commits/${context.sha}/pulls`);
  const candidates = linked.filter((p) => p.head?.ref === 'release/next' && p.merge_commit_sha === context.sha);
  if (candidates.length !== 1) fail('release-pr');
  const p = (await api('GET', `${base}/pulls/${candidates[0].number}`)).data;
  const headCommit = (await api('GET', `${base}/git/commits/${p.head.sha}`)).data;
  const reviews = await pages(api, `${base}/pulls/${p.number}/reviews`),
    reviewerPermissions = [];
  for (const user of new Map(reviews.filter((r) => r.user?.type === 'User').map((r) => [r.user.id, r.user])).values()) {
    const permission = (await api('GET', `${base}/collaborators/${enc(user.login)}/permission`)).data;
    reviewerPermissions.push(permission);
  }
  if (!/^[a-z0-9-]+$/.test(settings.slug ?? '') || typeof settings.clientId !== 'string' || !settings.clientId)
    fail('app-settings');
  const metadata = (await api('GET', `/apps/${enc(settings.slug)}`)).data;
  const bot = (await api('GET', `/users/${enc(settings.slug + '[bot]')}`)).data;
  const pkg = JSON.parse(await content(api, context, 'package.json'));
  const expected = {
    repository: context.repository,
    baseRef: 'main',
    headRef: 'release/next',
    mergeSha: context.sha,
    headSha: p.head.sha,
    tree: commit.tree.sha,
    package: pkg.name,
    version: pkg.version,
    tag: `v${pkg.version}`,
    pr: p.number,
  };
  const world = {
    expected,
    event: { name: context.eventName, ref: context.ref, sha: context.sha, repository: context.repository },
    commit,
    headCommit,
    app: { expectedClientId: settings.clientId, expectedSlug: settings.slug, metadata, bot },
    pullsComplete: true,
    reviewsComplete: true,
    permissionsComplete: true,
    pulls: [p],
    reviews,
    reviewerPermissions,
  };
  const result = control.decideAuthority(world);
  if (!result.authorized) fail(`authority-${result.reason}`);
  // The final mutable PR view must still bind the same exact reviewed head.
  const fresh = (await api('GET', `${base}/pulls/${p.number}`)).data;
  if (fresh.head?.sha !== p.head.sha || fresh.merge_commit_sha !== context.sha || !fresh.merged_at) fail('pr-moved');
  return expected;
}
async function workflowEvidence(api, identity, file) {
  const base = prefix(identity),
    workflow = (await api('GET', `${base}/actions/workflows/${file}`)).data;
  const runs = await pages(
    api,
    `${base}/actions/workflows/${workflow.id}/runs?event=pull_request&head_sha=${identity.headSha}`,
    'workflow_runs',
  );
  const selected = runs
    .filter(
      (r) =>
        r.head_sha === identity.headSha &&
        r.event === 'pull_request' &&
        control.sameRepo(r.head_repository, identity.repository),
    )
    .sort((a, b) => b.id - a.id)[0];
  if (!selected) return { workflow, runs, runsComplete: true, jobs: [], jobsComplete: true };
  const attempt = (await api('GET', `${base}/actions/runs/${selected.id}/attempts/${selected.run_attempt}`)).data;
  const jobs = await pages(api, `${base}/actions/runs/${selected.id}/attempts/${selected.run_attempt}/jobs`, 'jobs');
  return { workflow, runs, attempt, jobs, runsComplete: true, jobsComplete: true };
}
async function ciVerdict(api, identity) {
  try {
    return control.decideCiReuse({ expected: identity, ...(await workflowEvidence(api, identity, 'ci.yml')) });
  } catch {
    return { tested: false, fallback: 'both-full-runtime-gates', reason: 'evidence-unavailable' };
  }
}
async function requireSecurity(api, identity) {
  const w = await workflowEvidence(api, identity, 'codeql.yml'),
    r = [...w.runs].sort((a, b) => b.id - a.id)[0];
  if (
    w.workflow.path !== '.github/workflows/codeql.yml' ||
    !r ||
    r.head_sha !== identity.headSha ||
    r.event !== 'pull_request' ||
    !control.sameRepo(r.head_repository, identity.repository) ||
    r.workflow_id !== w.workflow.id ||
    r.path !== w.workflow.path ||
    !control.success(r) ||
    !control.success(w.attempt) ||
    w.attempt.id !== r.id ||
    w.attempt.run_attempt !== r.run_attempt
  )
    fail('security-run');
  for (const name of ['Analyze (javascript-typescript)', 'Analyze (actions)']) {
    const jobs = w.jobs.filter((j) => j.name === name);
    if (
      jobs.length !== 1 ||
      !control.success(jobs[0]) ||
      jobs[0].run_id !== r.id ||
      jobs[0].run_attempt !== r.run_attempt
    )
      fail('security-job');
  }
  return { runId: r.id, attempt: r.run_attempt };
}
async function reserveAttempt(api, release, marker) {
  if (
    !/^https:\/\/uploads\.github\.com\/repos\/footprintjs\/foottrace\/releases\/\d+\/assets\{\?name,label\}$/.test(
      release.upload_url ?? '',
    )
  )
    fail('release-upload-url');
  const url = release.upload_url.replace('{?name,label}', `?name=${enc(`publish-attempt-${marker.version}.json`)}`);
  const bytes = Buffer.from(JSON.stringify(marker) + '\n');
  const r = await api('POST', url, { raw: bytes, contentType: 'application/json' });
  if (r.data?.state !== 'uploaded' || r.data.size !== bytes.length || !Number.isSafeInteger(r.data.id))
    fail('reservation-ambiguous');
  return { assetId: r.data.id, fresh: true };
}
async function optional(api, route) {
  try {
    return (await api('GET', route)).data;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}
async function writeProposal(api, context, payload, pinned) {
  if (payload?.base !== context.sha || !control.sameRepo(payload.repository, context.repository)) fail('proposal-base');
  const rebuilt = await prepareProposal(api, context, pinned);
  if (JSON.stringify(payload) !== JSON.stringify(rebuilt)) fail('proposal-substitution');
  await assertCurrentMain(api, context);
  const base = prefix(context),
    entries = [];
  for (const [path, content] of Object.entries(rebuilt.prepared.updates)) {
    const blob = (await api('POST', `${base}/git/blobs`, { content, encoding: 'utf-8' })).data;
    if (!control.validSha(blob.sha)) fail('blob');
    entries.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  for (const path of rebuilt.prepared.deletions) entries.push({ path, mode: '100644', type: 'blob', sha: null });
  const tree = (await api('POST', `${base}/git/trees`, { base_tree: pinned.tree, tree: entries })).data;
  if (!control.validSha(tree.sha)) fail('proposal-tree');
  const ref = await optional(api, `${base}/git/ref/heads/release/next`);
  const existing = ref ? (await api('GET', `${base}/git/commits/${ref.object.sha}`)).data : null;
  const pulls = await pages(api, `${base}/pulls?state=open&head=footprintjs:release/next&base=main`);
  const state = control.decideProposalState({
    base: context.sha,
    currentMain: context.sha,
    expectedTree: tree.sha,
    existing: existing
      ? {
          head: existing.sha,
          parent: existing.parents?.length === 1 ? existing.parents[0].sha : null,
          tree: existing.tree?.sha,
        }
      : null,
    pulls,
    complete: true,
  });
  if (state.action === 'hold') fail('proposal-existing');
  if (state.action === 'no-op') return { action: 'no-op', pr: pulls[0].number };
  const commit = (
    await api('POST', `${base}/git/commits`, {
      message: `chore: release ${pinned.version}`,
      tree: tree.sha,
      parents: [context.sha],
    })
  ).data;
  if (!control.validSha(commit.sha)) fail('proposal-commit');
  await assertCurrentMain(api, context);
  await api('POST', `${base}/git/refs`, { ref: 'refs/heads/release/next', sha: commit.sha });
  await assertCurrentMain(api, context);
  const pr = (
    await api('POST', `${base}/pulls`, {
      title: `Release ${pinned.version}`,
      head: 'release/next',
      base: 'main',
      body: `Release App proposal for foottrace ${pinned.version}.\n\n${rebuilt.prepared.notes}\nAfter Claude's independent merge verdict for this exact head is recorded publicly and all current runtime/tested-tree/CodeQL checks pass, reconcile main/head/tested tree. The owner may submit personally or explicitly authorize Codex or Claude to submit the real GitHub APPROVED review on this final head through the owner's existing authorized User account, distinct from the App author, with current API permission write or admin. A delegated review names the submitting agent and the owner's explicit authorization. Standing FootTrace authorization remains sufficient within its stated scope; a changed head still requires fresh independent review, current checks and a fresh approval. An exchange verdict or comment is not that approval. No independent review is waived. No workflow auto-approval is added. This App-authored PR does not publish until normally merged and the Release App route verifies its authority. Owner App installation and npm trusted-publisher setup remain prerequisites; see docs/RELEASING.md.`,
    })
  ).data;
  if (!Number.isSafeInteger(pr.number)) fail('proposal-pr');
  return { action: 'created', pr: pr.number, head: commit.sha, tree: tree.sha };
}
async function producerIdentity(api, context, name, completed = false) {
  const run = (await api('GET', `${prefix(context)}/actions/runs/${context.runId}`)).data;
  if (
    run.id !== context.runId ||
    run.run_attempt !== context.runAttempt ||
    run.head_sha !== context.sha ||
    !control.sameRepo(run.repository, context.repository) ||
    !control.sameRepo(run.head_repository, context.repository) ||
    run.path !== '.github/workflows/publish.yml' ||
    run.head_branch !== 'main' ||
    run.event !== context.eventName ||
    context.ref !== 'refs/heads/main' ||
    !['push', 'workflow_dispatch'].includes(run.event) ||
    run.status !== 'in_progress' ||
    run.conclusion !== null
  )
    fail('current-run');
  const jobs = await pages(
    api,
    `${prefix(context)}/actions/runs/${context.runId}/attempts/${context.runAttempt}/jobs`,
    'jobs',
  );
  const chosen = jobs.filter((j) => j.name === name);
  if (chosen.length !== 1) fail('producer-job');
  const job = chosen[0];
  if (
    job.run_id !== context.runId ||
    job.run_attempt !== context.runAttempt ||
    job.head_sha !== context.sha ||
    (completed && !control.success(job))
  )
    fail('producer-attempt');
  return job;
}
async function readArtifact(api, context, pinned, artifactId, role) {
  const { readArtifactZip } = require('./release-archive.cjs');
  if (!Number.isSafeInteger(artifactId) || artifactId <= 0) fail('artifact-id');
  const artifact = (await api('GET', `${prefix(context)}/actions/artifacts/${artifactId}`)).data;
  const producer = await producerIdentity(api, context, role, true);
  const expected = {
    repositoryId: context.repository.id,
    runId: context.runId,
    runAttempt: context.runAttempt,
    jobId: producer.id,
    jobName: role,
    artifactId,
    artifactName: `foottrace-${context.repository.id}-${context.runId}-${context.runAttempt}-${role}`,
    sourceSha: context.sha,
    tree: pinned.tree,
    package: pinned.package,
    version: pinned.version,
  };
  // Reject the API envelope before downloading any artifact bytes.
  const preflight = { ...expected };
  if (
    !control.validateArtifactBinding({
      expected,
      artifact,
      producer: { ...producer, uploadArtifactId: artifactId },
      manifest: preflight,
    }).valid
  )
    fail('artifact-source');
  const downloaded = (await api('GET', `${prefix(context)}/actions/artifacts/${artifactId}/zip`)).data;
  const members = readArtifactZip(
    Buffer.from(downloaded),
    role === 'prepare' ? ['manifest.json', 'proposal.json'] : ['manifest.json', 'package.tgz'],
  );
  const manifest = JSON.parse(members['manifest.json'].toString('utf8'));
  if (
    !control.validateArtifactBinding({
      expected,
      artifact,
      producer: { ...producer, uploadArtifactId: artifactId },
      manifest,
    }).valid
  )
    fail('artifact-manifest');
  return { manifest, members };
}
async function peeledTag(api, context, tag) {
  let ref = await optional(api, `${prefix(context)}/git/ref/tags/${enc(tag)}`);
  if (!ref) return null;
  let object = ref.object;
  for (let i = 0; i < 5; i++) {
    if (object?.type === 'commit' && control.validSha(object.sha)) return object.sha;
    if (object?.type !== 'tag' || !control.validSha(object.sha)) fail('tag-shape');
    object = (await api('GET', `${prefix(context)}/git/tags/${object.sha}`)).data.object;
  }
  fail('tag-depth');
}
async function sourceReleaseNotes(api, context, version) {
  const changelog = await content(api, context, 'CHANGELOG.md');
  const lines = changelog.split('\n');
  const sections = lines.map((line, index) => ({ line, index })).filter((row) => row.line.startsWith('## '));
  const prefix = `## ${version} — `;
  const matching = sections.filter((row) => row.line.startsWith(prefix));
  if (!changelog.startsWith('# Changelog\n\n') || matching.length !== 1 || sections[0] !== matching[0])
    fail('release-notes');
  const date = matching[0].line.slice(prefix.length);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(new Date(date).getTime()) ||
    new Date(date).toISOString().slice(0, 10) !== date
  )
    fail('release-notes');
  const end = sections[1]?.index ?? lines.length;
  const body = lines
    .slice(matching[0].index + 1, end)
    .join('\n')
    .trim();
  if (!body) fail('release-notes');
  return body + '\n';
}
function requireReleaseNotes(release, context, tag, notes) {
  if (
    release.tag_name !== tag ||
    release.target_commitish !== context.sha ||
    release.body !== notes ||
    release.draft !== false ||
    release.prerelease !== false
  )
    fail('release-conflict');
}
async function releaseState(api, context, identity, archive, registry) {
  await assertCurrentMain(api, context);
  const base = prefix(context),
    name = `publish-attempt-${identity.version}.json`;
  const marker = {
    version: identity.version,
    runId: context.runId,
    runAttempt: context.runAttempt,
    sha: context.sha,
    integrity: archive.integrity,
  };
  const existingTag = await peeledTag(api, context, identity.tag);
  if (existingTag && existingTag !== context.sha) fail('tag-conflict');
  let release = await optional(api, `${base}/releases/tags/${enc(identity.tag)}`);
  const notes = await sourceReleaseNotes(api, context, identity.version);
  if (release) requireReleaseNotes(release, context, identity.tag, notes);
  const assets = release ? await pages(api, `${base}/releases/${release.id}/assets`) : [];
  const matching = assets.filter((a) => a.name === name);
  if (matching.length > 1) fail('journal-conflict');
  const decision = control.decideSubmission({ journal: matching[0] ?? null, registry, expected: marker });
  if (decision.action === 'hold') fail('registry-conflict');
  if (decision.action === 'verify-only')
    return { fresh: false, assetId: matching[0]?.id ?? null, runId: context.runId, runAttempt: context.runAttempt };
  await assertCurrentMain(api, context);
  if (!existingTag) await api('POST', `${base}/git/refs`, { ref: `refs/tags/${identity.tag}`, sha: context.sha });
  if (!release)
    release = (
      await api('POST', `${base}/releases`, {
        tag_name: identity.tag,
        target_commitish: context.sha,
        name: identity.tag,
        body: notes,
        draft: false,
        prerelease: false,
      })
    ).data;
  const reserved = await reserveAttempt(api, release, marker);
  return { ...reserved, runId: context.runId, runAttempt: context.runAttempt };
}
async function publishGrant(api, context, identity, archive, grant) {
  await assertCurrentMain(api, context);
  if (!Number.isSafeInteger(grant.assetId)) fail('journal-asset');
  const asset = (await api('GET', `${prefix(context)}/releases/assets/${grant.assetId}`)).data;
  if (asset.name !== `publish-attempt-${identity.version}.json` || asset.state !== 'uploaded' || asset.size > 4096)
    fail('journal-asset');
  const raw = (
    await api('GET', `${prefix(context)}/releases/assets/${grant.assetId}`, { accept: 'application/octet-stream' })
  ).data;
  const marker = JSON.parse(Buffer.from(raw).toString('utf8'));
  const expected = {
    version: identity.version,
    runId: context.runId,
    runAttempt: context.runAttempt,
    sha: context.sha,
    integrity: archive.integrity,
  };
  if (!control.validatePublishGrant({ expected, marker, grant }).mayPublish) fail('journal-grant');
  if ((await peeledTag(api, context, identity.tag)) !== context.sha) fail('tag-conflict');
  return true;
}
async function responseBytes(response, max = 24 * 1024 * 1024) {
  if (Number(response.headers.get('content-length') ?? 0) > max) fail('response-limit');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > max) fail('response-limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
function makeApi(token, fetcher = fetch) {
  return async (method, route, body) => {
    if (
      !(
        route.startsWith('/repos/footprintjs/foottrace/') ||
        route === '/repos/footprintjs/foottrace' ||
        route.startsWith('/apps/') ||
        route.startsWith('/users/') ||
        route.startsWith('https://uploads.github.com/repos/footprintjs/foottrace/releases/')
      )
    )
      fail('api-route');
    const headers = {
      authorization: `Bearer ${token}`,
      accept: body?.accept ?? 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    };
    const options = { method, headers, signal: AbortSignal.timeout(30000) };
    if (body?.raw) {
      headers['content-type'] = body.contentType;
      options.body = body.raw;
    } else if (body && !body.accept) {
      headers['content-type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const response = await fetcher(route.startsWith('https:') ? route : `https://api.github.com${route}`, options);
    if (!response.ok) {
      const error = new Error('github-api-failed');
      error.status = response.status;
      throw error;
    }
    const bytes = await responseBytes(response);
    return {
      data:
        body?.accept !== 'application/octet-stream' &&
        !route.endsWith('/zip') &&
        response.headers.get('content-type')?.includes('json')
          ? JSON.parse(bytes.toString('utf8'))
          : bytes,
    };
  };
}
async function registryVersion(version, fetcher = fetch) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) fail('version');
  const response = await fetcher(`https://registry.npmjs.org/foottrace/${version}`, {
    signal: AbortSignal.timeout(30000),
  });
  if (response.status === 404) return null;
  if (!response.ok) fail('registry-unavailable');
  const value = JSON.parse((await responseBytes(response, 2 * 1024 * 1024)).toString('utf8'));
  if (value.name !== 'foottrace' || value.version !== version || typeof value.dist?.integrity !== 'string')
    fail('registry-shape');
  return { ...value.dist, version: value.version };
}
async function verifyPublished(api, context, pinned, fetcher = fetch) {
  const tag = `v${pinned.version}`,
    base = prefix(context),
    release = await optional(api, `${base}/releases/tags/${enc(tag)}`);
  if (!release) return { state: 'pending-release' };
  const notes = await sourceReleaseNotes(api, context, pinned.version);
  requireReleaseNotes(release, context, tag, notes);
  if ((await peeledTag(api, context, tag)) !== context.sha) fail('release-conflict');
  const assets = await pages(api, `${base}/releases/${release.id}/assets`),
    markers = assets.filter((a) => a.name === `publish-attempt-${pinned.version}.json`);
  if (markers.length !== 1 || markers[0].state !== 'uploaded' || markers[0].size > 4096) fail('journal-conflict');
  const marker = JSON.parse(
    Buffer.from(
      (await api('GET', `${base}/releases/assets/${markers[0].id}`, { accept: 'application/octet-stream' })).data,
    ).toString('utf8'),
  );
  if (marker.sha !== context.sha || marker.version !== pinned.version) fail('journal-conflict');
  const registry = await registryVersion(pinned.version, fetcher);
  if (!registry) return { state: 'pending-registry' };
  if (
    registry.integrity !== marker.integrity ||
    registry.tarball !== `https://registry.npmjs.org/foottrace/-/foottrace-${pinned.version}.tgz`
  )
    fail('registry-conflict');
  const response = await fetcher(registry.tarball, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) fail('registry-unavailable');
  const archive = require('./release-archive.cjs').inspectArchive(await responseBytes(response, 16 * 1024 * 1024), {
    package: 'foottrace',
    version: pinned.version,
  });
  if (archive.integrity !== marker.integrity || archive.shasum !== registry.shasum) fail('registry-bytes');
  const latestResponse = await fetcher('https://registry.npmjs.org/foottrace/latest', {
    signal: AbortSignal.timeout(30000),
  });
  if (!latestResponse.ok) fail('registry-unavailable');
  const latest = JSON.parse((await responseBytes(latestResponse, 2 * 1024 * 1024)).toString('utf8'));
  return {
    state: latest.version === pinned.version ? 'verified' : 'pending-latest',
    version: pinned.version,
    latest: latest.version,
    sha: context.sha,
    integrity: archive.integrity,
    shasum: archive.shasum,
    sha256: archive.sha256,
    provenance: registry.attestations ?? null,
    provenanceCryptographicallyVerified: false,
    docs: 'No separate FootTrace docs deployment is configured.',
  };
}
function environmentContext(env) {
  const context = {
    repository: { id: Number(env.REPO_ID), full_name: env.REPO_NAME },
    sha: env.SOURCE_SHA,
    ref: env.SOURCE_REF,
    eventName: env.EVENT_NAME,
    runId: Number(env.RUN_ID),
    runAttempt: Number(env.RUN_ATTEMPT),
    verify: env.VERIFY_ONLY === 'true',
  };
  prefix(context);
  if (
    !control.validSha(context.sha) ||
    !Number.isSafeInteger(context.runId) ||
    context.runId <= 0 ||
    !Number.isSafeInteger(context.runAttempt) ||
    context.runAttempt <= 0
  )
    fail('context');
  return context;
}
async function runStage(stage, { api, context, env, io, fetcher = fetch }) {
  const pinned = env.PLAN_JSON ? JSON.parse(env.PLAN_JSON) : null;
  const identity = env.IDENTITY_JSON ? JSON.parse(env.IDENTITY_JSON) : null;
  const settings = { slug: env.APP_SLUG, clientId: env.APP_CLIENT_ID };
  const bound = () => {
    if (!pinned || pinned.sha !== context.sha || !control.sameRepo(pinned.repository, context.repository))
      fail('plan-substitution');
  };
  const freshAuthority = async () => {
    const fresh = await collectAuthority(api, context, settings);
    if (JSON.stringify(fresh) !== JSON.stringify(identity)) fail('identity-changed');
    await requireSecurity(api, fresh);
  };
  if (stage === 'plan') {
    const p = await plan(api, context);
    return { plan: JSON.stringify(p), mode: p.mode };
  }
  bound();
  if (stage === 'prepare') {
    const proposal = await prepareProposal(api, context, pinned),
      job = await producerIdentity(api, context, 'prepare');
    io.write('release-artifact/proposal.json', Buffer.from(JSON.stringify(proposal) + '\n'));
    io.write(
      'release-artifact/manifest.json',
      Buffer.from(
        JSON.stringify({
          repositoryId: context.repository.id,
          runId: context.runId,
          runAttempt: context.runAttempt,
          jobId: job.id,
          sourceSha: context.sha,
          tree: pinned.tree,
          package: pinned.package,
          version: pinned.version,
        }) + '\n',
      ),
    );
    return {};
  }
  if (stage === 'proposal') {
    const artifact = await readArtifact(api, context, pinned, Number(env.ARTIFACT_ID), 'prepare');
    return {
      proposal: JSON.stringify(
        await writeProposal(api, context, JSON.parse(artifact.members['proposal.json'].toString('utf8')), pinned),
      ),
    };
  }
  if (stage === 'authority') {
    const id = await collectAuthority(api, context, settings);
    if (id.tree !== pinned.tree || id.version !== pinned.version) fail('authority-plan');
    await requireSecurity(api, id);
    return { identity: JSON.stringify(id), authorized: 'true' };
  }
  if (stage === 'verdict') {
    if (!identity || identity.mergeSha !== context.sha || identity.tree !== pinned.tree) fail('identity');
    return { tested: String((await ciVerdict(api, identity)).tested) };
  }
  if (stage === 'build-manifest') {
    if (io.gitTree() !== pinned.tree) fail('build-tree');
    io.requireClean();
    const pkg = JSON.parse(io.read('package.json')),
      lock = JSON.parse(io.read('package-lock.json'));
    if (
      pkg.name !== pinned.package ||
      pkg.version !== pinned.version ||
      lock.version !== pkg.version ||
      lock.packages?.[''].version !== pkg.version
    )
      fail('package-version');
    const pack = JSON.parse(io.read('pack.json'));
    if (!Array.isArray(pack) || pack.length !== 1 || pack[0].filename !== `foottrace-${pinned.version}.tgz`)
      fail('pack-identity');
    const bytes = io.read(pack[0].filename),
      archive = require('./release-archive.cjs').inspectArchive(bytes, {
        package: pinned.package,
        version: pinned.version,
      }),
      job = await producerIdentity(api, context, 'build');
    io.write('release-artifact/package.tgz', bytes);
    io.write(
      'release-artifact/manifest.json',
      Buffer.from(
        JSON.stringify({
          repositoryId: context.repository.id,
          runId: context.runId,
          runAttempt: context.runAttempt,
          jobId: job.id,
          sourceSha: context.sha,
          tree: pinned.tree,
          package: pinned.package,
          version: pinned.version,
          sha256: archive.sha256,
          integrity: archive.integrity,
          shasum: archive.shasum,
        }) + '\n',
      ),
    );
    return {};
  }
  if (stage === 'release' || stage === 'publish') {
    await freshAuthority();
    const artifact = await readArtifact(api, context, pinned, Number(env.ARTIFACT_ID), 'build'),
      bytes = artifact.members['package.tgz'],
      archive = require('./release-archive.cjs').inspectArchive(bytes, {
        package: pinned.package,
        version: pinned.version,
      });
    if (
      artifact.manifest.integrity !== archive.integrity ||
      artifact.manifest.sha256 !== archive.sha256 ||
      artifact.manifest.shasum !== archive.shasum
    )
      fail('archive-manifest');
    const registry = await registryVersion(pinned.version, fetcher);
    if (stage === 'release') {
      const grant = await releaseState(api, context, identity, archive, registry);
      return { grant: JSON.stringify(grant), fresh: String(grant.fresh) };
    }
    const grant = JSON.parse(env.GRANT_JSON ?? 'null');
    await publishGrant(api, context, identity, archive, grant);
    if (registry) {
      if (registry.integrity !== archive.integrity) fail('registry-conflict');
      return { submit: 'false' };
    }
    const file = io.publishFile(context.runId, context.runAttempt);
    io.write(file, bytes);
    return { submit: 'true', file };
  }
  if (stage === 'verify') return { verification: JSON.stringify(await verifyPublished(api, context, pinned, fetcher)) };
  fail('stage');
}
module.exports = {
  sourceReleaseNotes,
  requireReleaseNotes,
  makeApi,
  registryVersion,
  verifyPublished,
  environmentContext,
  runStage,
  optional,
  writeProposal,
  producerIdentity,
  readArtifact,
  peeledTag,
  releaseState,
  publishGrant,
  pages,
  assertCurrentMain,
  content,
  sourceInput,
  plan,
  prepareProposal,
  collectAuthority,
  workflowEvidence,
  ciVerdict,
  requireSecurity,
  reserveAttempt,
};
