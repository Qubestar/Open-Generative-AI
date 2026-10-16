// Shared Translate Video orchestration for both MCP transports.
//
// This is a thin, bounded adapter — it owns no pipeline logic of its own. It
// creates the same `translate` job the desktop Translate tab creates, launches
// the same `runTranslateJob`, and reports the same project manifest. Durable
// truth lives in JobStore + the translate project on disk, so a job started from
// MCP can be inspected (or retried) from the desktop and vice versa.

import fs from 'node:fs';
import path from 'node:path';

import {
  JobStore,
  TranslateProject,
  TranslateService,
  TRANSLATE_JOB_TYPE,
  createTranslateEngines,
  normalizeTranslateOptions,
  runTranslateJob,
} from '../../packages/core/index.js';

const MAX_TEXT = 1000;
const MAX_LOGS = 5;
const MAX_OUTPUTS = 40;
const MAX_WARNINGS = 20;
const MAX_STAGES = 20;

const bounded = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

function relativeProjectPath(projectDir, value) {
  if (typeof value !== 'string' || !value) return null;
  const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(projectDir, value);
  const relative = path.relative(path.resolve(projectDir), resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

function publicJob(service, jobId) {
  const state = service.get(jobId);
  if (!state) return null;
  const { job, summary, project } = state;
  const projectDir = project?.dir || job.params?.projectDir || '';
  const outputs = (summary.outputs || []).slice(0, MAX_OUTPUTS).map(output => ({
    kind: output.kind,
    artifact: output.artifact,
    bytes: output.bytes ?? null,
    language: output.language || null,
  }));
  const metrics = job.checkpoints?.metrics || null;
  return {
    contract_version: 1,
    job_id: job.id,
    project_dir: projectDir || null,
    state: job.state,
    stage: summary.stage,
    stage_label: summary.stage_label,
    progress: summary.progress,
    stages: (summary.stages || []).slice(0, MAX_STAGES),
    source_language: summary.source_language,
    target_language: summary.target_language,
    options: summary.options,
    outputs,
    output_paths: projectDir
      ? outputs.map(output => relativeProjectPath(projectDir, path.join(projectDir, output.artifact))).filter(Boolean)
      : [],
    warnings: (summary.warnings || []).slice(-MAX_WARNINGS).map(bounded),
    error: job.error ? bounded(job.error) : null,
    retryable: job.state === 'error' && Boolean(summary.stages?.some(entry => entry.status === 'failed')),
    timings: metrics?.stages || null,
    total_ms: metrics?.totalMs ?? null,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    ended_at: job.endedAt,
    log_tail: (job.logs || []).slice(-MAX_LOGS).map(entry => ({ at: entry.at, message: bounded(entry.message) })),
  };
}

export function createTranslateMcpService({
  store = null,
  service = null,
  engines = null,
  projectsDir = null,
} = {}) {
  const jobStore = store || new JobStore();
  const engineSet = engines || createTranslateEngines();
  const translate = service || new TranslateService({
    store: jobStore,
    engines: engineSet,
    ...(projectsDir ? { projectsDir } : {}),
  });
  const active = new Map();

  function launch(jobId) {
    if (active.has(jobId)) return active.get(jobId).promise;
    const controller = new AbortController();
    const entry = { controller, promise: null };
    active.set(jobId, entry);
    entry.promise = runTranslateJob(jobStore, jobId, { engines: engineSet, signal: controller.signal })
      .catch(() => { /* the runner records its own terminal state */ })
      .finally(() => active.delete(jobId));
    return entry.promise;
  }

  return {
    service: translate,
    store: jobStore,
    engines: engineSet,

    capabilities: () => translate.capabilities(),

    start({ input, options = {} } = {}) {
      const normalized = normalizeTranslateOptions(options);
      const { job } = translate.create({ input, options: normalized });
      void launch(job.id);
      return publicJob(translate, job.id);
    },

    // Retry is a new job over the same project, so finished stages are kept.
    retry(jobId) {
      const { job } = translate.retry(jobId);
      void launch(job.id);
      return publicJob(translate, job.id);
    },

    get(jobId) {
      if (typeof jobId !== 'string' || !/^job_[\w-]+$/.test(jobId)) throw new Error('job_id must look like job_…');
      const job = jobStore.get(jobId);
      if (!job || job.type !== TRANSLATE_JOB_TYPE) throw new Error(`No such translate job: ${jobId}`);
      return publicJob(translate, jobId);
    },

    list({ limit = 20, state = null } = {}) {
      const boundedLimit = Math.max(1, Math.min(50, Number(limit) || 20));
      const jobs = jobStore.list({ type: TRANSLATE_JOB_TYPE, state }).slice(0, boundedLimit);
      return {
        contract_version: 1,
        count: jobs.length,
        jobs: jobs.map(job => publicJob(translate, job.id)).filter(Boolean),
      };
    },

    cancel(jobId) {
      const job = jobStore.get(jobId);
      if (!job || job.type !== TRANSLATE_JOB_TYPE) throw new Error(`No such translate job: ${jobId}`);
      const entry = active.get(jobId);
      if (entry) {
        try { entry.controller.abort(); } catch { /* already aborted */ }
      }
      translate.cancel(jobId);
      return publicJob(translate, jobId);
    },

    /** Read one bounded JSON artifact owned by a translate project. */
    readArtifact(jobId, artifact) {
      const job = jobStore.get(jobId);
      if (!job || job.type !== TRANSLATE_JOB_TYPE) throw new Error(`No such translate job: ${jobId}`);
      const projectDir = job.params?.projectDir;
      if (!projectDir || !TranslateProject.exists(projectDir)) throw new Error('The translate project for that job is missing.');
      const project = TranslateProject.load(projectDir);
      const absolute = project.artifactPath(artifact);
      if (path.extname(absolute).toLowerCase() !== '.json') throw new Error('Only project-owned JSON artifacts can be read.');
      const stat = fs.statSync(absolute);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('Artifact is missing or too large.');
      return { contract_version: 1, artifact, value: JSON.parse(fs.readFileSync(absolute, 'utf8')) };
    },

    async close() {
      for (const entry of active.values()) {
        try { entry.controller.abort(); } catch { /* already settled */ }
      }
      await Promise.allSettled([...active.values()].map(entry => entry.promise));
      active.clear();
    },
  };
}
