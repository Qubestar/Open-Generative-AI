// Shared Repurpose orchestration for both MCP transports.
//
// The service is deliberately longer-lived than an individual MCP request. It
// owns only processes it starts, while all durable truth remains in
// RepurposeProject and JobStore on disk.

import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_REPURPOSE_ENGINE_DIR,
  DEFAULT_REPURPOSE_PYTHON,
  JobStore,
  REPURPOSE_JOB_TYPE,
  REPURPOSE_STAGES,
  RepurposeProject,
  cancelRepurposeJob,
  createRepurposeJob,
  runRepurposeJob,
} from '../../packages/core/index.js';

const ANALYSIS_STAGES = REPURPOSE_STAGES.filter(stage => stage !== 'render');
const MAX_PROJECT_JOBS = 20;
const MAX_CANDIDATES = 100;
const MAX_LOGS = 5;
const MAX_TEXT = 1000;
const MAX_ARTIFACT_JSON = 4 * 1024 * 1024;
const MAX_STRUCTURED_FIELD = 16 * 1024;

const bounded = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

function boundedJson(value) {
  if (value === null || value === undefined) return null;
  try {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > MAX_STRUCTURED_FIELD) return { truncated: true };
    return JSON.parse(encoded);
  } catch { return null; }
}

function absolutePath(value, label) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute local path`);
  }
  return path.resolve(value);
}

function relativeProjectPath(projectDir, value) {
  if (typeof value !== 'string' || !value) return null;
  const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(projectDir, value);
  const relative = path.relative(projectDir, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function publicJob(job, active = false) {
  const projectDir = path.resolve(job.params?.projectDir || '');
  const workerActive = active || (job.state === 'running' && processIsAlive(job.checkpoints?.childProcess?.pid));
  return {
    contract_version: 1,
    id: job.id,
    state: job.state,
    stage: job.params?.stage || null,
    active: workerActive,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    started_at: job.startedAt,
    ended_at: job.endedAt,
    progress: boundedJson(job.checkpoints?.progress),
    active_substep: job.checkpoints?.activeSubstep?.id || null,
    artifacts: (job.artifacts || []).map(item => ({
      kind: item.kind,
      path: relativeProjectPath(projectDir, item.path),
      created_at: item.createdAt,
    })).filter(item => item.path),
    log_tail: (job.logs || []).slice(-MAX_LOGS).map(item => ({
      at: item.at,
      message: bounded(item.message),
    })),
    error: job.error ? bounded(job.error) : null,
    recovery: job.state === 'running' && !workerActive
      ? 'Call repurpose_analyze or repurpose_render for this project to resume the persisted job.'
      : job.state === 'error'
        ? 'The completed prerequisites are preserved. Retry the same stage from the project tool.'
        : null,
  };
}

function readArtifact(projectDir, relativePath) {
  const file = path.resolve(projectDir, relativePath);
  const relation = path.relative(projectDir, file);
  if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) return null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_JSON) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function artifactCandidateMap(projectDir, relativePath) {
  const artifact = readArtifact(projectDir, relativePath);
  return new Map((artifact?.candidates || []).map(item => [item.candidate_id, item]));
}

function projectCandidateSummaries(project) {
  const dir = path.resolve(project.dir);
  const boundary = artifactCandidateMap(dir, 'artifacts/boundary-artifact.v1.json');
  const reframeV1 = artifactCandidateMap(dir, 'artifacts/reframe-artifact.v1.json');
  const reframeV2 = artifactCandidateMap(dir, 'artifacts/reframe-artifact.v2.json');
  const render = artifactCandidateMap(dir, 'artifacts/render-artifact.v1.json');
  return project.manifest.candidates.slice(0, MAX_CANDIDATES).map(candidate => {
    const cut = boundary.get(candidate.id);
    const vertical = reframeV2.get(candidate.id)?.output || reframeV1.get(candidate.id)?.output;
    const sourcePreview = cut?.extraction;
    const preview = [vertical, sourcePreview].find(item => item?.state === 'completed' && item.path);
    const exports = (render.get(candidate.id)?.exports || []).slice(0, 20).map(item => ({
      preset: item.preset_id || null,
      path: typeof item.output?.path === 'string' ? item.output.path : null,
      duration_seconds: item.output?.duration_seconds ?? null,
      width: item.output?.width ?? null,
      height: item.output?.height ?? null,
    })).filter(item => item.path);
    const ranking = candidate.metadata?.ranking || null;
    return {
      id: candidate.id,
      decision: candidate.decision,
      selected: candidate.selected,
      title: bounded(candidate.metadata?.title),
      hook: bounded(candidate.metadata?.hook),
      summary: bounded(candidate.metadata?.summary),
      selection_reason: bounded(candidate.metadata?.selection_reason),
      proposed_start_seconds: candidate.proposed_start_sec,
      proposed_end_seconds: candidate.proposed_end_sec,
      repaired_start_seconds: cut?.repaired_span?.start_seconds ?? null,
      repaired_end_seconds: cut?.repaired_span?.end_seconds ?? null,
      rank: ranking?.rank ?? null,
      recommended: ranking?.recommended ?? false,
      score: ranking?.score ?? ranking?.total_score ?? null,
      score_breakdown: boundedJson(ranking?.score_breakdown || ranking?.components),
      preview_path: relativeProjectPath(dir, preview?.path),
      exports: exports.map(item => ({ ...item, path: relativeProjectPath(dir, item.path) }))
        .filter(item => item.path),
    };
  });
}

export function createRepurposeMcpService({
  jobsDir = undefined,
  secrets = () => '',
  python = DEFAULT_REPURPOSE_PYTHON,
  engineDir = DEFAULT_REPURPOSE_ENGINE_DIR,
  runJob = runRepurposeJob,
} = {}) {
  const active = new Map();
  const store = () => new JobStore(jobsDir);

  function projectJobs(projectDir) {
    const resolved = path.resolve(projectDir);
    return store().list({ type: REPURPOSE_JOB_TYPE })
      .filter(job => path.resolve(job.params?.projectDir || '') === resolved);
  }

  function requireProject(projectDir) {
    const resolved = absolutePath(projectDir, 'project_dir');
    return RepurposeProject.load(resolved);
  }

  function ensureIdle(projectDir) {
    const busy = projectJobs(projectDir).find(job => ['queued', 'running'].includes(job.state));
    if (busy) throw new Error(`Project has ${busy.state} ${busy.params.stage} job ${busy.id}; wait for it to finish before changing candidate review`);
  }

  function launch(jobId) {
    if (active.has(jobId)) return active.get(jobId).promise;
    const jobStore = store();
    const job = jobStore.get(jobId);
    if (!job || job.type !== REPURPOSE_JOB_TYPE) throw new Error(`No such Repurpose job: ${jobId}`);
    const entry = { child: null, promise: null };
    active.set(jobId, entry);
    const openRouterKey = ['generate_candidates', 'rank'].includes(job.params.stage)
      ? secrets('openrouter')
      : '';
    entry.promise = runJob(jobStore, jobId, {
      python,
      engineDir,
      extraEnv: openRouterKey ? { OPENROUTER_API_KEY: openRouterKey } : {},
      onChild: child => { entry.child = child; },
    }).finally(() => active.delete(jobId));
    return entry.promise;
  }

  function summarize(projectDir) {
    const project = requireProject(projectDir);
    const manifest = project.manifest;
    return {
      contract_version: 1,
      project_dir: path.resolve(project.dir),
      project_id: manifest.id,
      source: { type: manifest.source.type, uri: manifest.source.uri, fingerprint: manifest.source.fingerprint },
      requested_clip_count: manifest.requested_clip_count,
      content_type: manifest.content_type,
      target_platforms: manifest.target_platforms,
      render_defaults: manifest.render_defaults,
      stages: manifest.stages,
      candidate_counts: {
        total: manifest.candidates.length,
        approved: manifest.candidates.filter(item => item.decision === 'approved').length,
        selected: manifest.candidates.filter(item => item.selected).length,
      },
      outputs: manifest.outputs.slice(0, 100),
      jobs: projectJobs(project.dir).slice(0, MAX_PROJECT_JOBS)
        .map(job => publicJob(job, active.has(job.id))),
    };
  }

  function startOrResume(project, stage, options) {
    const currentJobs = projectJobs(project.dir);
    const persisted = currentJobs.find(job => job.params?.stage === stage && job.state === 'running');
    if (persisted) {
      if (publicJob(persisted, active.has(persisted.id)).active) {
        return { job: publicJob(persisted, active.has(persisted.id)), resumed: false };
      }
      void launch(persisted.id).catch(() => {});
      return { job: publicJob(store().get(persisted.id), true), resumed: true };
    }
    const queued = currentJobs.find(job => job.params?.stage === stage && job.state === 'queued');
    if (queued) {
      void launch(queued.id).catch(() => {});
      return { job: publicJob(store().get(queued.id), true), resumed: false };
    }
    const otherBusy = currentJobs.find(job => ['queued', 'running'].includes(job.state));
    if (otherBusy) throw new Error(`Project already has ${otherBusy.state} ${otherBusy.params.stage} job ${otherBusy.id}`);
    const job = createRepurposeJob(store(), { projectDir: project.dir, stage, options });
    void launch(job.id).catch(() => {});
    return { job: publicJob(store().get(job.id), true), resumed: false };
  }

  return {
    active,

    create({ projectDir, sourcePath, requestedClipCount, contentType, targetPlatforms, renderDefaults }) {
      const dir = absolutePath(projectDir, 'project_dir');
      const source = absolutePath(sourcePath, 'source_path');
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error('source_path must name an existing local file');
      if (fs.existsSync(dir)) {
        if (!fs.statSync(dir).isDirectory()) throw new Error('project_dir must be a directory');
        if (fs.readdirSync(dir).length) throw new Error('project_dir must be empty; Vidmyo will not overwrite existing files');
      }
      RepurposeProject.create(dir, {
        source: { type: 'local_file', uri: source },
        requestedClipCount,
        contentType,
        targetPlatforms,
        renderDefaults,
      });
      return summarize(dir);
    },

    get({ projectDir }) {
      return summarize(projectDir);
    },

    analyze({ projectDir, stage = null, options = {} }) {
      const project = requireProject(projectDir);
      const next = ANALYSIS_STAGES.find(name => project.manifest.stages[name].state !== 'completed');
      if (!next) throw new Error('Analysis is already complete; review candidates and call repurpose_render when ready');
      if (stage && stage !== next) throw new Error(`The next analysis stage is ${next}; stages cannot be skipped or rerun`);
      const record = project.manifest.stages[next];
      if (!['pending', 'failed', 'running'].includes(record.state)) throw new Error(`${next} cannot start from ${record.state}`);
      return { contract_version: 1, project_dir: path.resolve(project.dir), stage: next, ...startOrResume(project, next, options) };
    },

    listCandidates({ projectDir, decision = null, selected = null, limit = 50 }) {
      const project = requireProject(projectDir);
      const all = projectCandidateSummaries(project)
        .filter(item => (decision ? item.decision === decision : true))
        .filter(item => (selected === null ? true : item.selected === selected));
      return {
        contract_version: 1,
        project_dir: path.resolve(project.dir),
        total: all.length,
        candidates: all.slice(0, limit),
        publishing_allowed: false,
      };
    },

    setCandidateDecision({ projectDir, candidateId, action }) {
      const project = requireProject(projectDir);
      ensureIdle(project.dir);
      if (action === 'approve') project.setCandidateDecision(candidateId, 'approved');
      else if (action === 'reject') project.setCandidateDecision(candidateId, 'rejected');
      else if (action === 'reset') project.setCandidateDecision(candidateId, 'pending');
      else if (action === 'select') project.selectCandidate(candidateId, true);
      else if (action === 'unselect') project.selectCandidate(candidateId, false);
      else throw new Error(`Unknown candidate action: ${action}`);
      return {
        contract_version: 1,
        project_dir: path.resolve(project.dir),
        candidate: projectCandidateSummaries(RepurposeProject.load(project.dir))
          .find(item => item.id === candidateId),
        publishing_allowed: false,
      };
    },

    render({ projectDir, candidateIds = null, captionsEnabled = true, captionStyle = 'clean', platforms = null }) {
      const project = requireProject(projectDir);
      const existing = projectJobs(project.dir).find(job => job.params?.stage === 'render'
        && ['queued', 'running'].includes(job.state));
      if (existing) {
        return {
          contract_version: 1,
          project_dir: path.resolve(project.dir),
          stage: 'render',
          publishing_allowed: false,
          ...startOrResume(project, 'render', existing.params.options || {}),
        };
      }
      ensureIdle(project.dir);
      if (project.manifest.stages.reframe.state !== 'completed') throw new Error('Finish analysis through reframe before rendering');
      if (!['pending', 'failed'].includes(project.manifest.stages.render.state)) {
        throw new Error(`Render cannot start from ${project.manifest.stages.render.state}`);
      }
      if (candidateIds) {
        const wanted = new Set(candidateIds);
        const unknown = [...wanted].filter(id => !project.manifest.candidates.some(item => item.id === id));
        if (unknown.length) throw new Error(`Unknown candidates: ${unknown.join(', ')}`);
        const unapproved = project.manifest.candidates.filter(item => wanted.has(item.id) && item.decision !== 'approved');
        if (unapproved.length) throw new Error(`Cannot render ${unapproved[0].id}: candidate is not approved`);
        for (const candidate of project.manifest.candidates) {
          const shouldSelect = wanted.has(candidate.id);
          if (candidate.selected !== shouldSelect) project.selectCandidate(candidate.id, shouldSelect);
        }
      }
      if (!project.canRender()) throw new Error('Approve and select at least one candidate before rendering');
      const options = {
        candidate_ids: project.manifest.candidates.filter(item => item.selected).map(item => item.id),
        captions_enabled: captionsEnabled,
        caption_style: captionStyle,
        platforms: platforms || project.manifest.target_platforms,
      };
      return {
        contract_version: 1,
        project_dir: path.resolve(project.dir),
        stage: 'render',
        publishing_allowed: false,
        ...startOrResume(project, 'render', options),
      };
    },

    getJob({ jobId }) {
      const job = store().get(jobId);
      if (!job || job.type !== REPURPOSE_JOB_TYPE) throw new Error(`No such Repurpose job: ${jobId}`);
      return publicJob(job, active.has(jobId));
    },

    async close() {
      const jobStore = store();
      for (const [jobId, entry] of [...active.entries()]) {
        try {
          cancelRepurposeJob(jobStore, jobId, {
            terminate: entry.child ? () => entry.child.kill('SIGTERM') : null,
          });
        } catch { /* terminal race */ }
      }
      await Promise.allSettled([...active.values()].map(entry => entry.promise));
    },
  };
}
