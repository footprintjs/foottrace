import assert from 'node:assert/strict';
import { managedReleaseFixture, authorityWorld } from './helpers.mjs';
// Synthetic provider state only. No run, credential or source authority is asserted.
export function rcFixture() {
  const f = managedReleaseFixture({ version: '1.11.0', published: true }),
    api = f.api,
    base = '/repos/footprintjs/foottrace';
  f.context.eventName = 'workflow_dispatch';
  f.context.rc = true;
  f.context.bump = 'major';
  f.context.runAttempt = 2;
  f.app = authorityWorld().app;
  f.role = 'authority';
  f.run = {
    id: 500,
    run_attempt: 2,
    head_sha: f.context.sha,
    repository: f.repository,
    head_repository: f.repository,
    path: '.github/workflows/publish.yml',
    head_branch: 'main',
    event: 'workflow_dispatch',
    status: 'in_progress',
    conclusion: null,
  };
  f.jobs = ['authority', 'build', 'release', 'publish'].map((name, i) => ({
    id: 80 + i,
    name,
    run_id: 500,
    run_attempt: 2,
    head_sha: f.context.sha,
  }));
  f.setRole = (name) => {
    f.role = name;
    const at = ['authority', 'build', 'release', 'publish'].indexOf(name);
    f.jobs.forEach((j, i) => {
      j.status = i < at ? 'completed' : i === at ? 'in_progress' : 'queued';
      j.conclusion = i < at ? 'success' : null;
    });
  };
  f.setRole('authority');
  f.security = {
    id: 600,
    run_attempt: 1,
    workflow_id: 43,
    path: '.github/workflows/codeql.yml',
    head_sha: f.context.sha,
    head_branch: 'main',
    event: 'push',
    repository: f.repository,
    head_repository: f.repository,
    status: 'completed',
    conclusion: 'success',
  };
  f.securityJobs = ['Analyze (javascript-typescript)', 'Analyze (actions)'].map((name, i) => ({
    id: 90 + i,
    name,
    run_id: 600,
    run_attempt: 1,
    head_sha: f.context.sha,
    status: 'completed',
    conclusion: 'success',
  }));
  f.api = async (method, route, body) => {
    assert.equal(method, 'GET', 'Native source collection never mutates');
    let data;
    if (route === base + '/git/matching-refs/tags/v')
      data = [...f.tags].map(([tag, source]) => ({ ref: 'refs/tags/' + tag, object: { type: 'commit', sha: source } }));
    else if (route === '/apps/release-app') data = f.app.metadata;
    else if (route === base + '/actions/runs/500') data = f.run;
    else if (route === base + '/actions/runs/500/attempts/2/jobs?per_page=100&page=1')
      data = { total_count: f.jobs.length, jobs: f.jobs };
    else if (route === base + '/actions/workflows/codeql.yml') data = { id: 43, path: '.github/workflows/codeql.yml' };
    else if (
      route ===
      base + '/actions/workflows/43/runs?event=push&head_sha=' + f.context.sha + '&branch=main&per_page=100&page=1'
    )
      data = { total_count: 1, workflow_runs: [f.security] };
    else if (route === base + '/actions/runs/600/attempts/1') data = f.security;
    else if (route === base + '/actions/runs/600/attempts/1/jobs?per_page=100&page=1')
      data = { total_count: f.securityJobs.length, jobs: f.securityJobs };
    else return api(method, route, body);
    f.calls.push({ method, route, body });
    return { data };
  };
  return f;
}

export function rcWriteFixture() {
  const f = rcFixture(),
    read = f.api,
    base = '/repos/footprintjs/foottrace';
  f.hiddenTags = new Set();
  f.markerBodies = new Map();
  f.markerAssets = new Map();
  f.implicitTags = 0;
  f.api = async (method, route, body) => {
    const url = new URL(route.startsWith('https:') ? route : 'https://api.github.com' + route),
      path = url.pathname;
    const missing = () => {
      throw Object.assign(new Error('synthetic absent'), { status: 404 });
    };
    if (method === 'GET') {
      if (path.endsWith('/git/matching-refs/tags/v')) {
        f.calls.push({ method, route, body });
        return {
          data: [...f.tags]
            .filter(([tag]) => !f.hiddenTags.has(tag))
            .map(([tag, source]) => ({ ref: 'refs/tags/' + tag, object: { type: 'commit', sha: source } })),
        };
      }
      if (path.includes('/git/ref/tags/') && f.hiddenTags.has(decodeURIComponent(path.split('/').at(-1)))) {
        f.calls.push({ method, route, body });
        return missing();
      }
      if (/\/releases\/assets\/\d+$/.test(path) && f.markerAssets.has(Number(path.split('/').at(-1)))) {
        const id = Number(path.split('/').at(-1));
        f.calls.push({ method, route, body });
        return { data: body?.accept === 'application/octet-stream' ? f.markerBodies.get(id) : f.markerAssets.get(id) };
      }
      return read(method, route, body);
    }
    f.calls.push({ method, route, body });
    assert.equal(method, 'POST', 'The native RC writer has no overwrite or cleanup operation');
    if (path === base + '/git/refs') {
      const tag = body.ref.slice('refs/tags/'.length);
      if (f.tags.has(tag)) throw Object.assign(new Error('synthetic create collision'), { status: 422 });
      f.tags.set(tag, body.sha);
      if (f.uncertainTag) {
        f.uncertainTag = false;
        throw new Error('synthetic uncertain tag');
      }
      return { status: 201, data: f.badTagAck ? {} : { ref: body.ref, object: { type: 'commit', sha: body.sha } } };
    }
    if (path === base + '/releases') {
      if (f.releases.has(body.tag_name)) throw Object.assign(new Error('synthetic release collision'), { status: 422 });
      if (!f.tags.has(body.tag_name)) {
        f.tags.set(body.tag_name, body.target_commitish);
        f.implicitTags++;
      }
      const { make_latest, ...fields } = body;
      const id = 100 + f.releases.size,
        release = {
          id,
          ...fields,
          assets: [],
          upload_url: 'https://uploads.github.com' + base + '/releases/' + id + '/assets{?name,label}',
        };
      f.releases.set(body.tag_name, release);
      if (f.uncertainRelease) {
        f.uncertainRelease = false;
        throw new Error('synthetic uncertain release');
      }
      return {
        status: 201,
        data: f.badReleaseAck ? { ...release, target_commitish: '0000000000000000000000000000000000000000' } : release,
      };
    }
    if (url.origin === 'https://uploads.github.com' && /\/releases\/\d+\/assets$/.test(path)) {
      const id = Number(path.split('/').at(-2)),
        release = [...f.releases.values()].find((r) => r.id === id),
        name = url.searchParams.get('name');
      assert(release, 'Synthetic upload names an existing native release');
      assert(Buffer.isBuffer(body.raw));
      if (release.assets.some((a) => a.name === name))
        throw Object.assign(new Error('synthetic asset collision'), { status: 422 });
      const asset = { id: 200 + f.markerAssets.size, name, state: 'uploaded', size: body.raw.length };
      release.assets.push(asset);
      f.markerAssets.set(asset.id, asset);
      f.markerBodies.set(asset.id, Buffer.from(body.raw));
      if (f.uncertainMarker) {
        f.uncertainMarker = false;
        throw new Error('synthetic uncertain marker');
      }
      return { data: asset, status: 201 };
    }
    assert.fail('Unexpected synthetic native effect ' + route);
  };
  return f;
}
