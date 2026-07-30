// Pure Repurpose project contracts.
//
// This module owns versioned manifest state only. Long-running process and
// cancellation state belongs to JobStore; media work belongs to the Python
// worker introduced by later issues.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const REPURPOSE_MANIFEST_NAME = 'repurpose.json';
export const REPURPOSE_MANIFEST_VERSION = 1;
export const REPURPOSE_PROTOCOL_VERSION = 1;
export const REPURPOSE_RENDER_MODE = 'manual_approval';
export const REPURPOSE_STAGES = [
  'ingest',
  'transcribe',
  'generate_candidates',
  'rank',
  'repair_boundaries',
  'reframe',
  'render',
];

export const REPURPOSE_STAGE_STATES = ['pending', 'running', 'completed', 'failed'];
export const REPURPOSE_CANDIDATE_DECISIONS = ['pending', 'approved', 'rejected'];

const PROJECT_ID_RE = /^repurpose_[A-Za-z0-9_-]+$/;
const JOB_ID_RE = /^job_[A-Za-z0-9_-]+$/;
const CLIP_ID_RE = /^clip_\d{3,}$/;
const SOURCE_TYPES = ['local_file', 'url'];
const EVENT_TYPES = ['accepted', 'progress', 'artifact', 'completed', 'error'];
const SHA256_FINGERPRINT_RE = /^sha256:[0-9a-f]{64}$/;
const INGEST_ARTIFACT_VERSION = 1;
const DEFAULT_INGEST_ARTIFACT = 'artifacts/ingest-artifact.v1.json';

const TOP_LEVEL_KEYS = [
  'id', 'version', 'protocol_version', 'engine_version', 'source',
  'requested_clip_count', 'content_type', 'target_platforms', 'render_mode',
  'render_defaults', 'stages', 'candidates', 'outputs', 'created_at', 'updated_at',
];

function contractError(pathName, message) {
  throw new Error(`${pathName}: ${message}`);
}

function requireObject(value, pathName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    contractError(pathName, 'must be an object');
  }
}

function requireKeys(value, required, pathName, { allowExtra = false } = {}) {
  requireObject(value, pathName);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) contractError(`${pathName}.${key}`, 'is required');
  }
  if (!allowExtra) {
    for (const key of Object.keys(value)) {
      if (!required.includes(key)) contractError(`${pathName}.${key}`, 'is not allowed');
    }
  }
}

function requireNonEmptyString(value, pathName) {
  if (typeof value !== 'string' || !value.trim()) contractError(pathName, 'must be a non-empty string');
}

function requireNullableString(value, pathName) {
  if (value !== null && typeof value !== 'string') contractError(pathName, 'must be a string or null');
}

function requireIsoDate(value, pathName) {
  requireNonEmptyString(value, pathName);
  if (Number.isNaN(Date.parse(value))) contractError(pathName, 'must be an ISO-8601 date-time');
}

function validateStageName(stage, pathName = 'stage') {
  if (!REPURPOSE_STAGES.includes(stage)) {
    contractError(pathName, `unknown stage "${stage}"`);
  }
}

function atomicWriteJson(file, data) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
  fs.renameSync(temporary, file);
}

export function validateWorkerRequest(request) {
  const keys = ['protocol_version', 'job_id', 'project_dir', 'stage', 'input_artifacts', 'options'];
  requireKeys(request, keys, 'request');
  if (request.protocol_version !== REPURPOSE_PROTOCOL_VERSION) {
    contractError('request.protocol_version', `expected ${REPURPOSE_PROTOCOL_VERSION}`);
  }
  if (typeof request.job_id !== 'string' || !JOB_ID_RE.test(request.job_id)) {
    contractError('request.job_id', 'must match job_<id>');
  }
  requireNonEmptyString(request.project_dir, 'request.project_dir');
  validateStageName(request.stage, 'request.stage');
  if (!Array.isArray(request.input_artifacts)) contractError('request.input_artifacts', 'must be an array');
  for (const [index, artifact] of request.input_artifacts.entries()) {
    requireKeys(artifact, ['kind', 'path'], `request.input_artifacts.${index}`, { allowExtra: true });
    const allowed = ['kind', 'path', 'version'];
    for (const key of Object.keys(artifact)) {
      if (!allowed.includes(key)) contractError(`request.input_artifacts.${index}.${key}`, 'is not allowed');
    }
    requireNonEmptyString(artifact.kind, `request.input_artifacts.${index}.kind`);
    requireNonEmptyString(artifact.path, `request.input_artifacts.${index}.path`);
    if (Object.hasOwn(artifact, 'version') && artifact.version !== null
      && (!Number.isInteger(artifact.version) || artifact.version < 1)) {
      contractError(`request.input_artifacts.${index}.version`, 'must be a positive integer or null');
    }
  }
  requireObject(request.options, 'request.options');
  return request;
}

export function validateWorkerEvent(event) {
  const keys = ['protocol_version', 'job_id', 'sequence', 'event', 'stage', 'timestamp', 'payload'];
  requireKeys(event, keys, 'event');
  if (event.protocol_version !== REPURPOSE_PROTOCOL_VERSION) {
    contractError('event.protocol_version', `expected ${REPURPOSE_PROTOCOL_VERSION}`);
  }
  if (typeof event.job_id !== 'string' || !JOB_ID_RE.test(event.job_id)) {
    contractError('event.job_id', 'must match job_<id>');
  }
  if (!Number.isInteger(event.sequence) || event.sequence < 1) {
    contractError('event.sequence', 'must be a positive integer');
  }
  if (!EVENT_TYPES.includes(event.event)) contractError('event.event', `unknown event "${event.event}"`);
  validateStageName(event.stage, 'event.stage');
  requireIsoDate(event.timestamp, 'event.timestamp');
  requireObject(event.payload, 'event.payload');
  return event;
}

export function validateWorkerEventStream(events) {
  if (!Array.isArray(events) || events.length === 0) contractError('events', 'must not be empty');
  events.forEach(validateWorkerEvent);
  const first = events[0];
  if (first.event !== 'accepted') contractError('events.0.event', 'first event must be accepted');
  let expectedSequence = first.sequence;
  let terminalSeen = false;
  for (const [index, event] of events.entries()) {
    if (event.job_id !== first.job_id) contractError(`events.${index}.job_id`, 'must match the first event');
    if (event.protocol_version !== first.protocol_version) {
      contractError(`events.${index}.protocol_version`, 'must match the first event');
    }
    if (event.sequence !== expectedSequence) {
      contractError(`events.${index}.sequence`, `expected ${expectedSequence}, got ${event.sequence}`);
    }
    if (terminalSeen) contractError(`events.${index}`, 'event appears after a terminal event');
    if (['completed', 'error'].includes(event.event)) terminalSeen = true;
    expectedSequence += 1;
  }
  if (!terminalSeen) contractError('events', 'must end with completed or error');
  return events;
}

function validateSource(source) {
  requireKeys(source, ['type', 'uri', 'fingerprint'], 'manifest.source');
  if (!SOURCE_TYPES.includes(source.type)) contractError('manifest.source.type', 'must be local_file or url');
  requireNonEmptyString(source.uri, 'manifest.source.uri');
  requireNullableString(source.fingerprint, 'manifest.source.fingerprint');
}

function validateRenderDefaults(defaults) {
  requireKeys(defaults, ['aspect_ratio', 'crop_mode', 'captions'], 'manifest.render_defaults');
  requireNonEmptyString(defaults.aspect_ratio, 'manifest.render_defaults.aspect_ratio');
  requireNonEmptyString(defaults.crop_mode, 'manifest.render_defaults.crop_mode');
  requireKeys(
    defaults.captions,
    ['enabled', 'style', 'translation_target_language'],
    'manifest.render_defaults.captions',
  );
  if (typeof defaults.captions.enabled !== 'boolean') {
    contractError('manifest.render_defaults.captions.enabled', 'must be a boolean');
  }
  requireNonEmptyString(defaults.captions.style, 'manifest.render_defaults.captions.style');
  requireNullableString(
    defaults.captions.translation_target_language,
    'manifest.render_defaults.captions.translation_target_language',
  );
  if (defaults.captions.translation_target_language !== null
    && defaults.captions.translation_target_language.length < 2) {
    contractError('manifest.render_defaults.captions.translation_target_language', 'must have at least 2 characters');
  }
}

function validateStages(stages) {
  requireKeys(stages, REPURPOSE_STAGES, 'manifest.stages');
  let incompleteSeen = false;
  for (const stage of REPURPOSE_STAGES) {
    const record = stages[stage];
    requireKeys(record, ['state', 'artifact', 'error'], `manifest.stages.${stage}`);
    if (!REPURPOSE_STAGE_STATES.includes(record.state)) {
      contractError(`manifest.stages.${stage}.state`, `unknown state "${record.state}"`);
    }
    requireNullableString(record.artifact, `manifest.stages.${stage}.artifact`);
    requireNullableString(record.error, `manifest.stages.${stage}.error`);
    if (incompleteSeen && record.state !== 'pending') {
      contractError(`manifest.stages.${stage}.state`, 'cannot advance before its prerequisite');
    }
    if (record.state !== 'completed') incompleteSeen = true;
  }
}

function validateCandidates(candidates) {
  if (!Array.isArray(candidates)) contractError('manifest.candidates', 'must be an array');
  const ids = new Set();
  for (const [index, candidate] of candidates.entries()) {
    const root = `manifest.candidates.${index}`;
    requireKeys(
      candidate,
      ['id', 'decision', 'selected', 'proposed_start_sec', 'proposed_end_sec', 'metadata'],
      root,
    );
    if (typeof candidate.id !== 'string' || !CLIP_ID_RE.test(candidate.id)) {
      contractError(`${root}.id`, 'must match clip_NNN');
    }
    if (ids.has(candidate.id)) contractError(`${root}.id`, 'must be unique');
    ids.add(candidate.id);
    if (!REPURPOSE_CANDIDATE_DECISIONS.includes(candidate.decision)) {
      contractError(`${root}.decision`, `unknown decision "${candidate.decision}"`);
    }
    if (typeof candidate.selected !== 'boolean') contractError(`${root}.selected`, 'must be a boolean');
    if (candidate.selected && candidate.decision !== 'approved') {
      contractError(`${root}.selected`, 'selected candidates must be approved');
    }
    for (const field of ['proposed_start_sec', 'proposed_end_sec']) {
      const value = candidate[field];
      if (value !== null && (typeof value !== 'number' || value < 0)) {
        contractError(`${root}.${field}`, 'must be a non-negative number or null');
      }
    }
    requireObject(candidate.metadata, `${root}.metadata`);
  }
}

function validateIngestArtifact(artifact) {
  requireKeys(
    artifact,
    ['artifact_version', 'engine_version', 'source', 'container', 'video', 'audio'],
    'ingest_artifact',
  );
  if (artifact.artifact_version !== INGEST_ARTIFACT_VERSION) {
    contractError('ingest_artifact.artifact_version', `expected ${INGEST_ARTIFACT_VERSION}`);
  }
  requireNonEmptyString(artifact.engine_version, 'ingest_artifact.engine_version');
  requireKeys(artifact.source, ['path', 'byte_size', 'fingerprint'], 'ingest_artifact.source');
  requireNonEmptyString(artifact.source.path, 'ingest_artifact.source.path');
  if (!path.isAbsolute(artifact.source.path)) {
    contractError('ingest_artifact.source.path', 'must be an absolute path');
  }
  if (!Number.isInteger(artifact.source.byte_size) || artifact.source.byte_size < 0) {
    contractError('ingest_artifact.source.byte_size', 'must be a non-negative integer');
  }
  if (typeof artifact.source.fingerprint !== 'string'
    || !SHA256_FINGERPRINT_RE.test(artifact.source.fingerprint)) {
    contractError('ingest_artifact.source.fingerprint', 'must be a sha256:<hex> fingerprint');
  }
  for (const section of ['container', 'video', 'audio']) {
    requireObject(artifact[section], `ingest_artifact.${section}`);
  }
  return artifact;
}

export function validateRepurposeManifest(manifest) {
  requireKeys(manifest, TOP_LEVEL_KEYS, 'manifest');
  if (typeof manifest.id !== 'string' || !PROJECT_ID_RE.test(manifest.id)) {
    contractError('manifest.id', 'must match repurpose_<id>');
  }
  if (manifest.version !== REPURPOSE_MANIFEST_VERSION) {
    contractError('manifest.version', `expected ${REPURPOSE_MANIFEST_VERSION}`);
  }
  if (manifest.protocol_version !== REPURPOSE_PROTOCOL_VERSION) {
    contractError('manifest.protocol_version', `expected ${REPURPOSE_PROTOCOL_VERSION}`);
  }
  requireNullableString(manifest.engine_version, 'manifest.engine_version');
  validateSource(manifest.source);
  if (!Number.isInteger(manifest.requested_clip_count) || manifest.requested_clip_count < 1) {
    contractError('manifest.requested_clip_count', 'must be a positive integer');
  }
  requireNonEmptyString(manifest.content_type, 'manifest.content_type');
  if (!Array.isArray(manifest.target_platforms) || manifest.target_platforms.length === 0) {
    contractError('manifest.target_platforms', 'must be a non-empty array');
  }
  if (new Set(manifest.target_platforms).size !== manifest.target_platforms.length) {
    contractError('manifest.target_platforms', 'must not contain duplicates');
  }
  manifest.target_platforms.forEach((target, index) => {
    requireNonEmptyString(target, `manifest.target_platforms.${index}`);
  });
  if (manifest.render_mode !== REPURPOSE_RENDER_MODE) {
    contractError('manifest.render_mode', `must be ${REPURPOSE_RENDER_MODE}`);
  }
  validateRenderDefaults(manifest.render_defaults);
  validateStages(manifest.stages);
  validateCandidates(manifest.candidates);
  if (!Array.isArray(manifest.outputs)) contractError('manifest.outputs', 'must be an array');
  manifest.outputs.forEach((output, index) => requireNonEmptyString(output, `manifest.outputs.${index}`));
  requireIsoDate(manifest.created_at, 'manifest.created_at');
  requireIsoDate(manifest.updated_at, 'manifest.updated_at');
  return manifest;
}

function defaultStages() {
  return Object.fromEntries(REPURPOSE_STAGES.map(stage => [
    stage,
    { state: 'pending', artifact: null, error: null },
  ]));
}

function buildRenderDefaults(overrides = {}) {
  return {
    aspect_ratio: overrides.aspect_ratio || '9:16',
    crop_mode: overrides.crop_mode || 'auto',
    captions: {
      enabled: overrides.captions?.enabled ?? true,
      style: overrides.captions?.style || 'clean',
      translation_target_language: overrides.captions?.translation_target_language ?? null,
    },
  };
}

export class RepurposeProject {
  constructor(dir, manifest) {
    this.dir = dir;
    this.manifest = manifest;
  }

  static create(dir, {
    source,
    requestedClipCount = 5,
    contentType = 'auto',
    targetPlatforms = ['youtube_shorts'],
    renderDefaults = {},
  } = {}) {
    requireNonEmptyString(dir, 'project_dir');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, REPURPOSE_MANIFEST_NAME);
    if (fs.existsSync(file)) throw new Error(`Refusing to overwrite existing manifest: ${file}`);
    const now = new Date().toISOString();
    const manifest = {
      id: `repurpose_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      version: REPURPOSE_MANIFEST_VERSION,
      protocol_version: REPURPOSE_PROTOCOL_VERSION,
      engine_version: null,
      source: {
        type: source?.type,
        uri: source?.uri,
        fingerprint: source?.fingerprint ?? null,
      },
      requested_clip_count: requestedClipCount,
      content_type: contentType,
      target_platforms: [...targetPlatforms],
      render_mode: REPURPOSE_RENDER_MODE,
      render_defaults: renderDefaults && typeof renderDefaults === 'object'
        ? buildRenderDefaults(renderDefaults)
        : buildRenderDefaults(),
      stages: defaultStages(),
      candidates: [],
      outputs: [],
      created_at: now,
      updated_at: now,
    };
    validateRepurposeManifest(manifest);
    atomicWriteJson(file, manifest);
    return new RepurposeProject(dir, manifest);
  }

  static load(dir) {
    const file = path.join(dir, REPURPOSE_MANIFEST_NAME);
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    validateRepurposeManifest(manifest);
    return new RepurposeProject(dir, manifest);
  }

  save() {
    this.manifest.updated_at = new Date().toISOString();
    validateRepurposeManifest(this.manifest);
    atomicWriteJson(path.join(this.dir, REPURPOSE_MANIFEST_NAME), this.manifest);
    return this;
  }

  startStage(stage) {
    validateStageName(stage);
    const index = REPURPOSE_STAGES.indexOf(stage);
    if (index > 0) {
      const prerequisite = REPURPOSE_STAGES[index - 1];
      if (this.manifest.stages[prerequisite].state !== 'completed') {
        throw new Error(`Cannot start ${stage}: prerequisite ${prerequisite} is not completed`);
      }
    }
    const record = this.manifest.stages[stage];
    if (!['pending', 'failed'].includes(record.state)) {
      throw new Error(`Illegal Repurpose stage transition ${stage}: ${record.state} → running`);
    }
    record.state = 'running';
    record.artifact = null;
    record.error = null;
    this.save();
    return record;
  }

  completeStage(stage, { artifact = null } = {}) {
    validateStageName(stage);
    const record = this.manifest.stages[stage];
    if (record.state !== 'running') {
      throw new Error(`Illegal Repurpose stage transition ${stage}: ${record.state} → completed`);
    }
    record.state = 'completed';
    record.artifact = artifact;
    record.error = null;
    this.save();
    return record;
  }

  failStage(stage, error) {
    validateStageName(stage);
    const record = this.manifest.stages[stage];
    if (record.state !== 'running') {
      throw new Error(`Illegal Repurpose stage transition ${stage}: ${record.state} → failed`);
    }
    requireNonEmptyString(String(error || ''), 'error');
    record.state = 'failed';
    record.artifact = null;
    record.error = String(error);
    this.save();
    return record;
  }

  applyIngestArtifact(artifact, { artifactPath = DEFAULT_INGEST_ARTIFACT } = {}) {
    validateIngestArtifact(artifact);
    requireNonEmptyString(artifactPath, 'artifact_path');
    if (this.manifest.source.type !== 'local_file') {
      throw new Error('Cannot apply a local ingest artifact to a non-local source');
    }

    const previousFingerprint = this.manifest.source.fingerprint;
    const sourceChanged = previousFingerprint !== artifact.source.fingerprint;
    this.manifest.source.uri = path.normalize(artifact.source.path);
    this.manifest.source.fingerprint = artifact.source.fingerprint;
    this.manifest.engine_version = artifact.engine_version;
    this.manifest.stages.ingest = {
      state: 'completed',
      artifact: artifactPath,
      error: null,
    };

    if (sourceChanged) {
      for (const stage of REPURPOSE_STAGES.slice(1)) {
        this.manifest.stages[stage] = { state: 'pending', artifact: null, error: null };
      }
      this.manifest.candidates = [];
      this.manifest.outputs = [];
    }
    this.save();
    return { sourceChanged, manifest: this.manifest };
  }

  addCandidate({ proposedStartSec = null, proposedEndSec = null, metadata = {} } = {}) {
    const id = `clip_${String(this.manifest.candidates.length + 1).padStart(3, '0')}`;
    const candidate = {
      id,
      decision: 'pending',
      selected: false,
      proposed_start_sec: proposedStartSec,
      proposed_end_sec: proposedEndSec,
      metadata: { ...metadata },
    };
    this.manifest.candidates.push(candidate);
    this.save();
    return candidate;
  }

  getCandidate(id) {
    if (typeof id !== 'string' || !CLIP_ID_RE.test(id)) {
      throw new Error(`Malformed candidate id "${id}" — expected clip_NNN`);
    }
    const candidate = this.manifest.candidates.find(item => item.id === id);
    if (!candidate) throw new Error(`No candidate ${id} in project ${this.manifest.id}`);
    return candidate;
  }

  setCandidateDecision(id, decision) {
    if (!REPURPOSE_CANDIDATE_DECISIONS.includes(decision)) {
      throw new Error(`Unknown candidate decision "${decision}"`);
    }
    const candidate = this.getCandidate(id);
    candidate.decision = decision;
    if (decision !== 'approved') candidate.selected = false;
    this.save();
    return candidate;
  }

  selectCandidate(id, selected = true) {
    const candidate = this.getCandidate(id);
    if (selected && candidate.decision !== 'approved') {
      throw new Error(`Cannot select ${id}: candidate is not approved`);
    }
    candidate.selected = Boolean(selected);
    this.save();
    return candidate;
  }

  canRender() {
    const selected = this.manifest.candidates.filter(candidate => candidate.selected);
    return selected.length > 0 && selected.every(candidate => candidate.decision === 'approved');
  }
}
