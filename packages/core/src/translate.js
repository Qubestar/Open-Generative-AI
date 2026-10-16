// Translate Video — the canonical Vidmyo capability for local video dubbing.
//
// ONE implementation, three surfaces:
//   desktop Translate tab  ─┐
//   CLI / scripts          ─┼─→ TranslateService → TranslateProject → job store
//   MCP (translate_video)  ─┘
//
// The UI never runs inference and the MCP tool never runs inference: both
// create the same `translate` job and call `runTranslateJob`, which drives the
// stage list recorded in the project manifest. Each stage writes its own
// artifact, so a later-stage failure (subtitles, lip sync) never re-runs
// transcription or translation.
//
// Everything here is pure Node ESM: no Electron, no DOM, no network of its own.
// Subprocess work lives in `translateEngines.js`, which is injected so tests can
// substitute deterministic fakes for the expensive inference.
//
// Local by default. No stage sends user media to a remote AI service; the only
// network access is fetching a video the user explicitly supplied by URL.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';

export const TRANSLATE_CONTRACT_VERSION = 1;
export const TRANSLATE_PROJECT_KIND = 'vidmyo.translate';
export const TRANSLATE_JOB_TYPE = 'translate';
export const TRANSLATE_CONFIG_VERSION = 1;

// Ordered pipeline. `planStages()` decides which of these a given job runs.
export const TRANSLATE_STAGES = [
  'import', 'analyze', 'extract_audio', 'transcribe', 'translate',
  'synthesize', 'align', 'mix', 'subtitles', 'lipsync', 'render', 'validate',
];

// A stage is never allowed to run before the stages it depends on.
export const STAGE_DEPENDENCIES = {
  import: [],
  analyze: ['import'],
  extract_audio: ['analyze'],
  transcribe: ['extract_audio'],
  translate: ['transcribe'],
  synthesize: ['translate'],
  align: ['synthesize'],
  mix: ['align'],
  subtitles: ['translate'],
  lipsync: ['mix'],
  render: ['mix', 'subtitles'],
  validate: ['render'],
};

export const STAGE_STATUSES = ['pending', 'running', 'done', 'failed', 'skipped'];

// The stages the desktop UI shows as a progress checklist, in human order.
export const TRANSLATE_PROGRESS_LABELS = {
  import: 'Downloaded / imported video',
  analyze: 'Analyzed video',
  extract_audio: 'Extracted audio',
  transcribe: 'Transcribed speech',
  translate: 'Translating',
  synthesize: 'Generating translated voice',
  align: 'Aligning timing',
  mix: 'Mixing audio',
  subtitles: 'Generating subtitles',
  lipsync: 'Lip sync',
  render: 'Rendering',
  validate: 'Validating output',
};

export const MAX_SOURCE_BYTES = 8 * 1024 * 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024 * 1024;

export const SOURCE_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi', '.mpg', '.mpeg', '.ts'];

// ── Languages ───────────────────────────────────────────────────────────────
// The catalog is the *display* source of truth. Which language pairs actually
// work is decided by capability discovery (`translateCapabilities`), never by
// hardcoding lists in the frontend.

export const TRANSLATE_LANGUAGE_CATALOG = [
  { code: 'en', name: 'English', native: 'English' },
  { code: 'pl', name: 'Polish', native: 'Polski' },
  { code: 'es', name: 'Spanish', native: 'Español' },
  { code: 'de', name: 'German', native: 'Deutsch' },
  { code: 'fr', name: 'French', native: 'Français' },
  { code: 'it', name: 'Italian', native: 'Italiano' },
  { code: 'pt', name: 'Portuguese', native: 'Português' },
  { code: 'nl', name: 'Dutch', native: 'Nederlands' },
  { code: 'sv', name: 'Swedish', native: 'Svenska' },
  { code: 'no', name: 'Norwegian', native: 'Norsk' },
  { code: 'da', name: 'Danish', native: 'Dansk' },
  { code: 'fi', name: 'Finnish', native: 'Suomi' },
  { code: 'cs', name: 'Czech', native: 'Čeština' },
  { code: 'sk', name: 'Slovak', native: 'Slovenčina' },
  { code: 'hu', name: 'Hungarian', native: 'Magyar' },
  { code: 'ro', name: 'Romanian', native: 'Română' },
  { code: 'uk', name: 'Ukrainian', native: 'Українська' },
  { code: 'ru', name: 'Russian', native: 'Русский' },
  { code: 'el', name: 'Greek', native: 'Ελληνικά' },
  { code: 'tr', name: 'Turkish', native: 'Türkçe' },
  { code: 'he', name: 'Hebrew', native: 'עברית' },
  { code: 'ar', name: 'Arabic', native: 'العربية' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी' },
  { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt' },
  { code: 'th', name: 'Thai', native: 'ไทย' },
  { code: 'ja', name: 'Japanese', native: '日本語' },
  { code: 'ko', name: 'Korean', native: '한국어' },
  { code: 'zh', name: 'Chinese', native: '中文' },
];

export const TRANSLATE_LANGUAGE_CODES = TRANSLATE_LANGUAGE_CATALOG.map(item => item.code);

export function translateLanguage(code) {
  const normalized = String(code || '').trim().toLowerCase().split(/[-_]/)[0];
  const found = TRANSLATE_LANGUAGE_CATALOG.find(item => item.code === normalized);
  if (!found) throw new Error(`Unsupported language: ${code}`);
  return found;
}

export function translateLanguageName(code) {
  return translateLanguage(code).name;
}

// ── Options ─────────────────────────────────────────────────────────────────

export const TRANSLATE_QUALITIES = ['fast', 'quality'];
export const BACKGROUND_MODES = ['duck', 'keep', 'replace', 'separate'];
export const VOICE_PROVIDER_IDS = ['auto', 'macos-say', 'voicebox', 'kokoro'];

export const DEFAULT_TRANSLATE_OPTIONS = {
  source_language: 'auto',
  target_language: 'pl',
  translate_audio: true,
  clone_voice: true,
  preserve_background: true,
  background_mode: 'duck',
  subtitles: true,
  burn_subtitles: false,
  lip_sync: false,
  quality: 'quality',
  voice_provider: 'auto',
  voice_id: null,
  translation_model: null,
  transcription_model: null,
  voice_reference: null,
};

const BOOLEAN_OPTION_KEYS = ['translate_audio', 'clone_voice', 'preserve_background', 'subtitles', 'burn_subtitles', 'lip_sync'];

/**
 * Validate and normalize user/agent supplied options. Throws on anything that
 * would silently change meaning — the caller surfaces the message verbatim.
 */
export function normalizeTranslateOptions(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Translation options must be an object.');
  const options = { ...DEFAULT_TRANSLATE_OPTIONS };

  if (raw.source_language !== undefined && raw.source_language !== null) {
    const value = String(raw.source_language).trim().toLowerCase();
    options.source_language = value === 'auto' ? 'auto' : translateLanguage(value).code;
  }
  if (raw.target_language !== undefined && raw.target_language !== null) {
    options.target_language = translateLanguage(String(raw.target_language).trim().toLowerCase()).code;
  }
  if (raw.source_language && options.source_language !== 'auto' && options.source_language === options.target_language) {
    throw new Error('Source and target language must differ, or set source language to auto-detect.');
  }

  for (const key of BOOLEAN_OPTION_KEYS) {
    if (raw[key] === undefined || raw[key] === null) continue;
    if (typeof raw[key] !== 'boolean') throw new Error(`Option ${key} must be true or false.`);
    options[key] = raw[key];
  }

  if (raw.quality !== undefined && raw.quality !== null) {
    const value = String(raw.quality).trim().toLowerCase();
    if (!TRANSLATE_QUALITIES.includes(value)) throw new Error('Quality must be "fast" or "quality".');
    options.quality = value;
  }
  if (raw.background_mode !== undefined && raw.background_mode !== null) {
    const value = String(raw.background_mode).trim().toLowerCase();
    if (!BACKGROUND_MODES.includes(value)) throw new Error('Background mode must be duck, keep, replace, or separate.');
    options.background_mode = value;
  }
  if (raw.voice_provider !== undefined && raw.voice_provider !== null) {
    const value = String(raw.voice_provider).trim().toLowerCase();
    if (!VOICE_PROVIDER_IDS.includes(value)) throw new Error(`Voice provider must be one of: ${VOICE_PROVIDER_IDS.join(', ')}.`);
    options.voice_provider = value;
  }

  for (const key of ['voice_id', 'translation_model', 'transcription_model', 'voice_reference']) {
    if (raw[key] === undefined || raw[key] === null || raw[key] === '') { options[key] = null; continue; }
    if (typeof raw[key] !== 'string') throw new Error(`Option ${key} must be a string.`);
    const value = raw[key].trim();
    if (value.length > 512) throw new Error(`Option ${key} is too long.`);
    options[key] = value;
  }

  if (!options.translate_audio) {
    options.clone_voice = false;
    options.background_mode = 'keep';
    options.lip_sync = false;
  }
  if (options.clone_voice && !options.voice_id) {
    // Voice cloning needs a chosen reference profile. Without one the job still
    // runs, but with standard TTS — the UI explains this before starting.
    options.voice_id = null;
  }
  if (!options.preserve_background) options.background_mode = 'replace';
  return options;
}

/**
 * Which stages a job runs, given its options. Optional stages stay in the list
 * as `skipped` so the UI can show the full checklist honestly.
 */
export function planStages(options) {
  const stages = ['import', 'analyze', 'extract_audio', 'transcribe', 'translate'];
  if (options.translate_audio) stages.push('synthesize', 'align', 'mix');
  if (options.subtitles) stages.push('subtitles');
  if (options.lip_sync) stages.push('lipsync');
  stages.push('render', 'validate');
  return stages;
}

// ── Input handling (URL + local file) ───────────────────────────────────────

export const TRANSFER_ENCODINGS = ['identity', 'chunked', 'gzip', 'deflate', 'br'];

function ipv4IsPublic(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;      // CGNAT
  if (a === 169 && b === 254) return false;                // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a >= 224) return false;                              // multicast / reserved
  return true;
}

function ipv6IsPublic(address) {
  const value = address.toLowerCase().split('%')[0];
  if (value === '::' || value === '::1') return false;
  if (value.startsWith('fe80') || value.startsWith('fc') || value.startsWith('fd')) return false;
  if (value.startsWith('ff')) return false;
  // IPv4-mapped addresses inherit the IPv4 rules.
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4IsPublic(mapped[1]);
  return true;
}

export function isPublicAddress(address) {
  if (!address) return false;
  const family = net.isIP(address);
  if (family === 4) return ipv4IsPublic(address);
  if (family === 6) return ipv6IsPublic(address);
  return false;
}

const BLOCKED_HOST_SUFFIXES = ['.local', '.internal', '.localhost', '.home', '.lan', '.corp', '.test', '.invalid', '.example'];

/**
 * Syntactic URL gate for an agent/user supplied video URL. Rejects non-HTTP
 * schemes, embedded credentials, loopback/private literals and metadata
 * hostnames. DNS resolution is checked again immediately before download
 * (`assertResolvablePublicHost`) because a hostname can point at a private IP.
 */
export function assertSafeSourceUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('A video URL is required.');
  const value = raw.trim();
  if (value.length > 2048) throw new Error('That video URL is too long.');
  let url;
  try { url = new URL(value); } catch { throw new Error('That is not a valid video URL.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https video URLs can be imported.');
  }
  if (url.username || url.password) throw new Error('Video URLs must not contain credentials.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) throw new Error('That video URL has no host.');
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('Local addresses cannot be imported as video URLs.');
  if (BLOCKED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))) {
    throw new Error('Internal network addresses cannot be imported as video URLs.');
  }
  if (host === 'metadata.google.internal') throw new Error('Internal network addresses cannot be imported as video URLs.');
  if (net.isIP(host) && !isPublicAddress(host)) {
    throw new Error('Private, loopback, and link-local addresses cannot be imported as video URLs.');
  }
  return url.toString();
}

/**
 * DNS-level SSRF guard. Called by the download engine right before spawning the
 * downloader so a public hostname cannot resolve into the LAN.
 */
export async function assertResolvablePublicHost(urlString, { lookupImpl = null } = {}) {
  const url = new URL(urlString);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw new Error('Private, loopback, and link-local addresses cannot be imported as video URLs.');
    return true;
  }
  const lookup = lookupImpl || ((name) => new Promise((resolve, reject) => {
    net.lookup(name, { all: true }, (error, addresses) => (error ? reject(error) : resolve(addresses)));
  }));
  let addresses;
  try {
    addresses = await lookup(host);
  } catch {
    throw new Error('That video host could not be resolved.');
  }
  const list = Array.isArray(addresses) ? addresses : [addresses];
  if (!list.length) throw new Error('That video host could not be resolved.');
  for (const entry of list) {
    const address = typeof entry === 'string' ? entry : entry?.address;
    if (!isPublicAddress(address)) {
      throw new Error('That video host resolves to a private or link-local address and cannot be imported.');
    }
  }
  return true;
}

export function sanitizeArtifactName(value) {
  const base = path.basename(String(value || 'source'));
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(-120);
  return cleaned || 'source';
}

/**
 * Normalize both input modes into ONE canonical input descriptor.
 *
 *   URL ───┐
 *          ├─→ { type: 'url' | 'file', uri } → import stage → media artifact
 *   File ──┘
 *
 * `type: 'media'` accepts an existing Vidmyo media reference, which must still
 * resolve to a local file the process can read.
 */
export function normalizeTranslateInput(input) {
  const value = typeof input === 'string' ? { uri: input } : input;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Provide a video URL, a local video file, or a Vidmyo media reference.');
  }
  const uri = value.uri ?? value.path ?? value.url ?? null;
  if (typeof uri !== 'string' || !uri.trim()) {
    throw new Error('Provide a video URL, a local video file, or a Vidmyo media reference.');
  }
  const declared = String(value.type || '').trim().toLowerCase();
  const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(uri.trim());

  if (declared === 'url' || (!declared && looksLikeUrl)) {
    return { type: 'url', uri: assertSafeSourceUrl(uri) };
  }
  if (declared && !['file', 'media', 'path', 'local_file'].includes(declared)) {
    throw new Error(`Unsupported input type: ${value.type}`);
  }
  return { type: declared === 'media' ? 'media' : 'file', uri: assertSafeLocalFile(uri) };
}

export function assertSafeLocalFile(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('A local video path is required.');
  const value = raw.trim();
  if (value.includes('\u0000')) throw new Error('That path is not a valid file path.');
  if (!path.isAbsolute(value)) throw new Error('Local video paths must be absolute.');
  const resolved = path.resolve(value);
  let stat;
  try { stat = fs.statSync(resolved); } catch { throw new Error('That local video file does not exist.'); }
  if (!stat.isFile()) throw new Error('That path is not a file.');
  if (stat.size === 0) throw new Error('That video file is empty.');
  if (stat.size > MAX_SOURCE_BYTES) throw new Error('That video is larger than the 8 GiB translate limit.');
  const extension = path.extname(resolved).toLowerCase();
  if (!SOURCE_VIDEO_EXTENSIONS.includes(extension)) {
    throw new Error(`Unsupported video format ${extension || '(none)'}. Supported: ${SOURCE_VIDEO_EXTENSIONS.join(', ')}.`);
  }
  return resolved;
}

// ── Project (durable, resumable) ────────────────────────────────────────────

export function translateProjectsDir() {
  // Kept beside the job store so a job's project is found the same way from the
  // desktop, the CLI, and MCP.
  return path.join(projectHomeDir(), 'translate');
}

function projectHomeDir() {
  // Local import to avoid a cycle: paths.js has no dependency on this module.
  const env = process.env.VIDMYO_HOME;
  if (env) return path.resolve(env);
  return path.join(process.env.HOME || process.cwd(), '.vidmyo');
}

export function defaultTranslateProjectDir(jobId) {
  return path.join(translateProjectsDir(), sanitizeArtifactName(jobId));
}

/** Resolve a project-relative reference, refusing traversal outside the project. */
export function insideTranslateProject(projectDir, relativePath) {
  const root = path.resolve(projectDir);
  const target = path.resolve(root, String(relativePath || ''));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('That artifact path is outside the translate project.');
  }
  return target;
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2));
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* moved or absent */ }
  }
}

export class TranslateProject {
  constructor(dir, manifest) {
    this.dir = path.resolve(dir);
    this.manifest = manifest;
  }

  static create(dir, { input, options, jobId = null, projectDir = null } = {}) {
    const resolved = path.resolve(projectDir || dir);
    fs.mkdirSync(path.join(resolved, 'artifacts'), { recursive: true });
    const manifest = {
      contract_version: TRANSLATE_CONTRACT_VERSION,
      kind: TRANSLATE_PROJECT_KIND,
      created_at: new Date().toISOString(),
      job_id: jobId,
      input,
      options,
      stages: planStages(options).map(id => ({ id, status: 'pending', artifact: null, error: null, metrics: null })),
      outputs: [],
      warnings: [],
    };
    const file = path.join(resolved, 'manifest.json');
    if (fs.existsSync(file)) throw new Error('That translate project already exists; choose a different folder.');
    atomicWriteJson(file, manifest);
    return new TranslateProject(resolved, manifest);
  }

  static load(dir) {
    const resolved = path.resolve(dir);
    const manifest = JSON.parse(fs.readFileSync(path.join(resolved, 'manifest.json'), 'utf8'));
    if (manifest.kind !== TRANSLATE_PROJECT_KIND) throw new Error('That directory is not a Vidmyo translate project.');
    return new TranslateProject(resolved, manifest);
  }

  static exists(dir) {
    try { return fs.existsSync(path.join(path.resolve(dir), 'manifest.json')); } catch { return false; }
  }

  save() {
    atomicWriteJson(path.join(this.dir, 'manifest.json'), this.manifest);
    return this.manifest;
  }

  stage(id) {
    const entry = this.manifest.stages.find(item => item.id === id);
    if (!entry) throw new Error(`Stage ${id} is not part of this translate project.`);
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
      status: 'done', artifact, metrics: metrics || null,
      endedAt: new Date().toISOString(), error: null,
    });
  }

  setFailed(id, error) {
    return this.setStage(id, {
      status: 'failed', error: String(error?.message || error).slice(0, 2000), endedAt: new Date().toISOString(),
    });
  }

  setSkipped(id, reason) {
    return this.setStage(id, { status: 'skipped', error: reason ? String(reason).slice(0, 500) : null, endedAt: new Date().toISOString() });
  }

  warn(message) {
    const text = String(message || '').slice(0, 500);
    if (text && !this.manifest.warnings.includes(text)) {
      this.manifest.warnings.push(text);
      this.save();
    }
    return text;
  }

  addOutput(output) {
    this.manifest.outputs.push(output);
    this.save();
    return output;
  }

  /** The next stage that still needs work, honoring dependencies. `null` = complete. */
  nextStage() {
    for (const entry of this.manifest.stages) {
      if (entry.status === 'done' || entry.status === 'skipped') continue;
      const dependencies = STAGE_DEPENDENCIES[entry.id] || [];
      const blocked = dependencies.some(id => {
        const dependency = this.manifest.stages.find(item => item.id === id);
        return dependency && dependency.status === 'failed';
      });
      if (blocked) continue;
      return entry.id;
    }
    return null;
  }

  isComplete() {
    return this.manifest.stages.every(entry => entry.status === 'done' || entry.status === 'skipped');
  }

  progress() {
    const total = this.manifest.stages.length || 1;
    const finished = this.manifest.stages.filter(entry => entry.status === 'done' || entry.status === 'skipped').length;
    return Math.round((finished / total) * 100);
  }

  /** Absolute path for a project-relative artifact reference. */
  artifactPath(relativePath) {
    return insideTranslateProject(this.dir, relativePath);
  }

  writeJson(relativePath, value) {
    const file = this.artifactPath(relativePath);
    atomicWriteJson(file, value);
    return file;
  }

  readJson(relativePath) {
    return JSON.parse(fs.readFileSync(this.artifactPath(relativePath), 'utf8'));
  }

  has(relativePath) {
    try {
      const stat = fs.statSync(this.artifactPath(relativePath));
      return stat.isFile() && stat.size > 0;
    } catch { return false; }
  }
}

// ── Public job shaping ──────────────────────────────────────────────────────

export function translateJobSummary(job, { project = null } = {}) {
  if (!job) return null;
  const manifest = project?.manifest || null;
  const stages = (manifest?.stages || []).map(entry => ({
    id: entry.id,
    label: TRANSLATE_PROGRESS_LABELS[entry.id] || entry.id,
    status: entry.status,
    error: entry.error || null,
  }));
  const current = stages.find(entry => entry.status === 'running')
    || stages.find(entry => entry.status === 'pending')
    || stages[stages.length - 1]
    || null;
  const options = manifest?.options || job.params?.options || {};
  return {
    contract_version: TRANSLATE_CONTRACT_VERSION,
    job_id: job.id,
    project_dir: job.params?.projectDir || null,
    state: job.state,
    stage: current?.id || null,
    stage_label: current?.label || null,
    progress: manifest ? (job.state === 'done' ? 100 : (() => {
      const total = manifest.stages.length || 1;
      const finished = manifest.stages.filter(entry => entry.status === 'done' || entry.status === 'skipped').length;
      return Math.round((finished / total) * 100);
    })()) : 0,
    stages,
    source_language: manifest?.language?.source || options.source_language || null,
    target_language: options.target_language || null,
    input: manifest?.input || job.params?.input || null,
    options,
    outputs: manifest?.outputs || [],
    warnings: manifest?.warnings || [],
    error: job.error || null,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    ended_at: job.endedAt,
    metrics: job.checkpoints?.metrics || null,
  };
}

// ── Service ─────────────────────────────────────────────────────────────────

/**
 * The ONE entry point for both surfaces. `engines` is injected (see
 * `translateEngines.js` `createTranslateEngines`) so tests can replace every
 * expensive stage with a deterministic fake.
 */
export class TranslateService {
  constructor({ store, engines, projectsDir = translateProjectsDir(), governor = null, now = () => Date.now() } = {}) {
    if (!store) throw new Error('TranslateService requires a job store');
    if (!engines) throw new Error('TranslateService requires translate engines');
    this.store = store;
    this.engines = engines;
    this.projectsDir = projectsDir;
    this.governor = governor || store.governor || null;
    this.now = now;
  }

  async capabilities() {
    return translateCapabilities({ engines: this.engines });
  }

  /** Create the project + job. Never starts work — the caller launches `run`. */
  create({ input, options = {}, projectDir = null } = {}) {
    const normalizedInput = normalizeTranslateInput(input);
    const normalizedOptions = normalizeTranslateOptions(options);
    const jobId = `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const dir = projectDir ? path.resolve(projectDir) : defaultTranslateProjectDir(jobId);
    if (projectDir && fs.existsSync(dir) && fs.readdirSync(dir).length) {
      throw new Error('That translate project folder must be empty.');
    }
    const job = this.store.create({
      id: jobId,
      type: TRANSLATE_JOB_TYPE,
      params: {
        surface: 'translate',
        input: normalizedInput,
        options: normalizedOptions,
        projectDir: dir,
        resourceClass: 'heavy',
      },
    });
    const project = TranslateProject.create(dir, {
      input: normalizedInput, options: normalizedOptions, jobId: job.id, projectDir: dir,
    });
    this.store.checkpoint(job.id, 'stage', project.nextStage());
    this.store.checkpoint(job.id, 'progress', 0);
    this.store.log(job.id, `translate queued: ${normalizedInput.type} → ${normalizedOptions.target_language}`);
    return { job: this.store.get(job.id), project };
  }

  /**
   * Retry a failed or cancelled job. Job records are immutable history, so a
   * retry is a NEW job over the SAME project: the runner skips every stage whose
   * artifact already exists, so a retry after a late-stage failure redoes only
   * that stage.
   */
  retry(jobId) {
    const existing = this.store.get(jobId);
    if (!existing || existing.type !== TRANSLATE_JOB_TYPE) throw new Error('No such translate job.');
    const dir = existing.params?.projectDir;
    if (!dir || !TranslateProject.exists(dir)) throw new Error('The translate project for that job is missing.');
    const project = TranslateProject.load(dir);
    const stage = project.nextStage();
    if (!stage) throw new Error('That translation already completed every stage.');
    const job = this.store.create({
      id: `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      type: TRANSLATE_JOB_TYPE,
      params: { ...existing.params, projectDir: dir, resourceClass: 'heavy' },
    });
    this.store.checkpoint(job.id, 'stage', stage);
    this.store.checkpoint(job.id, 'progress', project.progress());
    this.store.log(job.id, `retry of ${jobId}; resuming at ${stage}`);
    return { job: this.store.get(job.id), project };
  }

  get(jobId) {
    const job = this.store.get(jobId);
    if (!job || job.type !== TRANSLATE_JOB_TYPE) return null;
    const dir = job.params?.projectDir;
    const project = dir && TranslateProject.exists(dir) ? TranslateProject.load(dir) : null;
    return { job, project, summary: translateJobSummary(job, { project }) };
  }

  list({ state = null, limit = 50 } = {}) {
    const bounded = Math.max(1, Math.min(200, Number(limit) || 50));
    return this.store.list({ type: TRANSLATE_JOB_TYPE, state })
      .slice(0, bounded)
      .map(job => {
        const dir = job.params?.projectDir;
        const project = dir && TranslateProject.exists(dir) ? safeLoadProject(dir) : null;
        return translateJobSummary(job, { project });
      });
  }

  cancel(jobId) {
    const job = this.store.get(jobId);
    if (!job || job.type !== TRANSLATE_JOB_TYPE) throw new Error('No such translate job.');
    if (['done', 'error', 'cancelled'].includes(job.state)) return this.get(jobId).summary;
    this.store.cancel(jobId);
    return this.get(jobId).summary;
  }
}

function safeLoadProject(dir) {
  try { return TranslateProject.load(dir); } catch { return null; }
}

/**
 * Capability discovery — the UI and MCP both read this instead of hardcoding
 * language lists. A target language is offered only when the active translation
 * engine claims it; voice cloning is reported separately so the UI can explain
 * "translation works, cloning does not" and offer the standard-voice fallback.
 */
export async function translateCapabilities({ engines } = {}) {
  const translation = engines?.translation || null;
  const voice = engines?.voice || null;
  const transcription = engines?.transcription || null;
  const separation = engines?.separation || null;
  const lipsync = engines?.lipsync || null;
  const separationStatus = typeof separation?.availability === 'function'
    ? await separation.availability()
    : { available: Boolean(separation?.available) };

  const translationLanguages = normalizeLanguageList(translation?.languages, TRANSLATE_LANGUAGE_CODES);
  const voiceLanguages = normalizeLanguageList(voice?.languages, null);
  const cloneLanguages = voice?.supportsClone ? normalizeLanguageList(voice?.cloneLanguages, null) : [];
  const asrLanguages = normalizeLanguageList(transcription?.languages, null);

  const describe = code => {
    const entry = TRANSLATE_LANGUAGE_CATALOG.find(item => item.code === code);
    return entry ? { ...entry } : { code, name: code, native: code };
  };

  const voiceAvailability = typeof voice?.availability === 'function'
    ? await voice.availability()
    : (voice?.available === false ? { available: false, error: voice?.unavailableReason || null } : { available: Boolean(voice) });
  const voiceReason = voiceAvailability.available === false
    ? (voiceAvailability.error || voiceAvailability.clone_error || voiceAvailability.standard_error || null)
    : null;

  const catalog = code => TRANSLATE_LANGUAGE_CATALOG.find(item => item.code === code) || { code, name: code, native: code };
  const withNames = list => [...new Set(list)].map(catalog).sort((a, b) => a.name.localeCompare(b.name));

  return {
    contract_version: TRANSLATE_CONTRACT_VERSION,
    source_languages: withNames(['auto', ...(translationLanguages.length ? translationLanguages : TRANSLATE_LANGUAGE_CODES)]),
    target_languages: withNames(translationLanguages.length ? translationLanguages : TRANSLATE_LANGUAGE_CODES),
    voice_clone_languages: withNames(cloneLanguages),
    voice_languages: withNames(voiceLanguages || []),
    asr_languages: withNames(asrLanguages || []),
    auto_detect: Boolean(transcription),
    translation_source_languages: withNames(translationLanguages),
    modes: {
      audio: true,
      subtitles: true,
      burn_subtitles: Boolean(engines?.render?.supportsBurnIn ?? true),
      background_preservation: true,
      source_separation: Boolean(separationStatus.available),
      lip_sync: Boolean(lipsync?.available),
    },
    engines: {
      transcription: transcription ? { id: transcription.id, model: transcription.model || null, local: true } : null,
      translation: translation ? { id: translation.id, model: translation.model || null, local: translation.local !== false } : null,
      voice: voice ? {
        id: voice.id,
        models: voice.models || null,
        supports_clone: Boolean(voice.supportsClone),
        available: voiceAvailability.available !== false,
        clone_available: voiceAvailability.clone_available !== false && Boolean(voice.supportsClone),
        unavailable_reason: voiceReason,
        local: voice.local !== false,
      } : null,
      separation: separationStatus.available
        ? { id: separation.id, local: true, model: process.env.VIDMYO_TRANSLATE_DEMUCS_MODEL || 'htdemucs' }
        : null,
      lipsync: lipsync?.available ? { id: lipsync.id, local: true, experimental: true } : null,
    },
    notes: buildCapabilityNotes({ translation, voice: voiceAvailability, voiceReason, cloneLanguages, voiceLanguages }),
  };
}

function buildCapabilityNotes({ translation, voice, voiceReason, cloneLanguages, voiceLanguages }) {
  const notes = [];
  if (!translation) notes.push('No local translation engine is configured; translation jobs cannot start.');
  if (translation?.local === false) notes.push('The active translation engine is not local. Check provider settings before translating private media.');
  if (voice?.available === false) {
    notes.push(voiceReason || 'The voice engine is unavailable; translated audio will use the standard local voice.');
  }
  if (voice?.available !== false && cloneLanguages.length && !voiceLanguages.length) {
    notes.push('Voice cloning is available but the standard voice list is empty.');
  }
  notes.push('Use voice cloning only with permission from the speaker.');
  return notes;
}

function normalizeLanguageList(list, fallback) {
  if (!Array.isArray(list)) return fallback ? [...fallback] : [];
  return list
    .map(code => String(code || '').trim().toLowerCase().split(/[-_]/)[0])
    .filter(code => TRANSLATE_LANGUAGE_CODES.includes(code));
}
