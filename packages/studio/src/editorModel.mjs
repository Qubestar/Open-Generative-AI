// Editor — presentation logic for the desktop tab.
//
// Everything here is pure: no DOM, no React, no Electron, no network, and no
// import from @vidmyo/core (the studio package is built and deployed on its
// own). The constants below mirror `packages/core/src/editor.js`; when the core
// contract changes, change both, deliberately.
//
// `EditorStudio.jsx` renders these rules and `packages/core/test/editorModel
// .test.js` asserts them, which keeps the component a thin shell.

// ── Contract mirrors ────────────────────────────────────────────────────────

export const EDITOR_ENGINES = [
  {
    id: 'v1',
    name: 'V1',
    description: 'Documentary edit: real pictures, measured devices, a click on every change.',
    modes: ['original', 'custom'],
  },
];

export const EDITOR_MODES = ['original', 'custom'];

export const EDITOR_MODE_LABELS = { original: 'Original', custom: 'Custom' };

export const EDITOR_STAGES = [
  'probe', 'prepare', 'transcribe', 'assets', 'plan', 'build', 'render', 'mix', 'finish', 'validate',
];

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

export const EDITOR_ANALYSIS_STAGES = ['download', 'analyze'];

export const ANALYSIS_STAGE_LABELS = {
  download: 'Fetching the examples',
  analyze: 'Measuring cuts, palette and motion',
};

export const EDITOR_QUALITIES = ['draft', 'standard', 'high'];
export const EDITOR_PACINGS = ['reference', 'long'];

export const QUALITY_CHOICES = [
  { id: 'draft', label: 'Draft', detail: 'Lower bitrate. For checking the cut before the real render.' },
  { id: 'standard', label: 'Standard', detail: 'The default: full quality at a practical file size.' },
  { id: 'high', label: 'High', detail: 'Highest bitrate, for publishing or for grading later.' },
];

export const PACING_CHOICES = [
  { id: 'reference', label: 'Reference', detail: 'Follows the V1 look: a new picture on almost every line.' },
  { id: 'long', label: 'Long', detail: 'Stretches the holds so a slower take keeps its breathing room.' },
];

/** The finished master. Its path is the only output the UI promises. */
export const EDITOR_FINAL_FILENAME = 'final.mp4';

/** Face share is a fraction of the runtime; 0.8 is the core contract maximum. */
export const MAX_FACE_SHARE = 0.8;

/** The slider shows less than the contract allows: past 60 % the face dominates. */
export const FACE_SHARE_SLIDER_MAX = 0.6;

export const DEFAULT_OUTPUT_HINT = 'defaults to a folder next to your footage';

export const LOCAL_ONLY_NOTICE = 'Nothing is uploaded anywhere: the edit is rendered on this machine.';

export const NO_BRIDGE_NOTICE = 'The Editor tab needs the desktop app. Vidmyo renders the edit locally, '
  + 'so this tab stays disabled in the browser build.';

// ── Paths ───────────────────────────────────────────────────────────────────

/** Absolute means POSIX-rooted or drive-rooted: the backend rejects anything else. */
export function isAbsolutePath(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return false;
  if (raw.startsWith('/')) return true;
  if (raw.startsWith('\\\\')) return true; // UNC share
  return /^[a-zA-Z]:[\\/]/.test(raw);
}

function joinPath(dir, relative) {
  const base = String(dir ?? '').trim().replace(/[\\/]+$/, '');
  const rest = String(relative ?? '').trim().replace(/^[\\/]+/, '');
  if (!base) return rest;
  if (!rest) return base;
  return `${base}/${rest}`;
}

// ── Options ─────────────────────────────────────────────────────────────────

/** Engine rows for the select, straight from capabilities (never an if-chain). */
export function editorEngineOptions(capabilities) {
  const list = Array.isArray(capabilities?.engines) && capabilities.engines.length
    ? capabilities.engines
    : EDITOR_ENGINES;
  return list
    .filter(engine => engine && engine.id)
    .map(engine => ({
      value: engine.id,
      label: engine.name || engine.id,
      description: engine.description || '',
      modes: Array.isArray(engine.modes) && engine.modes.length ? [...engine.modes] : [...EDITOR_MODES],
    }));
}

function modeLabels(capabilities) {
  const labels = new Map();
  for (const entry of Array.isArray(capabilities?.modes) ? capabilities.modes : []) {
    if (typeof entry === 'string') labels.set(entry, EDITOR_MODE_LABELS[entry] || entry);
    else if (entry && entry.id) labels.set(entry.id, entry.label || EDITOR_MODE_LABELS[entry.id] || entry.id);
  }
  return labels;
}

/** The modes the selected engine actually offers, labelled from capabilities. */
export function editorModeOptions(capabilities, engineId) {
  const engines = editorEngineOptions(capabilities);
  const engine = engines.find(option => option.value === engineId) || engines[0] || null;
  const allowed = engine ? engine.modes : [...EDITOR_MODES];
  const labels = modeLabels(capabilities);
  return allowed
    .filter(id => EDITOR_MODES.includes(id))
    .map(id => ({ value: id, label: labels.get(id) || EDITOR_MODE_LABELS[id] || id }));
}

export function defaultEditorForm(capabilities) {
  const engines = editorEngineOptions(capabilities);
  const engine = engines[0]?.value || 'v1';
  const modes = editorModeOptions(capabilities, engine);
  return {
    engine,
    mode: modes[0]?.value || 'original',
    input_dir: '',
    output_dir: '',
    template_id: null,
    music_path: null,
    quality: 'standard',
    pacing: 'reference',
    face_share: 0.3,
    example_urls: [],
    example_videos: [],
    template_name: '',
  };
}

/** Example URLs + example files, de-duplicated, in the order the user added them. */
export function exampleList(form) {
  const urls = (Array.isArray(form?.example_urls) ? form.example_urls : [])
    .map(value => String(value ?? '').trim())
    .filter(Boolean);
  const videos = (Array.isArray(form?.example_videos) ? form.example_videos : [])
    .map(value => String(value ?? '').trim())
    .filter(Boolean);
  return [...new Set([...urls, ...videos])];
}

/** An http(s) example reference, or null when the text is not usable. */
export function normalizeExampleUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.toString();
  } catch { return null; }
}

/**
 * The pre-flight check. Blocking problems only; every message is a sentence the
 * user can act on. Errors are keyed by form field so the field can show them.
 */
export function validateEditorForm(form = {}) {
  const errors = {};
  const input = String(form?.input_dir ?? '').trim();
  const output = String(form?.output_dir ?? '').trim();
  const music = String(form?.music_path ?? '').trim();
  const mode = String(form?.mode || 'original');

  if (!input) errors.input_dir = 'Choose the folder that holds your footage.';
  else if (!isAbsolutePath(input)) errors.input_dir = 'Use the full path to the folder, starting with /.';

  if (!output) errors.output_dir = 'Choose where the finished edit should go.';
  else if (!isAbsolutePath(output)) errors.output_dir = 'Use the full path to the folder, starting with /.';

  if (input && output && input === output) {
    errors.output_dir = 'The edit needs its own folder — pick a different one from the footage.';
  }

  if (music && !isAbsolutePath(music)) {
    errors.music_path = 'Pick the music file with Browse… so its full path is used.';
  }

  const faceShare = form?.face_share;
  if (faceShare !== null && faceShare !== undefined && faceShare !== '') {
    const value = Number(faceShare);
    if (!Number.isFinite(value) || value < 0 || value > MAX_FACE_SHARE) {
      errors.face_share = `Keep the face share between 0% and ${Math.round(MAX_FACE_SHARE * 100)}%.`;
    }
  }

  if (form?.engine && !editorEngineOptions(null).some(engine => engine.value === form.engine)) {
    errors.engine = 'That engine is not available in this build.';
  }

  if (!EDITOR_QUALITIES.includes(String(form?.quality || 'standard'))) {
    errors.quality = 'Quality must be draft, standard or high.';
  }
  if (!EDITOR_PACINGS.includes(String(form?.pacing || 'reference'))) {
    errors.pacing = 'Pacing must be reference or long.';
  }

  if (mode === 'custom' && !String(form?.template_id ?? '').trim()) {
    const examples = exampleList(form);
    if (!examples.length) errors.examples = 'Add at least one example video, or apply a saved template.';
    for (const entry of examples) {
      if (/^https?:\/\//i.test(entry) && !normalizeExampleUrl(entry)) {
        errors.examples = 'That example link does not look like a valid http(s) URL.';
        break;
      }
    }
  }

  return { ok: Object.keys(errors).length === 0, errors };
}

/** The exact payload `window.editor.start()` takes. */
export function editorPayloadFromForm(form) {
  const music = String(form?.music_path ?? '').trim();
  return {
    input_dir: String(form?.input_dir ?? '').trim(),
    output_dir: String(form?.output_dir ?? '').trim(),
    mode: String(form?.mode || 'original'),
    engine: String(form?.engine || 'v1'),
    template_id: form?.template_id ? String(form.template_id) : null,
    music_path: music || null,
    quality: String(form?.quality || 'standard'),
    pacing: String(form?.pacing || 'reference'),
    face_share: Number.isFinite(Number(form?.face_share)) ? Number(form.face_share) : 0.3,
  };
}

// ── Job → view ──────────────────────────────────────────────────────────────

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function outputEntryPath(job, entry) {
  const candidate = String(entry?.path || entry?.file || '').trim();
  if (candidate && isAbsolutePath(candidate)) return candidate;
  const relative = candidate || String(entry?.artifact || '').trim();
  if (!relative) return null;
  const dir = job?.project_dir || job?.output_dir || job?.projectDir || null;
  return dir ? joinPath(dir, relative) : relative;
}

/** The finished master, as an absolute path when the job knows its project. */
export function finalOutputPath(job) {
  if (!job) return null;
  const outputs = Array.isArray(job.outputs) ? job.outputs : [];
  const final = outputs.find(entry => /final/i.test(String(entry?.kind || ''))
    || new RegExp(`${EDITOR_FINAL_FILENAME.replace('.', '\\.')}$`, 'i').test(String(entry?.artifact || entry?.path || '')));
  if (final) {
    const resolved = outputEntryPath(job, final);
    if (resolved) return resolved;
  }
  const direct = String(job.output_path || '').trim();
  if (direct) return direct;
  if (String(job.state || '') !== 'done') return null;
  const dir = job.project_dir || job.output_dir || job.projectDir || null;
  return dir ? joinPath(dir, `out/${EDITOR_FINAL_FILENAME}`) : EDITOR_FINAL_FILENAME;
}

function finalOutputEntry(job) {
  const outputs = Array.isArray(job?.outputs) ? job.outputs : [];
  return outputs.find(entry => /final/i.test(String(entry?.kind || ''))
    || new RegExp(`${EDITOR_FINAL_FILENAME.replace('.', '\\.')}$`, 'i').test(String(entry?.artifact || entry?.path || '')))
    || null;
}

function durationMsFor(job) {
  const entry = finalOutputEntry(job);
  const candidates = [
    entry?.duration_ms, entry?.durationMs,
    job?.duration_ms, job?.durationMs,
    job?.metrics?.duration_ms, job?.metrics?.durationMs, job?.metrics?.durationMs,
    job?.metrics?.duration,
  ];
  for (const value of candidates) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

/** Milliseconds → a short human duration. Empty string when unknown. */
export function formatDurationMs(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 1000) return `${Math.round(value)} ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * One shape for every place the tab talks about a job. `state` stays the raw
 * backend state; the flags are what the panel branches on.
 */
export function describeEditorJob(job) {
  if (!job) {
    return {
      state: 'idle',
      stage: null,
      stageLabel: null,
      progress: 0,
      summary: 'No edit selected.',
      isRunning: false,
      isDone: false,
      isFailed: false,
      isCancelled: false,
      outputPath: null,
      durationMs: null,
      warnings: [],
      error: null,
    };
  }

  const state = String(job.state || 'queued');
  const isDone = state === 'done';
  const isFailed = state === 'error';
  const isCancelled = state === 'cancelled';
  const isRunning = state === 'queued' || state === 'running';

  const stages = Array.isArray(job.stages) ? job.stages : [];
  const active = stages.find(entry => entry.status === 'running')
    || stages.find(entry => entry.status === 'failed')
    || stages.find(entry => entry.status === 'pending')
    || null;
  const stage = job.stage || active?.id || null;
  const stageLabel = job.stage_label || (stage ? EDITOR_PROGRESS_LABELS[stage] || stage : null);
  const progress = isDone ? 100 : clampPercent(job.progress);
  const error = job.error ? String(job.error) : null;

  let summary;
  if (isDone) summary = `Finished. ${EDITOR_FINAL_FILENAME} is in the output folder.`;
  else if (isFailed) summary = error ? `Stopped: ${error.slice(0, 200)}` : 'The edit stopped before it finished.';
  else if (isCancelled) summary = 'Cancelled. The finished stages are kept, so a retry resumes where it stopped.';
  else if (state === 'queued') summary = 'Queued. The edit starts when the machine is free.';
  else summary = stageLabel ? `${stageLabel}…` : 'Working…';

  return {
    state,
    stage,
    stageLabel,
    progress,
    summary,
    isRunning,
    isDone,
    isFailed,
    isCancelled,
    outputPath: finalOutputPath(job),
    durationMs: durationMsFor(job),
    warnings: (Array.isArray(job.warnings) ? job.warnings : []).map(String).filter(Boolean),
    error,
  };
}

/** The per-stage progress list: status, error and measured metrics per stage. */
export function stageChecklist(job) {
  const stages = Array.isArray(job?.stages) ? job.stages : [];
  if (!stages.length) {
    // A finished job that reports no stage list has nothing honest to show.
    if (job && ['done', 'error', 'cancelled'].includes(String(job.state || ''))) return [];
    return EDITOR_STAGES.map(id => ({
      id,
      label: EDITOR_PROGRESS_LABELS[id],
      status: 'pending',
      error: null,
      metrics: null,
    }));
  }
  return stages.map(entry => ({
    id: entry.id,
    label: entry.label || EDITOR_PROGRESS_LABELS[entry.id] || entry.id,
    status: entry.status || 'pending',
    error: entry.error || null,
    metrics: entry.metrics || null,
  }));
}

/**
 * The style analysis job that feeds the template. `getAnalysis` (and the bridge
 * that mirrors it) hands back `{ job, profile }`; a bare job is tolerated.
 */
export function describeAnalysisJob(job, profile = null) {
  const record = job?.job || job || null;
  const measured = profile || job?.profile || job?.analysis?.profile || null;
  const state = String(record?.state || 'idle');
  const isDone = state === 'done';
  const isFailed = state === 'error';
  const isCancelled = state === 'cancelled';
  const rawProgress = record?.progress ?? record?.checkpoints?.progress ?? 0;
  const progress = isDone ? 100 : clampPercent(rawProgress);
  const stage = record?.checkpoints?.stage || record?.stage || null;
  const stageLabel = stage ? ANALYSIS_STAGE_LABELS[stage] || stage : null;
  let summary;
  if (measured) summary = 'Style measured. Review the numbers, then save it as a template.';
  else if (isDone) summary = 'The analysis finished without a style profile.';
  else if (isFailed) summary = record?.error ? `Analysis stopped: ${String(record.error).slice(0, 200)}` : 'The analysis stopped.';
  else if (isCancelled) summary = 'Analysis cancelled.';
  else if (state === 'queued') summary = 'Analysis queued.';
  else summary = stageLabel ? `${stageLabel}…` : 'Analysing the examples…';
  return {
    state,
    stage,
    stageLabel,
    progress,
    summary,
    isRunning: state === 'queued' || state === 'running',
    isDone,
    isFailed,
    isCancelled,
    profile: measured,
  };
}

function hexColor(value) {
  const raw = typeof value === 'object' && value !== null ? value.hex || value.color || value.value : value;
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const bare = text.replace(/^#/, '');
  if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$|^[0-9a-f]{8}$/i.test(bare)) return null;
  return `#${bare.toLowerCase()}`;
}

function paletteOf(profile) {
  const style = profile?.style && typeof profile.style === 'object' ? profile.style : profile;
  const list = Array.isArray(style?.palette) ? style.palette : [];
  return list.map(hexColor).filter(Boolean).slice(0, 6);
}

/** The measured fields may sit on the profile or under its `style` block. */
function styleOf(profile) {
  return profile?.style && typeof profile.style === 'object' ? profile.style : profile;
}

function medianSecondsOf(profile) {
  const style = styleOf(profile);
  const candidates = [
    style?.cut_median_s, style?.shot_median_s, style?.cutMedianS,
    style?.shots?.median_s, style?.shots?.median, style?.shot_length?.median,
    style?.shot_median,
  ];
  for (const value of candidates) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  const ms = Number(style?.cut_median_ms ?? style?.cutMedianMs);
  if (Number.isFinite(ms) && ms > 0) return ms / 1000;
  return null;
}

function cutsPerMinuteOf(profile) {
  const style = styleOf(profile);
  const number = Number(style?.cuts_per_minute ?? style?.cutsPerMinute);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/**
 * The measured profile, already formatted. Every label is derived from a
 * measurement the analysis actually wrote — no placeholder numbers.
 */
export function exampleProfileSummary(profile) {
  if (!profile || typeof profile !== 'object') {
    return { cutMedianLabel: null, cutsPerMinuteLabel: null, palette: [], lines: [] };
  }
  const median = medianSecondsOf(profile);
  const cuts = cutsPerMinuteOf(profile);
  const palette = paletteOf(profile);
  const style = styleOf(profile);
  const lines = [];
  if (median) lines.push(`Median cut ${median.toFixed(2)} s`);
  if (cuts) lines.push(`${Math.round(cuts)} cuts per minute`);
  const burst = Number(style?.burst_ratio ?? style?.burstRatio);
  if (Number.isFinite(burst) && burst > 0) lines.push(`${Math.round(burst * 100)}% of shots are shorter than 0.2 s`);
  const aspect = String(style?.aspect_ratio || style?.aspectRatio || '').trim();
  if (aspect) lines.push(`Aspect ${aspect}`);
  return {
    cutMedianLabel: median ? `${median.toFixed(2)} s` : null,
    cutsPerMinuteLabel: cuts ? `${Math.round(cuts)}/min` : null,
    palette,
    lines,
  };
}

// ── Templates ───────────────────────────────────────────────────────────────

/** Saved templates as table rows: what the name means, in one line. */
export function templateRows(templates) {
  const list = Array.isArray(templates) ? templates : [];
  return list
    .filter(template => template && (template.id || template.name))
    .map(template => {
      const profile = template.profile || template;
      const median = medianSecondsOf(profile);
      const cuts = cutsPerMinuteOf(profile);
      const palette = paletteOf(profile);
      const examples = Array.isArray(template.examples) ? template.examples.filter(Boolean) : [];
      const parts = [];
      if (median) parts.push(`median cut ${median.toFixed(2)} s`);
      if (cuts) parts.push(`${Math.round(cuts)} cuts/min`);
      if (examples.length) parts.push(`${examples.length} example${examples.length === 1 ? '' : 's'}`);
      if (!parts.length) parts.push('not measured yet');
      return {
        id: String(template.id || template.name),
        name: String(template.name || template.id),
        engine: template.engine || null,
        created_at: template.created_at || null,
        cutMedianLabel: median ? `${median.toFixed(2)} s` : null,
        cutsPerMinuteLabel: cuts ? `${Math.round(cuts)}/min` : null,
        palette,
        exampleCount: examples.length,
        detail: parts.join(' · '),
      };
    });
}
