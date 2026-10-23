// Shared Editor orchestration for both MCP transports (and reused by the desktop
// bridge). Thin and bounded: it owns no pipeline logic. It creates the same
// `editor` job the Editor tab creates, launches the same `runEditorJob`, and
// reports the same project manifest, so a job started from MCP can be inspected,
// retried or revealed from the desktop and vice versa.

import fs from 'node:fs';
import path from 'node:path';

import {
  JobStore,
  EditorProject,
  EditorService,
  EditorTemplateStore,
  EDITOR_JOB_TYPE,
  EDITOR_ANALYSIS_JOB_TYPE,
  createEditorEngines,
  editorCapabilities,
  detectEditorAgents,
  editorAgentStatus,
  probeEditorAgents,
  clearEditorAgentProbeCache,
  editorJobSummary,
  summarizeTemplate,
  runEditorJob,
  runEditorAnalysisJob,
} from '../../packages/core/index.js';

const MAX_TEXT = 800;
const MAX_LOGS = 5;
const MAX_OUTPUTS = 20;
const MAX_WARNINGS = 20;
const MAX_STAGES = 20;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;

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
  const outputs = (summary.outputs || []).slice(0, MAX_OUTPUTS).map(entry => ({
    kind: entry.kind || null,
    artifact: entry.artifact || null,
    bytes: entry.bytes ?? null,
  }));
  return {
    contract_version: 1,
    job_id: job.id,
    state: job.state,
    input: summary.input,
    output_dir: projectDir || null,
    engine: summary.engine,
    mode: summary.mode,
    template_id: summary.template_id,
    stage: summary.stage,
    stage_label: summary.stage_label,
    progress: summary.progress,
    stages: (summary.stages || []).slice(0, MAX_STAGES),
    outputs,
    output_paths: projectDir
      ? outputs.map(entry => relativeProjectPath(projectDir, path.join(projectDir, entry.artifact))).filter(Boolean)
      : [],
    warnings: (summary.warnings || []).slice(-MAX_WARNINGS).map(bounded),
    error: job.error ? bounded(job.error) : null,
    retryable: job.state === 'error' && Boolean(summary.stages?.some(entry => entry.status === 'failed')),
    timings: job.checkpoints?.metrics?.stages || null,
    total_ms: job.checkpoints?.metrics?.totalMs ?? null,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    ended_at: job.endedAt,
    log_tail: (job.logs || []).slice(-MAX_LOGS).map(entry => ({ at: entry.at, message: bounded(entry.message) })),
  };
}

function publicAnalysis(service, jobId) {
  const state = service.getAnalysis(jobId);
  if (!state) return null;
  const { job, dir, profile } = state;
  return {
    contract_version: 1,
    job_id: job.id,
    state: job.state,
    label: job.params?.label || null,
    examples: (job.params?.examples || []).slice(0, 40),
    stage: job.checkpoints?.stage || null,
    progress: job.checkpoints?.progress ?? 0,
    profile,
    style: summarizeProfile(profile),
    contact_sheet: dir && fs.existsSync(path.join(dir, 'contact-sheet.jpg'))
      ? path.join(dir, 'contact-sheet.jpg')
      : null,
    error: job.error ? bounded(job.error) : null,
    created_at: job.createdAt,
    ended_at: job.endedAt,
    log_tail: (job.logs || []).slice(-MAX_LOGS).map(entry => ({ at: entry.at, message: bounded(entry.message) })),
  };
}

function summarizeProfile(profile) {
  if (!profile) return null;
  const style = profile.style || profile;
  return {
    examples: style.sample_count ?? profile.examples?.length ?? null,
    cut_median_s: style.cut_median_s ?? null,
    cuts_per_minute: style.cuts_per_minute ?? null,
    burst_ratio: style.burst_ratio ?? null,
    palette: Array.isArray(style.palette) ? style.palette.slice(0, 6) : [],
    treatment_mix: style.treatment_mix || null,
  };
}

export function createEditorMcpService({
  store = null,
  service = null,
  engines = null,
  projectsDir = null,
  templates = null,
  // Injectable so tests (and any caller) can answer without spawning a CLI.
  probeRunner = probeEditorAgents,
} = {}) {
  const jobStore = store || new JobStore();
  const engineSet = engines || createEditorEngines();
  const templateStore = templates || new EditorTemplateStore();
  const editor = service || new EditorService({
    store: jobStore,
    engines: engineSet,
    templates: templateStore,
    ...(projectsDir ? { projectsDir } : {}),
  });
  const active = new Map();

  function launch(jobId, runner) {
    if (active.has(jobId)) return active.get(jobId).promise;
    const controller = new AbortController();
    const entry = { controller, promise: null };
    active.set(jobId, entry);
    entry.promise = runner(jobStore, jobId, { engines: engineSet, signal: controller.signal })
      .catch(() => { /* the runner records its own terminal state */ })
      .finally(() => active.delete(jobId));
    return entry.promise;
  }

  // Probe state lives with the service: one real one-line turn per agent at a time,
  // never awaited by a caller that paints UI. The tab renders the installed list
  // instantly and fills the dots as the answers arrive.
  const agentProbe = { inFlight: null, results: null, at: 0 };

  function startAgentProbe({ force = false, onDone = null } = {}) {
    if (force) clearEditorAgentProbeCache();
    if (agentProbe.inFlight) return agentProbe.inFlight;
    agentProbe.inFlight = probeRunner({ force: false })
      .then(results => { agentProbe.results = results; agentProbe.at = Date.now(); return results; })
      .catch(() => null)
      .finally(() => {
        agentProbe.inFlight = null;
        if (typeof onDone === 'function' && agentProbe.results) {
          try { onDone(agentProbe.results); } catch { /* observers must not break the probe */ }
        }
      });
    return agentProbe.inFlight;
  }

  return {
    service: editor,
    store: jobStore,
    engines: engineSet,
    templates: templateStore,

    capabilities: () => editor.capabilities(),

    /**
     * Which local agents this machine has, and which of them answer. Never blocks:
     * `probe: true` starts a background round and returns whatever is already known
     * plus `pending`, so the UI paints immediately instead of spinning.
     */
    agents({ probe = false, force = false } = {}) {
      const installed = detectEditorAgents();
      const withStatus = installed.map(entry => ({
        ...entry,
        ...editorAgentStatus(entry.id, { binary: entry.path }),
      }));
      if (probe) {
        // Start a round only when nothing is known, the caller demands a refresh, or
        // the previous round is older than the probe TTL. Otherwise every poll would
        // spawn another CLI and the tab would look stuck on "checking".
        const stale = !agentProbe.at || (Date.now() - agentProbe.at) > 10 * 60 * 1000;
        if (force) agentProbe.results = null;
        if (force || !agentProbe.results || stale) void startAgentProbe({ force });
      }
      const byId = new Map((agentProbe.results || []).map(entry => [entry.id, entry]));
      const agents = withStatus.map(entry => ({
        ...entry,
        checked: byId.has(entry.id),
        ...(byId.get(entry.id) || {}),
      }));
      const pending = probe && (
        agentProbe.inFlight !== null
        || !agentProbe.results
        || withStatus.some(entry => !byId.has(entry.id))
      );
      return {
        contract_version: 1,
        probed: Boolean(agentProbe.results),
        pending: Boolean(pending),
        agents,
      };
    },

    start({ input = null, input_dir = null, output_dir = null, template_id = null, options = {} } = {}) {
      const { job } = editor.create({
        input: input || input_dir,
        output: output_dir,
        options,
        templateId: template_id,
      });
      void launch(job.id, runEditorJob);
      return publicJob(editor, job.id);
    },

    retry(jobId) {
      const { job } = editor.retry(jobId);
      void launch(job.id, runEditorJob);
      return publicJob(editor, job.id);
    },

    get(jobId) {
      if (typeof jobId !== 'string' || !/^job_[\w-]+$/.test(jobId)) throw new Error('job_id must look like job_…');
      const job = jobStore.get(jobId);
      if (!job || job.type !== EDITOR_JOB_TYPE) throw new Error(`No such editor job: ${jobId}`);
      return publicJob(editor, jobId);
    },

    list({ limit = 20, state = null } = {}) {
      const boundedLimit = Math.max(1, Math.min(50, Number(limit) || 20));
      const jobs = jobStore.list({ type: EDITOR_JOB_TYPE, state }).slice(0, boundedLimit);
      return {
        contract_version: 1,
        count: jobs.length,
        jobs: jobs.map(job => publicJob(editor, job.id)).filter(Boolean),
      };
    },

    cancel(jobId) {
      const job = jobStore.get(jobId);
      if (!job || job.type !== EDITOR_JOB_TYPE) throw new Error(`No such editor job: ${jobId}`);
      const entry = active.get(jobId);
      if (entry) {
        try { entry.controller.abort(); } catch { /* already aborted */ }
      }
      editor.cancel(jobId);
      return publicJob(editor, jobId);
    },

    // ── custom style: examples → profile → template ──────────────────────────
    analyzeExamples({ urls = [], videos = [], name = 'Style' } = {}) {
      const { job } = editor.createAnalysis({ urls, videos, name });
      void launch(job.id, runEditorAnalysisJob);
      return publicAnalysis(editor, job.id);
    },

    getAnalysis(jobId) {
      if (typeof jobId !== 'string' || !/^job_[\w-]+$/.test(jobId)) throw new Error('job_id must look like job_…');
      const job = jobStore.get(jobId);
      if (!job || job.type !== EDITOR_ANALYSIS_JOB_TYPE) throw new Error(`No such style analysis job: ${jobId}`);
      return publicAnalysis(editor, jobId);
    },

    saveTemplate({ name, analysis_job_id = null, profile = null, examples = [], engine = 'v1', notes = null } = {}) {
      let styleProfile = profile;
      let styleExamples = Array.isArray(examples) ? examples : [];
      if (analysis_job_id) {
        const analysis = editor.getAnalysis(analysis_job_id);
        if (!analysis) throw new Error(`No such style analysis job: ${analysis_job_id}`);
        if (analysis.job.state !== 'done') throw new Error('That style analysis is not finished yet.');
        if (!analysis.profile) throw new Error('That style analysis produced no profile.');
        styleProfile = analysis.profile;
        styleExamples = styleExamples.length
          ? styleExamples
          : (analysis.job.params?.examples || []).map(entry => entry.value);
      }
      const template = templateStore.save({ name, profile: styleProfile, examples: styleExamples, engine, notes });
      return { contract_version: 1, template: summarizeTemplate(template), full: template };
    },

    listTemplates({ engine = null } = {}) {
      const items = templateStore.list({ engine });
      return { contract_version: 1, count: items.length, templates: items };
    },

    getTemplate(id) {
      const template = templateStore.get(id);
      if (!template) throw new Error(`No such template: ${id}`);
      return { contract_version: 1, template };
    },

    deleteTemplate(id) {
      const removed = templateStore.remove(id);
      return { contract_version: 1, id, removed };
    },

    /** Read one bounded JSON artifact owned by an editor job or an analysis job. */
    readArtifact(jobId, artifact) {
      const job = jobStore.get(jobId);
      if (!job) throw new Error(`No such job: ${jobId}`);
      const projectDir = job.params?.projectDir;
      if (!projectDir || !fs.existsSync(projectDir)) throw new Error('The project for that job is missing.');
      const resolved = path.resolve(projectDir, artifact);
      const relative = path.relative(path.resolve(projectDir), resolved);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Artifact must live inside the job project.');
      }
      if (path.extname(resolved).toLowerCase() !== '.json') throw new Error('Only project-owned JSON artifacts can be read.');
      const stat = fs.statSync(resolved);
      if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) throw new Error('Artifact is missing or too large.');
      return { contract_version: 1, artifact: relative.split(path.sep).join('/'), value: JSON.parse(fs.readFileSync(resolved, 'utf8')) };
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

export { editorCapabilities };
