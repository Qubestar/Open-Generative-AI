// Editor — the canonical Vidmyo capability for turning a folder of footage into an
// edited video with a chosen engine.
//
// ONE implementation, three surfaces:
//   desktop Editor tab  ─┐
//   CLI / scripts       ─┼─→ EditorService → EditorProject → job store
//   MCP (editor_*)      ─┘
//
// The UI never runs inference and the MCP tool never runs inference: both create
// the same `editor` job and call `runEditorJob`, which drives the stage list
// recorded in the project manifest. Each stage writes its own artifact, so a
// later-stage failure (build, render) never re-runs transcription.
//
// Engines are data (`EDITOR_ENGINES`) so a V2/V3 style can be added without
// touching the desktop surface. V1 ships two modes: `original` (the bundled
// documentary look) and `custom` (a style profile measured off example videos the
// user picked, optionally saved as a reusable template).
//
// Everything here is pure Node ESM: no Electron, no DOM, no network. Subprocess
// work lives in `editorEngines.js`, injected so tests can use deterministic fakes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const EDITOR_CONTRACT_VERSION = 1;
export const EDITOR_PROJECT_KIND = 'vidmyo.editor';
export const EDITOR_JOB_TYPE = 'editor';
export const EDITOR_ANALYSIS_JOB_TYPE = 'editor-analysis';
export const EDITOR_TEMPLATE_KIND = 'vidmyo.editor.template';
export const EDITOR_CONFIG_VERSION = 1;

// ── Engines ─────────────────────────────────────────────────────────────────
// Data, never an if-chain in the UI: an engine is a style source that the runner
// can drive. `modes` decides which mode switches the tab shows.

export const EDITOR_ENGINES = [
  {
    id: 'v1',
    name: 'V1',
    description: 'Documentary edit: real pictures, measured devices, a click on every change.',
    modes: ['original', 'custom'],
    version: '1.0.0',
  },
];

export const EDITOR_MODES = ['original', 'custom'];

export function editorEngine(id) {
  const normalized = String(id || 'v1').trim().toLowerCase();
  const found = EDITOR_ENGINES.find(engine => engine.id === normalized);
  if (!found) throw new Error(`Unknown editor engine: ${id}`);
  return found;
}

// ── Pipeline ────────────────────────────────────────────────────────────────

export const EDITOR_STAGES = [
  'probe', 'prepare', 'transcribe', 'assets', 'plan', 'build', 'render', 'mix', 'finish', 'validate',
];

export const EDITOR_STAGE_DEPENDENCIES = {
  probe: [],
  prepare: ['probe'],
  transcribe: ['prepare'],
  assets: ['transcribe'],
  plan: ['assets'],
  build: ['plan'],
  render: ['build'],
  mix: ['render'],
  finish: ['mix'],
  validate: ['finish'],
};

export const EDITOR_PROGRESS_LABELS = {
  probe: 'Inspecting footage',
  prepare: 'Preparing camera plate and voice',
  transcribe: 'Transcribing the take',
  assets: 'Collecting pictures for every line',
  plan: 'Planning the edit',
  build: 'Building the composition',
  render: 'Rendering the picture',
  mix: 'Mixing the bed and the clicks',
  finish: 'Finishing the master',
  validate: 'Checking the finished video',
};

export const EDITOR_STAGE_ARTIFACTS = {
  probe: 'artifacts/probe.json',
  prepare: 'work/cam_raw.mp4',
  transcribe: 'artifacts/transcript.json',
  assets: 'artifacts/assets.json',
  plan: 'artifacts/plan.json',
  build: 'comp/index.html',
  render: 'out/render.mp4',
  mix: 'out/mixed.mp4',
  finish: 'out/final.mp4',
  validate: 'artifacts/validate.json',
};

export const EDITOR_ANALYSIS_STAGES = ['download', 'analyze'];

// ── Options ─────────────────────────────────────────────────────────────────

export const EDITOR_QUALITIES = ['draft', 'standard', 'high'];
export const EDITOR_PACINGS = ['reference', 'long'];
export const EDITOR_MODES_LABEL = { original: 'Original', custom: 'Custom' };

export const MEDIA_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi', '.mpg', '.mpeg', '.ts'];
export const MEDIA_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.bmp'];

export const DEFAULT_EDITOR_OPTIONS = Object.freeze({
  engine: 'v1',
  mode: 'original',
  template_id: null,
  quality: 'standard',
  pacing: 'reference',
  face_share: 0.3,
  music_path: null,
  cut_out: false,
  max_minutes: 20,
  examples: [],
});

const BOOLEAN_OPTION_KEYS = ['cut_out'];

function absoluteLocalPath(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a path.`);
  const raw = value.trim();
  if (raw.includes('\0')) throw new Error(`${label} is not a valid path.`);
  if (!path.isAbsolute(raw)) throw new Error(`${label} must be an absolute path.`);
  return path.normalize(raw);
}

export function normalizeEditorOptions(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Editor options must be an object.');
  const options = { ...DEFAULT_EDITOR_OPTIONS };

  if (raw.engine !== undefined && raw.engine !== null) {
    options.engine = editorEngine(raw.engine).id;
  }
  if (raw.mode !== undefined && raw.mode !== null) {
    const value = String(raw.mode).trim().toLowerCase();
    if (!EDITOR_MODES.includes(value)) throw new Error('Mode must be "original" or "custom".');
    options.mode = value;
  }
  if (raw.template_id !== undefined && raw.template_id !== null && raw.template_id !== '') {
    const value = String(raw.template_id).trim();
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/i.test(value)) throw new Error('template_id must be a template slug.');
    options.template_id = value.toLowerCase();
    options.mode = 'custom';
  }
  if (options.mode === 'custom' && !options.template_id) {
    // Custom without a saved template is allowed: the examples gathered for this
    // run define the style. The UI makes that distinction visible.
    options.template_id = null;
  }

  if (raw.quality !== undefined && raw.quality !== null) {
    const value = String(raw.quality).trim().toLowerCase();
    if (!EDITOR_QUALITIES.includes(value)) throw new Error(`Quality must be one of: ${EDITOR_QUALITIES.join(', ')}.`);
    options.quality = value;
  }
  if (raw.pacing !== undefined && raw.pacing !== null) {
    const value = String(raw.pacing).trim().toLowerCase();
    if (!EDITOR_PACINGS.includes(value)) throw new Error('Pacing must be "reference" or "long".');
    options.pacing = value;
  }
  if (raw.face_share !== undefined && raw.face_share !== null) {
    const value = Number(raw.face_share);
    if (!Number.isFinite(value) || value < 0 || value > 0.8) throw new Error('face_share must be between 0 and 0.8.');
    options.face_share = value;
  }
  if (raw.max_minutes !== undefined && raw.max_minutes !== null) {
    const value = Number(raw.max_minutes);
    if (!Number.isFinite(value) || value < 0.2 || value > 180) throw new Error('max_minutes must be between 0.2 and 180.');
    options.max_minutes = value;
  }
  for (const key of BOOLEAN_OPTION_KEYS) {
    if (raw[key] === undefined || raw[key] === null) continue;
    if (typeof raw[key] !== 'boolean') throw new Error(`Option ${key} must be true or false.`);
    options[key] = raw[key];
  }
  if (raw.music_path !== undefined && raw.music_path !== null && raw.music_path !== '') {
    options.music_path = absoluteLocalPath(raw.music_path, 'Music bed');
    const ext = path.extname(options.music_path).toLowerCase();
    if (!['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.aiff', '.aif'].includes(ext)) {
      throw new Error('Music bed must be an audio file (mp3, wav, m4a, aac, flac, ogg, aiff).');
    }
  }
  if (Array.isArray(raw.examples)) {
    options.examples = raw.examples
      .map(item => String(item ?? '').trim())
      .filter(Boolean)
      .slice(0, 40);
    for (const item of options.examples) {
      if (item.length > 2048) throw new Error('An example reference is too long.');
    }
  } else if (raw.examples !== undefined && raw.examples !== null) {
    throw new Error('examples must be a list.');
  }

  return Object.freeze(options);
}

/** Which stages a project runs. Every stage is listed; the runner decides skips. */
export function planEditorStages(options = {}) {
  const stages = [...EDITOR_STAGES];
  if (!options.music_path) {
    // No bed: mix still "runs" (it copies the render) so the artifact chain and
    // the progress checklist stay honest — it is marked skipped by the runner.
    return stages;
  }
  return stages;
}

export function nextStageFor(stages = []) {
  const entry = stages.find(stage => stage.status === 'pending' || stage.status === 'failed' || stage.status === 'running');
  return entry ? entry.id : null;
}

// ── Paths ───────────────────────────────────────────────────────────────────

export function editorHomeDir() {
  return process.env.VIDMYO_EDITOR_HOME || path.join(os.homedir(), '.vidmyo', 'editor');
}

export function editorProjectsDir() {
  return process.env.VIDMYO_EDITOR_PROJECTS_DIR || path.join(editorHomeDir(), 'projects');
}

export function editorTemplatesDir() {
  return process.env.VIDMYO_EDITOR_TEMPLATES_DIR || path.join(editorHomeDir(), 'templates');
}

export function editorSkillDir() {
  if (process.env.VIDMYO_EDITOR_SKILL_DIR) return path.resolve(process.env.VIDMYO_EDITOR_SKILL_DIR);
  // fileURLToPath, not URL.pathname: the repo lives under a path with spaces
  // ("/Volumes/My Lexar/…") and pathname keeps the %20 escapes, which makes every
  // kit script look missing.
  return path.resolve(fileURLToPath(new URL('../../editor-engine/skill/', import.meta.url)));
}

function slugify(value, fallback = 'edit') {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

function stamp(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// ── Input / output ──────────────────────────────────────────────────────────

/**
 * The user names a folder of footage (the MCP sentence "edit my footage located in
 * folder XYZ") or a single file. Both become `{ type, path, name }`.
 */
export function normalizeEditorInput(input) {
  const raw = typeof input === 'string' ? input : input?.path || input?.input_dir || input?.input;
  const resolved = absoluteLocalPath(raw, 'Footage');
  if (!fs.existsSync(resolved)) throw new Error(`Footage not found: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    return { type: 'folder', path: resolved, name: path.basename(resolved) || 'footage' };
  }
  if (!stat.isFile()) throw new Error('Footage must be a folder or a video file.');
  const ext = path.extname(resolved).toLowerCase();
  if (!MEDIA_VIDEO_EXTENSIONS.includes(ext)) throw new Error(`Unsupported footage type: ${ext || 'no extension'}`);
  return { type: 'file', path: resolved, name: path.basename(resolved, ext) };
}

/** Walk a footage folder for usable pictures, deterministically ordered. */
export function listFootage(dir) {
  const out = [];
  const walk = (current, depth) => {
    if (depth > 6) return;
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (MEDIA_VIDEO_EXTENSIONS.includes(ext)) out.push({ kind: 'video', path: full, name: entry.name });
      else if (MEDIA_IMAGE_EXTENSIONS.includes(ext)) out.push({ kind: 'image', path: full, name: entry.name });
    }
  };
  walk(dir, 0);
  return out;
}

export function normalizeEditorOutput(output, { input = null, jobId = null } = {}) {
  if (output === undefined || output === null || output === '') {
    const base = input ? path.join(path.dirname(input.path), `${input.name || 'edit'}-editor`) : editorProjectsDir();
    return path.join(base, `${slugify(input?.name || 'edit')}-${stamp()}`);
  }
  const resolved = absoluteLocalPath(output, 'Output folder');
  return path.join(resolved, `${slugify(input?.name || 'edit')}-${stamp()}${jobId ? `-${String(jobId).slice(-4)}` : ''}`);
}

// ── Project ─────────────────────────────────────────────────────────────────

export class EditorProject {
  constructor(dir, manifest) {
    this.dir = path.resolve(dir);
    this.manifest = manifest;
  }

  static create(dir, { input, output = null, options, jobId = null } = {}) {
    const resolved = path.resolve(dir);
    fs.mkdirSync(path.join(resolved, 'artifacts'), { recursive: true });
    const manifest = {
      contract_version: EDITOR_CONTRACT_VERSION,
      kind: EDITOR_PROJECT_KIND,
      created_at: new Date().toISOString(),
      job_id: jobId,
      input,
      output: output ? path.resolve(output) : null,
      options,
      stages: planEditorStages(options).map(id => ({
        id, status: 'pending', artifact: null, error: null, metrics: null,
      })),
      outputs: [],
      warnings: [],
    };
    const file = path.join(resolved, 'manifest.json');
    if (fs.existsSync(file)) throw new Error('That editor project already exists; choose a different folder.');
    atomicWriteJson(file, manifest);
    return new EditorProject(resolved, manifest);
  }

  static load(dir) {
    const resolved = path.resolve(dir);
    const manifest = JSON.parse(fs.readFileSync(path.join(resolved, 'manifest.json'), 'utf8'));
    if (manifest.kind !== EDITOR_PROJECT_KIND) throw new Error('That directory is not a Vidmyo editor project.');
    return new EditorProject(resolved, manifest);
  }

  static exists(dir) {
    try { return fs.existsSync(path.join(path.resolve(dir), 'manifest.json')); } catch { return false; }
  }

  save() {
    atomicWriteJson(path.join(this.dir, 'manifest.json'), this.manifest);
    return this.manifest;
  }

  artifactPath(relative) {
    if (typeof relative !== 'string' || !relative) throw new Error('An artifact path is required.');
    const resolved = path.resolve(this.dir, relative);
    const rel = path.relative(this.dir, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Artifact path escapes the project.');
    return resolved;
  }

  hasArtifact(relative) {
    try {
      const file = this.artifactPath(relative);
      return fs.existsSync(file) && fs.statSync(file).size > 0;
    } catch { return false; }
  }

  readJson(relative) {
    return JSON.parse(fs.readFileSync(this.artifactPath(relative), 'utf8'));
  }

  writeJson(relative, value) {
    const file = this.artifactPath(relative);
    atomicWriteJson(file, value);
    return file;
  }

  stage(id) {
    const entry = this.manifest.stages.find(item => item.id === id);
    if (!entry) throw new Error(`Stage ${id} is not part of this editor project.`);
    return entry;
  }

  stageStatus(id) {
    return this.stage(id).status;
  }

  setStage(id, patch = {}) {
    const entry = this.stage(id);
    Object.assign(entry, patch);
    this.save();
    return entry;
  }

  setRunning(id) {
    return this.setStage(id, { status: 'running', startedAt: new Date().toISOString(), error: null });
  }

  setDone(id, { artifact = null, metrics = null } = {}) {
    return this.setStage(id, {
      status: 'done', artifact, metrics: metrics || null, endedAt: new Date().toISOString(), error: null,
    });
  }

  setFailed(id, error) {
    return this.setStage(id, {
      status: 'failed', error: String(error?.message || error).slice(0, 2000), endedAt: new Date().toISOString(),
    });
  }

  setSkipped(id, reason) {
    return this.setStage(id, {
      status: 'skipped', error: reason ? String(reason).slice(0, 500) : null, endedAt: new Date().toISOString(),
    });
  }

  hydrate() {
    // A stage counts as done when its artifact is on disk, whatever the manifest
    // says — that is what makes a retry cheap.
    for (const stage of this.manifest.stages) {
      const artifact = EDITOR_STAGE_ARTIFACTS[stage.id];
      if (!artifact) continue;
      if (stage.status === 'pending' && this.hasArtifact(artifact)) {
        stage.status = 'done';
        stage.artifact = artifact;
      }
    }
  }

  nextStage() {
    this.hydrate();
    return nextStageFor(this.manifest.stages);
  }

  progress() {
    const done = this.manifest.stages.filter(stage => ['done', 'skipped'].includes(stage.status)).length;
    return Math.round((done / Math.max(1, this.manifest.stages.length)) * 100);
  }

  warn(message) {
    const text = String(message ?? '').slice(0, 500);
    if (!text) return text;
    this.manifest.warnings.push(text);
    if (this.manifest.warnings.length > 100) this.manifest.warnings.splice(0, this.manifest.warnings.length - 100);
    this.save();
    return text;
  }

  addOutput(entry) {
    this.manifest.outputs.push({ ...entry, createdAt: new Date().toISOString() });
    this.save();
    return entry;
  }
}

// ── Templates ───────────────────────────────────────────────────────────────
// A template is a measured style the user chose to keep: the profile (rhythm,
// palette, treatments) plus the examples it came from. User data, never the repo.

export class EditorTemplateStore {
  constructor(dir = editorTemplatesDir()) {
    this.dir = path.resolve(dir);
  }

  ensure() {
    fs.mkdirSync(this.dir, { recursive: true });
    return this.dir;
  }

  pathFor(id) {
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(String(id || ''))) throw new Error('Invalid template id.');
    return path.join(this.dir, String(id));
  }

  list({ engine = null } = {}) {
    this.ensure();
    let entries = [];
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => entry.name);
    } catch { return []; }
    const templates = [];
    for (const id of entries.sort()) {
      try {
        const template = this.get(id);
        if (!template) continue;
        if (engine && template.engine !== engine) continue;
        templates.push(summarizeTemplate(template));
      } catch { /* a corrupt template must not hide the others */ }
    }
    return templates;
  }

  get(id) {
    const file = path.join(this.pathFor(id), 'template.json');
    if (!fs.existsSync(file)) return null;
    const template = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (template.kind !== EDITOR_TEMPLATE_KIND) throw new Error('That folder is not an editor template.');
    return template;
  }

  save({ name, profile, examples = [], engine = 'v1', notes = null, id = null } = {}) {
    const label = String(name || '').trim();
    if (!label) throw new Error('A template needs a name.');
    if (label.length > 80) throw new Error('Template name is too long (80 characters max).');
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('A template needs a style profile.');
    const engineId = editorEngine(engine).id;
    const digest = crypto.createHash('sha1')
      .update(`${label}\u0000${engineId}\u0000${Date.now()}`)
      .digest('hex').slice(0, 6);
    const templateId = id ? String(id).toLowerCase() : `${slugify(label, 'style')}-${digest}`;
    const dir = this.pathFor(templateId);
    fs.mkdirSync(dir, { recursive: true });
    const template = {
      contract_version: EDITOR_CONTRACT_VERSION,
      kind: EDITOR_TEMPLATE_KIND,
      id: templateId,
      name: label,
      engine: engineId,
      created_at: new Date().toISOString(),
      examples: examples.map(item => String(item)).slice(0, 40),
      notes: notes ? String(notes).slice(0, 1000) : null,
      profile,
    };
    atomicWriteJson(path.join(dir, 'template.json'), template);
    return template;
  }

  remove(id) {
    const dir = this.pathFor(id);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }
}

export function summarizeTemplate(template) {
  // `profile` is either the analysis artifact (with a nested `style` block) or a
  // bare style block, depending on how the template was created.
  const raw = template.profile || {};
  const profile = raw.style && typeof raw.style === 'object' ? raw.style : raw;
  return {
    id: template.id,
    name: template.name,
    engine: template.engine,
    created_at: template.created_at,
    examples: (template.examples || []).slice(0, 8),
    cut_median_s: profile.cut_median_s ?? profile.shot_median_s ?? null,
    cuts_per_minute: profile.cuts_per_minute ?? null,
    palette: Array.isArray(profile.palette) ? profile.palette.slice(0, 6) : [],
  };
}

// ── Capabilities ────────────────────────────────────────────────────────────

export function editorCapabilities({ engines = null } = {}) {
  const discovered = engines?.capabilities ? engines.capabilities() : null;
  const templates = (() => {
    try { return new EditorTemplateStore().list(); } catch { return []; }
  })();
  return {
    contract_version: EDITOR_CONTRACT_VERSION,
    engines: EDITOR_ENGINES.map(engine => ({ ...engine, modes: [...engine.modes] })),
    modes: EDITOR_MODES.map(id => ({ id, label: EDITOR_MODES_LABEL[id] })),
    qualities: EDITOR_QUALITIES,
    pacings: EDITOR_PACINGS,
    devices: discovered?.devices || null,
    tools: discovered?.tools || null,
    template_count: templates.length,
    skill_dir: editorSkillDir(),
    cut_out_available: Boolean(discovered?.cutOut),
  };
}

// ── Service ─────────────────────────────────────────────────────────────────

export class EditorService {
  constructor({ store, engines, projectsDir = editorProjectsDir(), templates = null, governor = null } = {}) {
    if (!store) throw new Error('EditorService requires a job store');
    if (!engines) throw new Error('EditorService requires editor engines');
    this.store = store;
    this.engines = engines;
    this.projectsDir = projectsDir;
    this.templates = templates || new EditorTemplateStore();
    this.governor = governor || store.governor || null;
  }

  async capabilities() {
    return editorCapabilities({ engines: this.engines });
  }

  /** Create the project + job. Never starts work — the caller launches `run`. */
  create({ input, output = null, options = {}, templateId = null } = {}) {
    const normalizedInput = normalizeEditorInput(input);
    const merged = { ...options };
    if (templateId && !merged.template_id) merged.template_id = templateId;
    if (merged.template_id) {
      const template = this.templates.get(merged.template_id);
      if (!template) throw new Error(`Template not found: ${merged.template_id}`);
      if (merged.engine && template.engine !== merged.engine) throw new Error('That template belongs to a different engine.');
      merged.engine = template.engine;
      merged.mode = 'custom';
    }
    const normalizedOptions = normalizeEditorOptions(merged);
    const jobId = `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const dir = normalizeEditorOutput(output, { input: normalizedInput, jobId });
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
      throw new Error('That output folder is already in use; pick another one.');
    }
    const job = this.store.create({
      id: jobId,
      type: EDITOR_JOB_TYPE,
      params: {
        surface: 'editor',
        input: normalizedInput,
        options: normalizedOptions,
        projectDir: dir,
        output: output ? path.resolve(output) : null,
        resourceClass: 'heavy',
      },
    });
    const project = EditorProject.create(dir, {
      input: normalizedInput, output: output ? path.resolve(output) : null, options: normalizedOptions, jobId: job.id,
    });
    this.store.checkpoint(job.id, 'stage', project.nextStage());
    this.store.checkpoint(job.id, 'progress', 0);
    this.store.log(job.id, `editor queued: ${normalizedInput.type} ${normalizedInput.name} (${normalizedOptions.engine}/${normalizedOptions.mode})`);
    return { job: this.store.get(job.id), project };
  }

  /**
   * Retry a failed or cancelled job. Job records are immutable history, so a
   * retry is a NEW job over the SAME project: the runner skips every stage whose
   * artifact already exists.
   */
  retry(jobId) {
    const existing = this.store.get(jobId);
    if (!existing || existing.type !== EDITOR_JOB_TYPE) throw new Error('No such editor job.');
    const dir = existing.params?.projectDir;
    if (!dir || !EditorProject.exists(dir)) throw new Error('The editor project for that job is missing.');
    const project = EditorProject.load(dir);
    const stage = project.nextStage();
    if (!stage) throw new Error('That edit already completed every stage.');
    const job = this.store.create({
      id: `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      type: EDITOR_JOB_TYPE,
      params: { ...existing.params, projectDir: dir, resourceClass: 'heavy' },
    });
    this.store.checkpoint(job.id, 'stage', stage);
    this.store.checkpoint(job.id, 'progress', project.progress());
    this.store.log(job.id, `retry of ${jobId}; resuming at ${stage}`);
    return { job: this.store.get(job.id), project };
  }

  get(jobId) {
    const job = this.store.get(jobId);
    if (!job || job.type !== EDITOR_JOB_TYPE) return null;
    const dir = job.params?.projectDir;
    const project = dir && EditorProject.exists(dir) ? EditorProject.load(dir) : null;
    return { job, project, summary: editorJobSummary(job, { project }) };
  }

  list({ state = null, limit = 50 } = {}) {
    const bounded = Math.max(1, Math.min(200, Number(limit) || 50));
    return this.store.list({ type: EDITOR_JOB_TYPE, state })
      .slice(0, bounded)
      .map(job => {
        const dir = job.params?.projectDir;
        const project = dir && EditorProject.exists(dir) ? safeLoadProject(dir) : null;
        return editorJobSummary(job, { project });
      });
  }

  cancel(jobId) {
    const job = this.store.get(jobId);
    if (!job || job.type !== EDITOR_JOB_TYPE) throw new Error('No such editor job.');
    return this.store.cancel(jobId);
  }

  /** Create an analysis job over example videos/URLs (style → template). */
  createAnalysis({ urls = [], videos = [], name = 'Style' } = {}) {
    const list = [
      ...(Array.isArray(urls) ? urls : []).map(url => ({ kind: 'url', value: String(url).trim() })),
      ...(Array.isArray(videos) ? videos : []).map(file => ({ kind: 'file', value: absoluteLocalPath(file, 'Example video') })),
    ].filter(item => item.value);
    if (!list.length) throw new Error('Give at least one example URL or video file.');
    for (const item of list) {
      if (item.kind === 'url' && !/^https?:\/\//i.test(item.value)) {
        throw new Error('Example URLs must start with http:// or https://.');
      }
      if (item.kind === 'file' && !fs.existsSync(item.value)) {
        throw new Error(`Example video not found: ${item.value}`);
      }
    }
    const label = String(name || 'Style').trim().slice(0, 80);
    const id = `ana_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const dir = path.join(this.projectsDir, `analysis-${id}`);
    fs.mkdirSync(path.join(dir, 'examples'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'request.json'), `${JSON.stringify({ label, examples: list }, null, 2)}\n`);
    const job = this.store.create({
      id: `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      type: EDITOR_ANALYSIS_JOB_TYPE,
      params: { surface: 'editor', kind: 'analysis', projectDir: dir, label, examples: list, resourceClass: 'heavy' },
    });
    this.store.log(job.id, `style analysis queued: ${list.length} example(s) → ${label}`);
    return { job: this.store.get(job.id), dir, label, examples: list };
  }

  getAnalysis(jobId) {
    const job = this.store.get(jobId);
    if (!job || job.type !== EDITOR_ANALYSIS_JOB_TYPE) return null;
    const dir = job.params?.projectDir;
    const profileFile = path.join(dir, 'style-profile.json');
    return {
      job,
      dir,
      profile: fs.existsSync(profileFile) ? JSON.parse(fs.readFileSync(profileFile, 'utf8')) : null,
    };
  }
}

function safeLoadProject(dir) {
  try { return EditorProject.load(dir); } catch { return null; }
}

// ── Summary (one shape for UI + MCP) ────────────────────────────────────────

export function editorJobSummary(job, { project = null } = {}) {
  if (!job) return null;
  const stages = project?.manifest?.stages || [];
  const current = stages.find(stage => stage.status === 'running')
    || stages.find(stage => stage.status === 'failed')
    || stages.find(stage => stage.status === 'pending')
    || null;
  const options = project?.manifest?.options || job.params?.options || {};
  const declaredOutputs = (project?.manifest?.outputs || []).map(entry => ({ ...entry }));
  const outputs = declaredOutputs.length
    ? declaredOutputs
    : stages
      .filter(stage => stage.artifact && stage.artifact.startsWith('out/') && stage.status === 'done')
      .map(stage => ({ kind: 'video', artifact: stage.artifact }));
  return {
    job_id: job.id,
    type: job.type,
    state: job.state,
    input: job.params?.input || null,
    output_dir: job.params?.projectDir || null,
    engine: options.engine || 'v1',
    mode: options.mode || 'original',
    template_id: options.template_id || null,
    stage: current?.id || null,
    stage_label: current ? EDITOR_PROGRESS_LABELS[current.id] || current.id : null,
    progress: project ? project.progress() : 0,
    stages: stages.map(stage => ({
      id: stage.id,
      status: stage.status,
      label: EDITOR_PROGRESS_LABELS[stage.id] || stage.id,
      artifact: stage.artifact || null,
      error: stage.error || null,
      metrics: stage.metrics || null,
    })),
    outputs,
    warnings: (project?.manifest?.warnings || []).slice(-20),
    error: job.error || null,
    metrics: job.checkpoints?.metrics || null,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    ended_at: job.endedAt,
    log_tail: (job.logs || []).slice(-5).map(entry => ({ at: entry.at, message: String(entry.message).slice(0, 400) })),
  };
}
