// Durable local Repurpose worker orchestration.
//
// The Python package remains the only media engine. This module owns the
// versioned JSONL subprocess boundary, JobStore checkpoints, and atomic
// reconciliation of completed worker artifacts into RepurposeProject.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  REPURPOSE_STAGES,
  RepurposeProject,
  validateWorkerEvent,
  validateWorkerEventStream,
  validateWorkerRequest,
} from './repurpose.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPURPOSE_ENGINE_DIR = path.resolve(here, '../../repurpose-engine');
export const DEFAULT_REPURPOSE_PYTHON = process.env.VIDMYO_REPURPOSE_PYTHON || 'python3';
export const REPURPOSE_JOB_TYPE = 'repurpose';
const MAX_ERROR_LENGTH = 1000;
const MAX_JSONL_BUFFER = 1024 * 1024;
const MAX_WORKER_EVENTS = 10000;
const REQUEST_DIRECTORY = path.join('.vidmyo', 'requests');

const ARTIFACTS = {
  ingest: ['ingest_artifact', 'artifacts/ingest-artifact.v1.json', 1],
  transcript: ['transcript_artifact', 'artifacts/transcript-artifact.v1.json', 1],
  candidates: ['candidate_artifact', 'artifacts/candidate-artifact.v1.json', 1],
  ranking: ['ranking_artifact', 'artifacts/ranking-artifact.v1.json', 1],
  boundary: ['boundary_artifact', 'artifacts/boundary-artifact.v1.json', 1],
  reframeV1: ['reframe_artifact', 'artifacts/reframe-artifact.v1.json', 1],
  reframeV2: ['reframe_artifact', 'artifacts/reframe-artifact.v2.json', 2],
  render: ['render_artifact', 'artifacts/render-artifact.v1.json', 1],
};

const STAGE_PLAN = {
  ingest: [{ id: 'ingest', command: 'ingest', inputs: [], output: 'ingest' }],
  transcribe: [{ id: 'transcribe', command: 'transcribe', inputs: ['ingest'], output: 'transcript' }],
  generate_candidates: [{ id: 'generate_candidates', command: 'generate-candidates', inputs: ['transcript'], output: 'candidates' }],
  rank: [{ id: 'rank', command: 'rank', inputs: ['transcript', 'candidates'], output: 'ranking' }],
  repair_boundaries: [{ id: 'repair_boundaries', command: 'repair-boundaries', inputs: ['ingest', 'transcript', 'ranking'], output: 'boundary' }],
  reframe: [
    { id: 'single_speaker', command: 'reframe', inputs: ['boundary'], output: 'reframeV1' },
    { id: 'two_speaker', command: 'reframe-two', inputs: ['reframeV1', 'boundary'], output: 'reframeV2' },
  ],
  render: [{ id: 'render', command: 'render', inputs: ['transcript', 'boundary', 'reframeV1', 'reframeV2'], output: 'render' }],
};

const STAGE_OPTIONS = {
  ingest: [],
  transcribe: ['model', 'language', 'device', 'compute_type', 'model_cache'],
  generate_candidates: ['provider', 'model'],
  rank: ['model'],
  repair_boundaries: ['candidate_ids', 'boundary_overrides'],
  reframe: ['candidate_ids'],
  render: ['candidate_ids', 'caption_style', 'captions_enabled', 'platforms'],
};

function bounded(value) {
  return String(value || '').slice(0, MAX_ERROR_LENGTH);
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* already replaced or absent */ }
  }
}

export function insideRepurposeProject(projectDir, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error('Repurpose artifact path must be a non-empty project-relative path');
  }
  const root = path.resolve(projectDir);
  const resolved = path.resolve(root, relativePath);
  const relation = path.relative(root, resolved);
  if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`Repurpose artifact path escapes project: ${relativePath}`);
  }
  return resolved;
}

function descriptor(name) {
  const [kind, artifactPath, version] = ARTIFACTS[name];
  return { kind, path: artifactPath, version };
}

function workerJobId(parentId, step, count) {
  return count === 1 ? parentId : `${parentId}_${step.id}`;
}

export function buildRepurposeSteps(project, stage, jobId, options = {}) {
  if (!(project instanceof RepurposeProject)) throw new Error('A validated RepurposeProject is required');
  if (!STAGE_PLAN[stage] || !REPURPOSE_STAGES.includes(stage)) throw new Error(`Unknown Repurpose stage: ${stage}`);
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Repurpose stage options must be an object');
  let encodedOptions;
  try { encodedOptions = JSON.stringify(options); } catch { throw new Error('Repurpose stage options must be JSON-serializable'); }
  if (!encodedOptions || Buffer.byteLength(encodedOptions) > 64 * 1024) throw new Error('Repurpose stage options exceed 64 KiB');
  const unknownOptions = Object.keys(options).filter(key => !STAGE_OPTIONS[stage].includes(key));
  if (unknownOptions.length) throw new Error(`Unsupported ${stage} options: ${unknownOptions.join(', ')}`);
  if (project.manifest.source.type !== 'local_file') throw new Error('Desktop Repurpose supports local_file sources only');
  const source = path.isAbsolute(project.manifest.source.uri)
    ? path.resolve(project.manifest.source.uri)
    : path.resolve(project.dir, project.manifest.source.uri);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`Repurpose source is missing: ${source}`);
  const stageIndex = REPURPOSE_STAGES.indexOf(stage);
  if (stageIndex > 0) {
    const prerequisite = REPURPOSE_STAGES[stageIndex - 1];
    if (project.manifest.stages[prerequisite].state !== 'completed') {
      throw new Error(`Cannot run ${stage}: prerequisite ${prerequisite} is not completed`);
    }
  }
  const plan = STAGE_PLAN[stage];
  return plan.map(step => {
    const request = {
      protocol_version: 1,
      job_id: workerJobId(jobId, step, plan.length),
      project_dir: path.resolve(project.dir),
      stage,
      input_artifacts: step.inputs.map(descriptor),
      options: structuredClone(options),
    };
    validateWorkerRequest(request);
    return { ...step, request };
  });
}

export function createRepurposeJob(store, { projectDir, stage, options = {} }) {
  const project = RepurposeProject.load(path.resolve(projectDir));
  const record = project.manifest.stages[stage];
  if (!record || !['pending', 'failed'].includes(record.state)) {
    throw new Error(`Repurpose stage ${stage} is not retryable from ${record?.state || 'unknown'}`);
  }
  // Validate prerequisites and source before creating durable state. The real
  // id is not known yet; the placeholder obeys the same protocol pattern.
  buildRepurposeSteps(project, stage, 'job_validation', options);
  return store.create({
    type: REPURPOSE_JOB_TYPE,
    provider: 'local-python',
    project: project.manifest.id,
    params: { projectDir: path.resolve(project.dir), stage, options: structuredClone(options) },
  });
}

function fingerprint(file) {
  const digest = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead) digest.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
  return `sha256:${digest.digest('hex')}`;
}

function recordArtifact(store, parentJobId, projectDir, event) {
  const relativePath = event.payload?.path;
  const kind = event.payload?.kind;
  if (event.event !== 'artifact' || !relativePath || !kind) return;
  const absolute = insideRepurposeProject(projectDir, relativePath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`Worker artifact is missing: ${relativePath}`);
  }
  const evidence = { path: relativePath, kind, fingerprint: fingerprint(absolute) };
  const current = store.get(parentJobId);
  const known = current.artifacts.some(item => item.path === absolute && item.kind === kind);
  if (!known) store.addArtifact(parentJobId, { path: absolute, kind });
  const allEvidence = { ...(store.get(parentJobId).checkpoints.artifactEvidence || {}) };
  allEvidence[relativePath] = evidence;
  store.checkpoint(parentJobId, 'artifactEvidence', allEvidence);
}

function writeRequest(projectDir, request) {
  const relativePath = path.join(REQUEST_DIRECTORY, `${request.job_id}.json`);
  const absolute = insideRepurposeProject(projectDir, relativePath);
  atomicWriteJson(absolute, request);
  return { relativePath, absolute };
}

async function runWorkerStep({
  store,
  parentJobId,
  projectDir,
  step,
  python,
  engineDir,
  spawnImpl,
  onEvent,
  onChild,
  extraEnv,
}) {
  const requestFile = writeRequest(projectDir, step.request);
  const env = {
    ...process.env,
    ...extraEnv,
    PYTHONPATH: [path.join(engineDir, 'src'), extraEnv?.PYTHONPATH || process.env.PYTHONPATH]
      .filter(Boolean)
      .join(path.delimiter),
  };
  store.checkpoint(parentJobId, 'activeSubstep', {
    id: step.id,
    command: step.command,
    workerJobId: step.request.job_id,
    requestPath: requestFile.relativePath,
  });
  const child = spawnImpl(
    python,
    ['-m', 'vidmyo_repurpose.cli', step.command, '--request', requestFile.absolute],
    { cwd: projectDir, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  store.checkpoint(parentJobId, 'childProcess', {
    pid: Number.isInteger(child.pid) ? child.pid : null,
    substep: step.id,
    startedAt: new Date().toISOString(),
  });
  try { onChild?.(child, step); } catch (error) {
    store.log(parentJobId, `[${step.id}] child listener failed: ${bounded(error.message || error)}`);
  }
  const events = [];
  let stdoutBuffer = '';
  let stderr = '';
  let streamError = null;
  let spawnError = null;
  let expectedSequence = 1;
  let terminalSeen = false;
  const expectedArtifact = descriptor(step.output);

  const consumeLine = rawLine => {
    const line = rawLine.trim();
    if (!line) return;
    if (Buffer.byteLength(line) > MAX_JSONL_BUFFER) throw new Error('Worker JSONL event exceeds 1 MiB');
    if (events.length >= MAX_WORKER_EVENTS) throw new Error('Worker emitted too many events');
    let event;
    try { event = JSON.parse(line); } catch (error) {
      throw new Error(`Worker emitted malformed JSONL: ${bounded(error.message)}`);
    }
    validateWorkerEvent(event);
    if (event.job_id !== step.request.job_id || event.stage !== step.request.stage) {
      throw new Error('Worker event does not match its request identity');
    }
    if (terminalSeen) throw new Error('Worker emitted an event after its terminal event');
    if (event.sequence !== expectedSequence) {
      throw new Error(`Worker event sequence expected ${expectedSequence}, got ${event.sequence}`);
    }
    if (expectedSequence === 1 && event.event !== 'accepted') throw new Error('Worker stream must begin with accepted');
    expectedSequence += 1;
    terminalSeen = ['completed', 'error'].includes(event.event);
    recordArtifact(store, parentJobId, projectDir, event);
    if (event.event === 'artifact' && (
      event.payload?.kind !== expectedArtifact.kind
      || event.payload?.path !== expectedArtifact.path
      || event.payload?.version !== expectedArtifact.version
    )) throw new Error(`Worker emitted an unexpected artifact for ${step.id}`);
    events.push(event);
    store.checkpoint(parentJobId, 'lastEvent', {
      substep: step.id,
      workerJobId: event.job_id,
      sequence: event.sequence,
      event: event.event,
      payload: event.payload,
    });
    if (event.event === 'progress') store.checkpoint(parentJobId, 'progress', { substep: step.id, ...event.payload });
    const message = event.payload?.message;
    if (message) store.log(parentJobId, `[${step.id}] ${bounded(message)}`);
    try {
      onEvent?.({ ...event, job_id: parentJobId, worker_job_id: event.job_id, substep: step.id });
    } catch (error) {
      store.log(parentJobId, `[${step.id}] progress listener failed: ${bounded(error.message || error)}`);
    }
  };

  child.stdout.on('data', chunk => {
    if (streamError) return;
    try {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop();
      if (Buffer.byteLength(stdoutBuffer) > MAX_JSONL_BUFFER) throw new Error('Worker JSONL buffer exceeds 1 MiB');
      lines.forEach(consumeLine);
    } catch (error) {
      streamError = error;
      try { child.kill('SIGTERM'); } catch { /* process may already be gone */ }
    }
  });
  child.stderr.on('data', chunk => { stderr = bounded(stderr + chunk.toString('utf8')); });
  child.on('error', error => { spawnError = error; });
  const exit = await new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
  store.checkpoint(parentJobId, 'childProcess', null);
  if (!streamError && stdoutBuffer.trim()) {
    try { consumeLine(stdoutBuffer); } catch (error) { streamError = error; }
  }
  if (streamError) throw streamError;
  if (spawnError) throw new Error(`Repurpose worker could not start: ${bounded(spawnError.message)}`);
  validateWorkerEventStream(events);
  const terminal = events.at(-1);
  if (terminal.event === 'error') throw new Error(bounded(terminal.payload?.message || terminal.payload?.code || 'worker failed'));
  if (events.filter(event => event.event === 'artifact').length !== 1) {
    throw new Error(`Worker must emit exactly one ${expectedArtifact.kind} artifact event`);
  }
  if (exit.code !== 0) {
    throw new Error(`Repurpose worker exited ${exit.code ?? exit.signal}: ${bounded(stderr || 'no diagnostic')}`);
  }
  return { events, terminal, requestFile };
}

function artifactForStage(stage) {
  return {
    ingest: ARTIFACTS.ingest,
    transcribe: ARTIFACTS.transcript,
    generate_candidates: ARTIFACTS.candidates,
    rank: ARTIFACTS.ranking,
    repair_boundaries: ARTIFACTS.boundary,
    reframe: ARTIFACTS.reframeV2,
    render: ARTIFACTS.render,
  }[stage];
}

function applyCompletedStage(project, stage) {
  const [_kind, relativePath] = artifactForStage(stage);
  const artifactPath = insideRepurposeProject(project.dir, relativePath);
  if (!fs.existsSync(artifactPath)) throw new Error(`Completed worker artifact is missing: ${relativePath}`);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  if (stage === 'ingest') return project.applyIngestArtifact(artifact, { artifactPath: relativePath });
  if (stage === 'generate_candidates') return project.applyCandidateArtifact(artifact, { artifactPath: relativePath });
  if (stage === 'rank') return project.applyRankingArtifact(artifact, { artifactPath: relativePath });
  if (stage === 'render') return project.applyRenderArtifact(artifact, { artifactPath: relativePath });
  project.completeStage(stage, { artifact: relativePath });
  return { manifest: project.manifest };
}

function failRunningStage(projectDir, stage, message) {
  try {
    const project = RepurposeProject.load(projectDir);
    if (project.manifest.stages[stage]?.state === 'running') project.failStage(stage, bounded(message));
  } catch { /* preserve the original worker failure */ }
}

export function cancelRepurposeJob(store, jobId, { terminate = null } = {}) {
  const job = store.get(jobId);
  if (!job || job.type !== REPURPOSE_JOB_TYPE) throw new Error(`No such Repurpose job: ${jobId}`);
  if (!['queued', 'running'].includes(job.state)) throw new Error(`Repurpose job ${jobId} cannot cancel from ${job.state}`);
  const cancelled = store.cancel(jobId);
  try { terminate?.(); } catch { /* the child may already be exiting */ }
  if (job.state === 'running') {
    failRunningStage(job.params.projectDir, job.params.stage, 'cancelled; retry the stage to resume valid cached work');
  }
  return cancelled;
}

function execute(execFileImpl, command, args, options) {
  return new Promise(resolve => {
    execFileImpl(command, args, options, (error, stdout = '', stderr = '') => {
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        output: bounded(String(stdout || stderr).trim()),
        error: error ? bounded(error.message) : null,
      });
    });
  });
}

export async function inspectRepurposeReadiness({
  python = DEFAULT_REPURPOSE_PYTHON,
  engineDir = DEFAULT_REPURPOSE_ENGINE_DIR,
  modelCache = null,
  execFileImpl = nodeExecFile,
  extraEnv = {},
} = {}) {
  const env = {
    ...process.env,
    ...extraEnv,
    PYTHONPATH: [path.join(engineDir, 'src'), extraEnv.PYTHONPATH || process.env.PYTHONPATH]
      .filter(Boolean)
      .join(path.delimiter),
  };
  const options = { env, timeout: 15000, maxBuffer: 1024 * 1024 };
  const [pythonVersion, engine, ffmpeg, ffprobe] = await Promise.all([
    execute(execFileImpl, python, ['--version'], options),
    execute(execFileImpl, python, ['-c', 'import vidmyo_repurpose; print(vidmyo_repurpose.__name__)'], options),
    execute(execFileImpl, 'ffmpeg', ['-version'], options),
    execute(execFileImpl, 'ffprobe', ['-version'], options),
  ]);
  const doctorArgs = ['-m', 'vidmyo_repurpose.cli', 'doctor'];
  if (modelCache) doctorArgs.push('--model-cache', modelCache);
  const doctor = await execute(execFileImpl, python, doctorArgs, options);
  let model = null;
  try { model = JSON.parse(doctor.output); } catch { model = { ok: false, error: doctor.error || doctor.output || 'doctor returned no JSON' }; }
  return {
    ok: pythonVersion.ok && engine.ok && ffmpeg.ok && ffprobe.ok,
    python: { command: python, ...pythonVersion },
    engine: { dir: path.resolve(engineDir), ...engine },
    ffmpeg,
    ffprobe,
    model,
    downloadsPerformed: false,
  };
}

export async function runRepurposeJob(store, jobId, {
  python = DEFAULT_REPURPOSE_PYTHON,
  engineDir = DEFAULT_REPURPOSE_ENGINE_DIR,
  spawnImpl = nodeSpawn,
  onEvent = null,
  onChild = null,
  extraEnv = {},
} = {}) {
  let job = store.get(jobId);
  if (!job || job.type !== REPURPOSE_JOB_TYPE) throw new Error(`No such Repurpose job: ${jobId}`);
  if (!['queued', 'running'].includes(job.state)) throw new Error(`Repurpose job ${jobId} cannot run from ${job.state}`);
  const { projectDir, stage, options = {} } = job.params;
  let project;
  try {
    project = RepurposeProject.load(projectDir);
    if (job.state === 'queued') {
      buildRepurposeSteps(project, stage, jobId, options);
      if (project.manifest.stages[stage].state === 'running') {
        store.log(jobId, 'recovering queued job after its manifest stage already entered running');
      } else {
        project.startStage(stage);
      }
      store.setState(jobId, 'running');
    } else if (project.manifest.stages[stage].state === 'completed') {
      store.log(jobId, 'manifest already records this stage as completed; closing recovered job');
      return store.setState(jobId, 'done');
    } else if (project.manifest.stages[stage].state !== 'running') {
      throw new Error(`Cannot resume ${stage}: manifest state is ${project.manifest.stages[stage].state}`);
    } else {
      store.log(jobId, 'explicitly resuming persisted running Repurpose job');
    }

    project = RepurposeProject.load(projectDir);
    const steps = buildRepurposeSteps(project, stage, jobId, options);
    const completed = new Set(store.get(jobId).checkpoints.completedSubsteps || []);
    for (const step of steps) {
      if (completed.has(step.id)) continue;
      await runWorkerStep({
        store, parentJobId: jobId, projectDir, step, python, engineDir,
        spawnImpl, onEvent, onChild, extraEnv,
      });
      completed.add(step.id);
      store.checkpoint(jobId, 'completedSubsteps', [...completed]);
    }
    const result = applyCompletedStage(RepurposeProject.load(projectDir), stage);
    store.checkpoint(jobId, 'manifestStage', {
      stage,
      state: result.manifest.stages[stage].state,
      artifact: result.manifest.stages[stage].artifact,
    });
    return store.setState(jobId, 'done');
  } catch (error) {
    job = store.get(jobId);
    const message = bounded(error?.message || error);
    if (job?.state === 'cancelled') {
      failRunningStage(projectDir, stage, 'cancelled; retry the stage to resume valid cached work');
      return store.get(jobId);
    }
    failRunningStage(projectDir, stage, message);
    if (job && ['queued', 'running'].includes(job.state)) return store.setState(jobId, 'error', { error: message });
    throw error;
  }
}
