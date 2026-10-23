// Editor V1 engines — the only place the Editor capability touches the machine.
//
// `createEditorEngines(...)` returns ONE object with a stable shape so the runner
// (`editorRunner.js`) never cares what is behind a stage, and tests can inject
// deterministic fakes that write the same artifacts:
//
//   probe(ctx)         -> artifacts/probe.json
//   prepare(ctx)       -> work/cam_raw.mp4 (30 fps CFR, no filters) + work/vo.wav
//   transcribe(ctx)    -> artifacts/transcript.json  { words:[{w,s,e}], segments:[…] }
//   collectAssets(ctx) -> artifacts/assets.json      { stills:[…], clips:[…], face }
//   plan(ctx)          -> artifacts/plan.json        (EDL, docs/editor-v1.md §4b)
//   build(ctx)         -> comp/index.html + comp/sfx-cues.txt + work/shots.json
//   render(ctx)        -> out/render.mp4
//   mix(ctx)           -> out/mixed.mp4
//   finish(ctx)        -> out/final.mp4
//   validate(ctx)      -> artifacts/validate.json
//
// Subprocess policy is inherited from `translateEngines.js`: argument arrays
// (never a shell string), a wall-clock timeout, and SIGTERM→SIGKILL escalation
// driven by the job's AbortSignal. The governor lease belongs to the JOB (the
// runner takes it once, heavy class), so nothing here acquires or releases it.
//
// Two stage results are special:
//   - `mix` may return `{ skipped: true, reason }` (no music bed) and the runner
//     records the stage as skipped while the artifact still exists.
//   - every stage returns `{ metrics }` so the runner can report measured timings.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runGovernedProcess } from './governedProcess.js';
import { resolveFfmpegBinary, resolveFfprobeBinary } from './rendererAdapter.js';
import { listFootage, editorSkillDir } from './editor.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES_ROOT = path.resolve(HERE, '..', '..');

export const EDITOR_ENGINE_ID = 'editor-v1';
export const EDITOR_FPS = 30;
export const EDITOR_WIDTH = 1920;
export const EDITOR_HEIGHT = 1080;

/** The hard cut window from docs/editor-v1.md §4b / §5 (a beat is 0.6–1.5 s). */
export const EDITOR_CUT_MIN_S = 0.6;
export const EDITOR_CUT_MAX_S = 1.5;

/** Devices the plan may name; anything else falls back to `still` in the driver. */
export const EDITOR_DEVICES = [
  'tile_reveal', 'still', 'broll', 'face', 'seq', 'strobe', 'wall3d', 'pop_collage',
];

export const EDITOR_TREATMENTS = ['teal', 'mono', 'warm', 'natural', 'halftone', 'invert'];
export const EDITOR_KEYWORD_KINDS = ['key', 'title', 'shock', 'mega'];

/** Music bed sits this many LU under the voice (skill/scripts/bed-mix.py). */
export const EDITOR_BED_UNDER_LU = 5.5;

/** Analysis limits: yt-dlp caps before a single example can eat the disk. */
export const EXAMPLE_MAX_DURATION_S = 600;
export const EXAMPLE_MAX_BYTES = 500 * 1024 * 1024;

export const DEFAULT_EDITOR_DRIVER_DIR = path.join(PACKAGES_ROOT, 'editor-engine', 'driver');
export const DEFAULT_BUILD_SCRIPT = path.join(DEFAULT_EDITOR_DRIVER_DIR, 'build_from_plan.py');
export const DEFAULT_ANALYZE_SCRIPT = path.join(DEFAULT_EDITOR_DRIVER_DIR, 'analyze_examples.py');
export const DEFAULT_TRANSCRIBE_SCRIPT = fileURLToPath(
  new URL('../pipelines/translate/scripts/transcribe.py', import.meta.url),
);

// ── The measured V1 style profile ───────────────────────────────────────────
// Numbers come from packages/editor-engine/skill/reference/look.md (§1 treatments,
// §2 type, §3 rhythm) and reference/devices.md (§1 tile reveal, §4 wall, §6 strobe).
// They are measurements of the reference edits, not preferences: keep them honest
// and change a number only with a new measurement next to it.

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

export const EDITOR_V1_PROFILE = deepFreeze({
  id: 'v1-original',
  name: 'V1 original',
  // Rhythm (look.md §3): "held shot median 0.56–0.79s"; the planner uses the top
  // of that window because 0.79 s is the measured median of REF-1's held shots.
  cut_median_s: 0.79,
  cut_range_s: [0.56, 0.79],
  cut_floor_s: EDITOR_CUT_MIN_S,
  cut_ceiling_s: EDITOR_CUT_MAX_S,
  // 60–180 images/min ⇒ 1.0–3.0 images/s; 0.79 s/beat is 76 images/min.
  images_per_minute: [60, 180],
  cuts_per_minute: 76,
  // devices.md §6: the strobe is 13 % of REF-2's runtime as <0.17 s shots.
  burst_ratio: 0.13,
  burst_shot_s: 0.17,
  // Type (look.md §2): caption 62 px Inter 600 white, centre of frame.
  caption: { font: 'Inter', weight: 600, size_px: 62, y: 0.5, color: '#FFFFFF' },
  caption_size_px: 62,
  key_size_px: 150,
  title_size_px: 136,
  shock_size_px: 176,
  mega_size_px: 560,
  // Layout (look.md §4): the face share is a decision, not a measurement.
  face_share: 0.3,
  face_share_range: [0.25, 0.35],
  // Colours (assets/tokens.css).
  palette: ['#0E5560', '#F1F0EC', '#060607', '#F2030A', '#D9822B', '#FFE04A'],
  ink: '#121214',
  paper: '#F1F0EC',
  black: '#060607',
  // Treatments (look.md §1) as the measured share of held runtime.
  treatments: ['teal', 'mono', 'warm', 'natural', 'halftone'],
  treatment_mix: { teal: 0.22, mono: 0.18, warm: 0.09, natural: 0.37, halftone: 0.14 },
  devices: EDITOR_DEVICES,
  keyword_kinds: EDITOR_KEYWORD_KINDS,
  fps: EDITOR_FPS,
  width: EDITOR_WIDTH,
  height: EDITOR_HEIGHT,
});

// `shot_median_s` / `caption_size` are the names a measured style-profile.json
// uses (docs/editor-v1.md §5); they map onto the profile keys we actually read.
// `*_hint` keys come from the analyser's soft overrides (§6).
const STYLE_ALIASES = {
  shot_median_s: 'cut_median_s',
  shot_length_median_s: 'cut_median_s',
  median_s: 'cut_median_s',
  caption_size: 'caption.size_px',
  caption_size_px: 'caption.size_px',
  caption_size_hint: 'caption.size_px',
  face_share_hint: 'face_share',
  face_share: 'face_share',
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function setPath(target, dotted, value) {
  const parts = String(dotted).split('.');
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    if (!isPlainObject(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = Array.isArray(value) ? value.slice() : value;
}

/**
 * A custom (measured) style profile wins on the keys it defines; anything the
 * profile does not know is ignored, so a hand-edited or newer template can never
 * break the planner. Nested objects merge one level deep.
 */
export function mergeStyleProfile(base = EDITOR_V1_PROFILE, custom = null) {
  const merged = JSON.parse(JSON.stringify(base));
  if (!isPlainObject(custom)) return deepFreeze(merged);
  // An analysis document carries its numbers under `style`; a saved template
  // carries them at the top level. Accept both without asking the caller which.
  const source = isPlainObject(custom.style) ? { ...custom, ...custom.style } : custom;
  for (const rawKey of Object.keys(source)) {
    const key = STYLE_ALIASES[rawKey] || rawKey;
    const value = source[rawKey];
    if (value === undefined || value === null) continue;
    const [head, tail] = key.split('.');
    const known = Object.prototype.hasOwnProperty.call(merged, head)
      || (isPlainObject(merged.caption) && head === 'caption');
    if (!known) continue;
    if (tail) {
      if (isPlainObject(merged[head])) setPath(merged, key, value);
      continue;
    }
    const current = merged[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      for (const sub of Object.keys(current)) {
        const subValue = value[sub];
        if (subValue === undefined || subValue === null) continue;
        current[sub] = Array.isArray(subValue) ? subValue.slice() : subValue;
      }
      continue;
    }
    if (Array.isArray(value)) merged[key] = value.slice();
    else if (typeof value === typeof current || typeof current === 'undefined') merged[key] = value;
    else if (typeof value === 'number' && !Number.isNaN(value)) merged[key] = value;
  }
  // Keep the profile sane: a measured median below the beat floor is legitimate
  // (the planner clamps each beat to 0.6–1.5 s separately), but a median of 0 or
  // 10 s is a broken measurement, not a style.
  const median = Number(merged.cut_median_s);
  if (!Number.isFinite(median) || median <= 0) merged.cut_median_s = EDITOR_V1_PROFILE.cut_median_s;
  merged.cut_median_s = Math.min(3, Math.max(0.2, merged.cut_median_s));
  const size = Number(merged.caption?.size_px);
  if (!Number.isFinite(size) || size < 12 || size > 240) {
    merged.caption = { ...merged.caption, size_px: EDITOR_V1_PROFILE.caption.size_px };
  }
  return deepFreeze(merged);
}

// ── Small local helpers ─────────────────────────────────────────────────────

const round3 = value => Math.round(Number(value) * 1000) / 1000;
const quantise = (seconds, fps = EDITOR_FPS) => Math.round(Number(seconds) * fps) / fps;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** Deterministic 0..1 noise — the planner must produce the same EDL every run. */
function noise(seed) {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function commandExists(cmd) {
  if (!cmd) return false;
  const value = String(cmd);
  if (value.includes(path.sep)) {
    try { fs.accessSync(value, fs.constants.X_OK); return true; } catch { return false; }
  }
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    try { fs.accessSync(path.join(dir, value), fs.constants.X_OK); return true; } catch { /* next */ }
  }
  return false;
}

function linkOrCopy(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    if (fs.existsSync(target)) return target;
    fs.linkSync(source, target);
    return target;
  } catch {
    fs.copyFileSync(source, target);
    return target;
  }
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * `editorSkillDir()` builds its default from `new URL(import.meta.url).pathname`,
 * which percent-encodes spaces ("My Lexar") — harmless as a display string,
 * fatal as a subprocess argument. Decode once, here, where the path is used.
 */
function resolveSkillDir(value) {
  const raw = String(value || '');
  let decoded = raw;
  if (raw.includes('%')) {
    try { decoded = decodeURIComponent(raw); } catch { decoded = raw; }
  }
  return path.resolve(decoded);
}

/** Copy a child's stdout into a file while still going through the governor. */
async function runCapturedToFile({ cmd, args, file, timeoutMs, signal, env = null }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  try {
    return await runGovernedProcess({
      cmd,
      args,
      timeoutMs,
      signal,
      detached: true,
      stdio: ['ignore', fd, 'pipe'],
      ...(env ? { env } : {}),
    });
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

function tail(text, max = 1200) {
  const value = String(text || '').trim();
  return value.length > max ? `…${value.slice(-max)}` : value;
}

// ── ffprobe ─────────────────────────────────────────────────────────────────

export function parseEditorProbe(json) {
  const value = typeof json === 'string' ? JSON.parse(json) : json || {};
  const rawStreams = Array.isArray(value.streams) ? value.streams : [];
  const video = rawStreams.find(stream => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1)
    || rawStreams.find(stream => stream.codec_type === 'video')
    || null;
  const audio = rawStreams.find(stream => stream.codec_type === 'audio') || null;
  const [num, den] = String(video?.avg_frame_rate || video?.r_frame_rate || '0/1').split('/').map(Number);
  const duration = Number(value.format?.duration) || Number(video?.duration) || 0;
  return {
    duration: round3(duration),
    size: Number(value.format?.size) || 0,
    bitRate: Number(value.format?.bit_rate) || null,
    formatName: value.format?.format_name || null,
    width: video ? Number(video.width) || null : null,
    height: video ? Number(video.height) || null : null,
    fps: den ? round3(num / den) : null,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    video: video ? {
      codec: video.codec_name || null,
      width: Number(video.width) || null,
      height: Number(video.height) || null,
      pixel_format: video.pix_fmt || null,
      fps: den ? round3(num / den) : null,
    } : null,
    audio: audio ? {
      codec: audio.codec_name || null,
      sample_rate: Number(audio.sample_rate) || null,
      channels: Number(audio.channels) || null,
    } : null,
    streams: rawStreams.map(stream => ({
      index: stream.index,
      type: stream.codec_type,
      codec: stream.codec_name || null,
      width: Number(stream.width) || null,
      height: Number(stream.height) || null,
      sample_rate: Number(stream.sample_rate) || null,
      channels: Number(stream.channels) || null,
      duration: Number(stream.duration) || null,
    })),
  };
}

// ── Transcript normalisation ────────────────────────────────────────────────

/**
 * faster-whisper emits `segments[].words[].{word,start,end}`; the editor contract
 * is `{ words:[{w,s,e}], segments:[…] }`. Normalising here (and writing the raw
 * document next to it) is what makes the stage resumable and diffable.
 */
export function normalizeTranscript(raw, { duration = null, model = null } = {}) {
  const limit = Number.isFinite(duration) && duration > 0 ? duration + 0.5 : null;
  const segments = [];
  const words = [];
  let previousEnd = 0;
  for (const segment of Array.isArray(raw?.segments) ? raw.segments : []) {
    const start = round3(Number(segment?.start) || 0);
    const end = round3(Number(segment?.end) || 0);
    const text = String(segment?.text || '').trim();
    const segmentWords = [];
    for (const word of Array.isArray(segment?.words) ? segment.words : []) {
      const value = String(word?.word ?? word?.w ?? '').trim();
      if (!value) continue;
      let s = Number(word?.start ?? word?.s);
      let e = Number(word?.end ?? word?.e);
      if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
      if (e <= s) e = s + 0.08;
      if (s < previousEnd - 0.35) s = previousEnd - 0.2;
      s = Math.max(0, round3(s));
      e = round3(Math.max(s + 0.04, limit ? Math.min(e, limit) : e));
      const entry = { w: value, s, e };
      words.push(entry);
      segmentWords.push(entry);
      previousEnd = e;
    }
    if ((text || segmentWords.length) && end > start) {
      segments.push({
        id: segment?.id ?? segments.length,
        text,
        s: start,
        e: round3(Math.max(start + 0.05, limit ? Math.min(end, limit) : end)),
        words: segmentWords,
      });
    }
  }
  words.sort((a, b) => a.s - b.s);
  return {
    model: raw?.model || model || null,
    language: String(raw?.language || '').toLowerCase().split(/[-_]/)[0] || null,
    language_probability: raw?.language_probability ?? raw?.languageProbability ?? null,
    duration: limit ? round3(Math.min(limit, Number(duration))) : (raw?.duration ?? null),
    elapsed_seconds: raw?.elapsed_seconds ?? null,
    words,
    segments,
  };
}

// ── The deterministic planner ───────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'have', 'from', 'they', 'there', 'their', 'would',
  'about', 'which', 'when', 'what', 'your', 'because', 'just', 'like', 'into', 'than',
  'then', 'them', 'these', 'those', 'been', 'were', 'will', 'very', 'much', 'some', 'more',
]);

/** Weighted treatment rotation (a stable expansion of `treatment_mix`). */
export function treatmentCycle(mix = EDITOR_V1_PROFILE.treatment_mix) {
  const order = EDITOR_TREATMENTS.filter(name => name !== 'invert');
  // A measured mix does not always sum to 1 (the analyser only scores the
  // treatments it actually saw), so normalise before turning it into slots.
  const total = order.reduce((sum, name) => sum + Math.max(0, Number(mix?.[name]) || 0), 0);
  const slots = [];
  for (const name of order) {
    const share = total > 0 ? Math.max(0, Number(mix?.[name]) || 0) / total : 0;
    if (share <= 0) continue;
    const count = Math.max(0, Math.round(share * 20));
    for (let index = 0; index < count; index += 1) slots.push(name);
  }
  if (!slots.length) return ['natural'];
  // Permute deterministically so the measured shares keep their exact counts but
  // never arrive as a block of four teal beats in a row.
  for (let index = slots.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(noise(101 + index * 3.7) * (index + 1));
    [slots[index], slots[swap]] = [slots[swap], slots[index]];
  }
  return slots;
}

/**
 * Beat boundaries for `duration`: every beat lands in [0.6 s, 1.5 s] on the 30 fps
 * frame grid, jittered deterministically around the profile's cut median so the
 * rhythm is not a metronome, and the last beat always ends exactly on `duration`.
 */
export function planBeatBoundaries({ duration, cutMedianS = EDITOR_V1_PROFILE.cut_median_s, seed = 1 }) {
  const total = Number(duration);
  if (!Number.isFinite(total) || total <= 0) return [0];
  const base = clamp(Number(cutMedianS) || EDITOR_V1_PROFILE.cut_median_s, EDITOR_CUT_MIN_S, EDITOR_CUT_MAX_S);
  const minBeats = Math.max(1, Math.ceil(total / EDITOR_CUT_MAX_S));
  const maxBeats = Math.max(minBeats, Math.floor(total / EDITOR_CUT_MIN_S));
  const count = clamp(Math.round(total / base), minBeats, maxBeats);
  if (count <= 1) return [0, quantise(total)];

  const mean = total / count;
  // Jitter amplitude is bounded from both sides so no beat can leave the window.
  const amplitude = Math.max(0, Math.min(0.18, (EDITOR_CUT_MAX_S - 0.04) / mean - 1, mean / (EDITOR_CUT_MIN_S + 0.03) - 1));
  const lens = [];
  for (let index = 0; index < count; index += 1) {
    lens.push(Math.max(1e-6, mean * (1 + amplitude * (2 * noise(seed + index * 7.13) - 1))));
  }
  const sum = lens.reduce((a, b) => a + b, 0);
  const scaled = lens.map(value => (value / sum) * total);

  const bounds = [0];
  let cursor = 0;
  for (let index = 0; index < count - 1; index += 1) {
    // `remaining` beats must still fit after this one, so this boundary is
    // bounded from above by the room they need and from below by their ceiling.
    const remaining = count - index - 1;
    const lowest = Math.max(cursor + EDITOR_CUT_MIN_S, total - remaining * EDITOR_CUT_MAX_S);
    const highest = Math.min(cursor + EDITOR_CUT_MAX_S, total - remaining * EDITOR_CUT_MIN_S);
    const next = quantise(clamp(cursor + scaled[index], lowest, Math.max(lowest, highest)));
    cursor = Math.min(quantise(total), next);
    bounds.push(cursor);
  }
  bounds.push(quantise(total));

  // Repair pass: a beat shorter than the floor is merged with a neighbour, a beat
  // longer than the ceiling is split. This can only fire on pathological custom
  // profiles, but the invariant (0.6–1.5 s) must hold for every plan we emit.
  const repaired = [bounds[0]];
  for (let index = 1; index < bounds.length; index += 1) {
    const previous = repaired[repaired.length - 1];
    let length = bounds[index] - previous;
    if (length < EDITOR_CUT_MIN_S) {
      if (repaired.length >= 2) {
        repaired.pop();
        const before = repaired[repaired.length - 1];
        if (bounds[index] - before <= EDITOR_CUT_MAX_S + 0.2) { repaired.push(bounds[index]); continue; }
        repaired.push(before + (bounds[index] - before) / 2);
      }
      repaired.push(bounds[index]);
      continue;
    }
    while (length > EDITOR_CUT_MAX_S + 1e-6) {
      repaired.push(quantise(previous + length / 2));
      length = bounds[index] - repaired[repaired.length - 1];
      if (length <= 1e-6) { repaired.pop(); break; }
    }
    repaired.push(bounds[index]);
  }
  return repaired.filter((value, index, array) => index === 0 || value > array[index - 1]);
}

function splitPhrases(words) {
  // A caption phrase is what plays inside one beat: words until a pause or a
  // sentence break, so a caption never straddles a cut.
  const phrases = [];
  let current = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    current.push(word);
    const next = words[index + 1];
    const gap = next ? next.s - word.e : 1;
    const endsSentence = /[.!?]$/.test(word.w);
    if (!next || gap > 0.45 || endsSentence || current.length >= 9) {
      phrases.push(current);
      current = [];
    }
  }
  return phrases;
}

function stressedWord(phrase) {
  let best = null;
  for (const word of phrase) {
    const clean = word.w.replace(/[^\p{L}\p{N}'-]/gu, '');
    if (clean.length < 5 || STOPWORDS.has(clean.toLowerCase())) continue;
    if (!best || clean.length > best.length) best = { word, clean };
  }
  return best;
}

/**
 * transcript words + style profile + assets → the EDL shared by the driver, the
 * UI and MCP (docs/editor-v1.md §4b). Deterministic: same inputs, same plan.
 */
export function buildPlanDocument({ probe = {}, transcript = {}, assets = {}, options = {}, style = EDITOR_V1_PROFILE }) {
  const fps = EDITOR_FPS;
  const takeDuration = Number(probe.duration) || 0;
  const words = (Array.isArray(transcript.words) ? transcript.words : [])
    .filter(word => Number.isFinite(word.s) && Number.isFinite(word.e));
  const lastWordEnd = words.length ? words[words.length - 1].e : 0;
  const maxSeconds = (Number(options.max_minutes) || 20) * 60;
  const rawDuration = takeDuration > 0.2 ? takeDuration : lastWordEnd + 0.8;
  const duration = quantise(Math.max(0.6, Math.min(rawDuration, maxSeconds)));

  const stills = Array.isArray(assets.stills) ? assets.stills : [];
  const clips = Array.isArray(assets.clips) ? assets.clips : [];
  const materialAvailable = stills.length + clips.length > 0;

  const pacingFactor = options.pacing === 'long' ? 1.6 : 1;
  const cutMedian = clamp((Number(style.cut_median_s) || EDITOR_V1_PROFILE.cut_median_s) * pacingFactor,
    EDITOR_CUT_MIN_S, EDITOR_CUT_MAX_S);
  const faceShare = clamp(Number.isFinite(Number(options.face_share)) ? Number(options.face_share) : style.face_share ?? 0.3, 0, 0.8);

  const bounds = planBeatBoundaries({ duration, cutMedianS: cutMedian, seed: 11 });
  const words_ = words.filter(word => word.s < duration - 0.02).map(word => ({
    w: word.w, s: round3(word.s), e: round3(Math.min(word.e, duration)),
  }));

  // ── face / material decision ─────────────────────────────────────────────
  const cells = [];
  for (let index = 0; index < bounds.length - 1; index += 1) {
    cells.push({ t0: bounds[index], t1: bounds[index + 1], len: bounds[index + 1] - bounds[index], face: false });
  }
  if (!materialAvailable) {
    for (const cell of cells) cell.face = true;
  } else if (faceShare > 0 && cells.length > 1) {
    const target = Math.max(1, Math.round(cells.length * faceShare));
    const spacing = Math.max(2, Math.floor(cells.length / Math.max(1, target)));
    let faceTime = 0;
    let totalTime = 0;
    let previousFace = false;
    const scheduled = new Set();
    for (let index = spacing - 1; index < cells.length; index += spacing) scheduled.add(index);
    for (let index = 0; index < cells.length; index += 1) {
      const cell = cells[index];
      const wanted = scheduled.has(index) && !previousFace;
      const projected = (faceTime + cell.len) / (totalTime + cell.len);
      if (wanted && projected <= faceShare + 0.03) {
        cell.face = true;
        faceTime += cell.len;
        previousFace = true;
      } else {
        previousFace = false;
      }
      totalTime += cell.len;
    }
    // Greedy scheduling undershoots slightly; convert evenly spaced material
    // beats until the measured share is within tolerance of the requested one.
    let achieved = cells.filter(cell => cell.face).reduce((sum, cell) => sum + cell.len, 0) / duration;
    let guard = 0;
    while (achieved < faceShare - 0.05 && guard < cells.length) {
      guard += 1;
      const step = Math.max(2, Math.round(cells.length / Math.max(1, Math.round(cells.length * (faceShare - achieved)))));
      let converted = false;
      for (let index = 1; index < cells.length; index += step) {
        const cell = cells[index];
        if (cell.face) continue;
        if (cells[index - 1]?.face) continue;
        const nextShare = (cells.filter(item => item.face).reduce((sum, item) => sum + item.len, 0) + cell.len) / duration;
        if (nextShare > faceShare + 0.04) break;
        cell.face = true;
        converted = true;
        break;
      }
      achieved = cells.filter(cell => cell.face).reduce((sum, cell) => sum + cell.len, 0) / duration;
      if (!converted) break;
    }
    // Never two face beats in a row: the first of any adjacent pair yields.
    for (let index = 1; index < cells.length; index += 1) {
      if (cells[index].face && cells[index - 1].face) cells[index].face = false;
    }
  }

  // ── devices, assets, treatments, captions ────────────────────────────────
  const treatments = treatmentCycle(style.treatment_mix);
  const materialCycle = clips.length
    ? ['broll', 'tile_reveal', 'broll', 'still', 'broll', 'seq', 'still', 'broll', 'wall3d', 'tile_reveal']
    : ['tile_reveal', 'still', 'seq', 'still', 'pop_collage', 'tile_reveal', 'wall3d', 'still'];
  const multiSource = new Set(['seq', 'strobe', 'wall3d', 'pop_collage']);
  const keywordKinds = ['key', 'shock', 'title', 'shock'];

  let stillCursor = 0;
  let clipCursor = 0;
  let materialCursor = 0;
  let treatmentCursor = 0;
  let faceCursor = 0;
  let keywordCursor = 0;
  const beats = [];

  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    const id = `b${index + 1}`;
    const caption = words_
      .filter(word => word.s >= cell.t0 - 1e-6 && word.s < cell.t1 - 1e-6)
      .map(word => [word.w, round3(word.s)]);
    const phrase = splitPhrases(words_.filter(word => word.s >= cell.t0 - 1e-6 && word.s < cell.t1 - 1e-6));
    // Beat times stay on the 30 fps frame grid exactly (frame/30), never
    // decimal-rounded — the driver snaps every device to `t * fps`.
    const beat = { id, t0: quantise(cell.t0), t1: quantise(cell.t1), device: 'still' };

    if (cell.face || !materialAvailable) {
      beat.device = 'face';
      if (index % 4 === 1) beat.punch = [round3(cell.t0 + (cell.t1 - cell.t0) * 0.45), 1.08];
      faceCursor += 1;
    } else {
      const device = materialCycle[materialCursor % materialCycle.length];
      materialCursor += 1;
      if (device === 'broll' && clips.length) {
        const clip = clips[clipCursor % clips.length];
        clipCursor += 1;
        beat.device = 'broll';
        beat.asset = clip.asset;
        beat.media_start = round3((index * 0.5) % 3.5);
        beat.rate = 0.06;
      } else if (device === 'broll') {
        const still = stills[stillCursor % stills.length];
        stillCursor += 1;
        beat.device = 'tile_reveal';
        beat.asset = still.asset;
      } else if (stills.length) {
        const still = stills[stillCursor % stills.length];
        stillCursor += 1;
        beat.device = EDITOR_DEVICES.includes(device) ? device : 'still';
        beat.asset = still.asset;
        if (multiSource.has(beat.device)) {
          const need = beat.device === 'strobe' ? 4 : 3;
          if (stills.length >= need) {
            const pool = [];
            for (let offset = 0; offset < need; offset += 1) {
              pool.push(stills[(stillCursor + offset - 1) % stills.length].asset);
            }
            beat.assets = [...new Set(pool)];
          } else {
            beat.device = 'still';
            delete beat.assets;
          }
        }
      } else if (clips.length) {
        const clip = clips[clipCursor % clips.length];
        clipCursor += 1;
        beat.device = 'broll';
        beat.asset = clip.asset;
        beat.media_start = round3((index * 0.5) % 3.5);
        beat.rate = 0.06;
      }
      const treatment = treatments[treatmentCursor % treatments.length];
      treatmentCursor += 1;
      beat.treatment = treatment;
    }

    if (caption.length) beat.caption = caption;

    // The keyword rides the stressed word of the beat — never every beat.
    const stressed = phrase.length ? stressedWord(phrase[0]) || stressedWord(phrase.flat()) : null;
    const wantsKeyword = stressed && caption.length && index % 5 === 1;
    if (wantsKeyword) {
      const kind = beat.device === 'face'
        ? 'mega'
        : keywordKinds[keywordCursor % keywordKinds.length];
      keywordCursor += 1;
      beat.keyword = {
        text: stressed.clean.toUpperCase(),
        kind,
        at: round3(clamp(stressed.word.s + 0.12, cell.t0, cell.t1 - 0.1)),
      };
    }
    beats.push(beat);
  }

  const faceSeconds = beats.filter(beat => beat.device === 'face').reduce((sum, beat) => sum + (beat.t1 - beat.t0), 0);
  const plan = {
    version: 1,
    engine: 'v1',
    mode: options.mode || 'original',
    fps,
    width: style.width || EDITOR_WIDTH,
    height: style.height || EDITOR_HEIGHT,
    duration,
    generated_at: new Date().toISOString(),
    style: {
      name: style.name || 'V1 original',
      cut_median_s: round3(cutMedian),
      palette: Array.isArray(style.palette) ? style.palette.slice(0, 6) : EDITOR_V1_PROFILE.palette,
      treatments: EDITOR_TREATMENTS.filter(name => Number(style.treatment_mix?.[name]) > 0),
      caption_size_px: Number(style.caption?.size_px) || EDITOR_V1_PROFILE.caption.size_px,
      caption_font: style.caption?.font || 'Inter',
      caption_weight: Number(style.caption?.weight) || 600,
    },
    face: { source: 'work/cam_raw.mp4', share: round3(faceShare) },
    beats,
    stats: {
      beats: beats.length,
      face_beats: beats.filter(beat => beat.device === 'face').length,
      face_share: round3(duration > 0 ? faceSeconds / duration : 0),
      images_per_minute: round3(duration > 0 ? (beats.length / duration) * 60 : 0),
      keyword_beats: beats.filter(beat => beat.keyword).length,
      stills: stills.length,
      clips: clips.length,
      words: words_.length,
    },
  };
  return plan;
}

/** Check a plan against the §4b contract; used by `plan` and by tests. */
export function validatePlanDocument(plan) {
  const issues = [];
  if (!plan || typeof plan !== 'object') return ['the plan is not an object'];
  if (plan.version !== 1) issues.push('version must be 1');
  if (plan.fps !== EDITOR_FPS) issues.push(`fps must be ${EDITOR_FPS}`);
  if (!Array.isArray(plan.beats) || !plan.beats.length) issues.push('the plan has no beats');
  let cursor = 0;
  for (const beat of plan.beats || []) {
    if (!beat.device) issues.push(`${beat.id}: no device`);
    if (!EDITOR_DEVICES.includes(beat.device)) issues.push(`${beat.id}: unknown device ${beat.device}`);
    if (!(beat.t1 > beat.t0)) issues.push(`${beat.id}: empty time range`);
    if (Math.abs(beat.t0 - cursor) > 0.001) issues.push(`${beat.id}: gap or overlap at ${beat.t0}`);
    cursor = beat.t1;
    if (beat.device !== 'face' && !beat.asset) issues.push(`${beat.id}: material beat without an asset`);
    if (beat.keyword && !EDITOR_KEYWORD_KINDS.includes(beat.keyword.kind)) issues.push(`${beat.id}: bad keyword kind`);
    for (const caption of beat.caption || []) {
      if (!Array.isArray(caption) || typeof caption[0] !== 'string' || !Number.isFinite(caption[1])) {
        issues.push(`${beat.id}: malformed caption`);
        break;
      }
    }
  }
  if (plan.duration && Math.abs(cursor - plan.duration) > 0.05) {
    issues.push(`beats end at ${cursor}, the plan says ${plan.duration}`);
  }
  return issues;
}

// ── Engine assembly ─────────────────────────────────────────────────────────

export function defaultEditorPython() {
  return process.env.VIDMYO_EDITOR_PYTHON || process.env.VIDMYO_TRANSLATE_PYTHON || 'python3';
}

export function defaultEditorYtdlp() {
  return process.env.VIDMYO_YTDLP_PATH || 'yt-dlp';
}

export function defaultEditorHyperframes() {
  if (process.env.VIDMYO_HYPERFRAMES_BIN) return process.env.VIDMYO_HYPERFRAMES_BIN;
  return path.join(PACKAGES_ROOT, '..', 'node_modules', '.bin', 'hyperframes');
}

function defaultFfmpeg() {
  try { return resolveFfmpegBinary(); } catch { return process.env.VIDMYO_FFMPEG_PATH || 'ffmpeg'; }
}

function defaultFfprobe() {
  try { return resolveFfprobeBinary(); } catch { return 'ffprobe'; }
}

export function createEditorEngines({
  ffmpeg = null,
  ffprobe = null,
  python = null,
  hyperframes = null,
  skillDir = null,
  ytdlp = null,
} = {}) {
  const ffmpegPath = ffmpeg || defaultFfmpeg();
  const ffprobePath = ffprobe || defaultFfprobe();
  const pythonPath = python || defaultEditorPython();
  const hyperframesPath = hyperframes || defaultEditorHyperframes();
  const skillPath = resolveSkillDir(skillDir || process.env.VIDMYO_EDITOR_SKILL_DIR || editorSkillDir());
  const ytdlpPath = ytdlp || defaultEditorYtdlp();

  const buildScript = process.env.VIDMYO_EDITOR_BUILD_SCRIPT || DEFAULT_BUILD_SCRIPT;
  const analyzeScript = process.env.VIDMYO_EDITOR_ANALYZE_SCRIPT || DEFAULT_ANALYZE_SCRIPT;
  const transcribeScript = process.env.VIDMYO_EDITOR_TRANSCRIBE_SCRIPT || DEFAULT_TRANSCRIBE_SCRIPT;
  const bedMixScript = path.join(skillPath, 'scripts', 'bed-mix.py');
  const mixSfxScript = path.join(skillPath, 'scripts', 'mix-sfx.py');

  // ── shared helpers bound to this engine set ──────────────────────────────
  const probeFile = async (file, signal) => {
    const result = await runGovernedProcess({
      cmd: ffprobePath,
      args: ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      timeoutMs: 120000,
      signal,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      captureStdout: { maxBytes: 8 * 1024 * 1024 },
    });
    return parseEditorProbe(result.stdout.toString('utf8'));
  };

  const readArtifact = (ctx, relative) => {
    const file = ctx.project.artifactPath(relative);
    if (!fs.existsSync(file)) throw new Error(`The ${relative} artifact is missing; that stage has not run.`);
    return readJsonFile(file);
  };

  /** The take: the input file, or the longest video with audio in the folder. */
  const resolveTake = async (ctx, signal) => {
    const input = ctx.project.manifest.input;
    if (input.type === 'file') {
      const info = await probeFile(input.path, signal);
      return { path: input.path, name: input.name, info };
    }
    const videos = listFootage(input.path)
      .filter(file => file.kind === 'video')
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!videos.length) throw new Error('No video file in the footage folder; the editor needs one take with the speaker.');
    let best = null;
    for (const file of videos.slice(0, 12)) {
      signal?.throwIfAborted();
      let info;
      try { info = await probeFile(file.path, signal); } catch { continue; }
      if (!info.hasVideo) continue;
      if (!best) best = { path: file.path, name: file.name, info };
      if (info.hasAudio && (!best.info.hasAudio || info.duration > best.info.duration)) {
        best = { path: file.path, name: file.name, info };
      }
    }
    if (!best) throw new Error('No readable video file in the footage folder.');
    return best;
  };

  const engines = {
    id: EDITOR_ENGINE_ID,
    version: '1.0.0',
    profile: EDITOR_V1_PROFILE,
    paths: {
      ffmpeg: ffmpegPath,
      ffprobe: ffprobePath,
      python: pythonPath,
      hyperframes: hyperframesPath,
      skillDir: skillPath,
      driverDir: path.dirname(buildScript),
      build: buildScript,
      analyze: analyzeScript,
      transcribe: transcribeScript,
    },

    /** Synchronous so `editorCapabilities()` can report without awaiting. */
    capabilities() {
      return {
        id: EDITOR_ENGINE_ID,
        engine: EDITOR_ENGINE_ID,
        version: '1.0.0',
        modes: ['original', 'custom'],
        devices: [...EDITOR_DEVICES],
        treatments: [...EDITOR_TREATMENTS],
        keyword_kinds: [...EDITOR_KEYWORD_KINDS],
        profile: EDITOR_V1_PROFILE,
        tools: {
          ffmpeg: { path: ffmpegPath, available: commandExists(ffmpegPath) },
          ffprobe: { path: ffprobePath, available: commandExists(ffprobePath) },
          python: { path: pythonPath, available: commandExists(pythonPath) },
          hyperframes: { path: hyperframesPath, available: fs.existsSync(hyperframesPath) },
          ytdlp: { path: ytdlpPath, available: commandExists(ytdlpPath) },
          driver: { path: buildScript, available: fs.existsSync(buildScript) },
          analyzer: { path: analyzeScript, available: fs.existsSync(analyzeScript) },
          skill: { path: skillPath, available: fs.existsSync(skillPath) },
        },
        // The cut-out (`cutout_world`) needs the RVM matte, which needs both the
        // kit's matte script and a Python that can import torch/onnx.
        cutOut: fs.existsSync(path.join(skillPath, 'scripts', 'matte.py')) && commandExists(pythonPath),
      };
    },

    // ── probe ──────────────────────────────────────────────────────────────
    async probe(ctx) {
      const started = Date.now();
      const take = await resolveTake(ctx, ctx.signal);
      if (!take.info.hasVideo) throw new Error('That file has no video stream, so there is nothing to edit.');
      if (!take.info.hasAudio) ctx.warn('The take has no audio track; transcription will be empty and the edit is built on the picture alone.');
      const document = {
        artifact_version: 1,
        generated_at: new Date().toISOString(),
        input: ctx.project.manifest.input,
        take: { path: take.path, name: take.name, duration: take.info.duration, bytes: take.info.size },
        duration: take.info.duration,
        fps: take.info.fps,
        width: take.info.width,
        height: take.info.height,
        resolution: { width: take.info.width, height: take.info.height },
        hasVideo: take.info.hasVideo,
        hasAudio: take.info.hasAudio,
        video: take.info.video,
        audio: take.info.audio,
        format: take.info.formatName,
        bit_rate: take.info.bitRate,
        streams: take.info.streams,
      };
      ctx.project.writeJson('artifacts/probe.json', document);
      ctx.log(`take: ${take.name} ${take.info.width}x${take.info.height} ${(take.info.duration || 0).toFixed(2)}s ${take.info.fps || '?'}fps`);
      return { artifact: 'artifacts/probe.json', probe: document, metrics: { durationMs: Date.now() - started, takeSeconds: document.duration } };
    },

    // ── prepare ────────────────────────────────────────────────────────────
    async prepare(ctx) {
      const started = Date.now();
      const probe = readArtifact(ctx, 'artifacts/probe.json');
      const take = probe.take?.path;
      if (!take || !fs.existsSync(take)) throw new Error(`The probed take is gone: ${take || 'unknown'}`);
      const camRelative = 'work/cam_raw.mp4';
      const voRelative = 'work/vo.wav';
      const cam = ctx.project.artifactPath(camRelative);
      const vo = ctx.project.artifactPath(voRelative);
      fs.mkdirSync(path.dirname(cam), { recursive: true });

      // The camera plate is the ungraded truth of the edit: constant 30 fps, an
      // open GOP of 30 (a keyframe every second), and NO filters — look.md §1.
      await runGovernedProcess({
        cmd: ffmpegPath,
        args: [
          '-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', take,
          '-map', '0:v:0', '-an', '-sn', '-dn',
          '-r', String(EDITOR_FPS), '-fps_mode', 'cfr', '-g', String(EDITOR_FPS),
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart', cam,
        ],
        timeoutMs: 90 * 60 * 1000,
        signal: ctx.signal,
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      if (probe.hasAudio) {
        await runGovernedProcess({
          cmd: ffmpegPath,
          args: [
            '-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', take,
            '-map', '0:a:0', '-vn', '-sn', '-dn',
            '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', vo,
          ],
          timeoutMs: 60 * 60 * 1000,
          signal: ctx.signal,
          detached: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
      } else {
        // A silent plate still gets a voice track so every later stage has a
        // 48 kHz mono timeline to work on.
        await runGovernedProcess({
          cmd: ffmpegPath,
          args: [
            '-hide_banner', '-nostdin', '-v', 'error', '-y',
            '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
            '-t', String(Math.max(0.5, Number(probe.duration) || 1)), '-c:a', 'pcm_s16le', vo,
          ],
          timeoutMs: 10 * 60 * 1000,
          signal: ctx.signal,
          detached: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
      }
      for (const [relative, file] of [[camRelative, cam], [voRelative, vo]]) {
        if (!fs.existsSync(file) || fs.statSync(file).size < 1024) throw new Error(`Preparing the camera failed: ${relative} was not written.`);
      }
      return {
        artifact: camRelative,
        video: camRelative,
        audio: voRelative,
        metrics: { durationMs: Date.now() - started },
      };
    },

    // ── transcribe ─────────────────────────────────────────────────────────
    async transcribe(ctx) {
      const started = Date.now();
      const probe = readArtifact(ctx, 'artifacts/probe.json');
      const vo = ctx.project.artifactPath('work/vo.wav');
      if (!fs.existsSync(vo)) throw new Error('work/vo.wav is missing; run `prepare` first.');
      if (!fs.existsSync(transcribeScript)) throw new Error(`The transcription script is missing: ${transcribeScript}`);
      const model = process.env.VIDMYO_EDITOR_ASR_MODEL || 'small';
      const rawRelative = 'artifacts/transcript.raw.json';
      const rawFile = ctx.project.artifactPath(rawRelative);
      fs.mkdirSync(path.dirname(rawFile), { recursive: true });
      ctx.log(`transcribing with faster-whisper (${model})`);
      await runGovernedProcess({
        cmd: pythonPath,
        args: [
          transcribeScript, vo, rawFile,
          '--model', model,
          '--compute-type', process.env.VIDMYO_EDITOR_ASR_COMPUTE_TYPE || 'int8',
          '--language', ctx.options.language || 'auto',
          '--word-timestamps',
          '--device', process.env.VIDMYO_EDITOR_ASR_DEVICE || 'cpu',
        ],
        timeoutMs: 180 * 60 * 1000,
        signal: ctx.signal,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      });
      const raw = readJsonFile(rawFile);
      const transcript = normalizeTranscript(raw, { duration: Number(probe.duration) || null, model });
      if (!transcript.words.length) {
        ctx.warn('No speech was recognised in the take; the edit is planned from the picture alone.');
      }
      ctx.project.writeJson('artifacts/transcript.json', transcript);
      ctx.log(`${transcript.words.length} words, ${transcript.segments.length} segments${transcript.language ? ` (${transcript.language})` : ''}`);
      return {
        artifact: 'artifacts/transcript.json',
        transcript,
        metrics: { durationMs: Date.now() - started, words: transcript.words.length, language: transcript.language },
      };
    },

    // ── collectAssets ──────────────────────────────────────────────────────
    async collectAssets(ctx) {
      const started = Date.now();
      const project = ctx.project;
      const input = project.manifest.input;
      const probe = readArtifact(ctx, 'artifacts/probe.json');
      const takePath = probe.take?.path ? path.resolve(probe.take.path) : null;
      const root = input.type === 'folder' ? input.path : path.dirname(input.path);
      const projectDir = path.resolve(project.dir);

      const found = listFootage(root).filter(entry => {
        const resolved = path.resolve(entry.path);
        if (takePath && resolved === takePath) return false;
        if (resolved.startsWith(`${projectDir}${path.sep}`)) return false;
        return true;
      });
      const MAX_ASSETS = 400;
      const skipped = found.slice(MAX_ASSETS).map(entry => entry.name);
      if (skipped.length) ctx.warn(`${skipped.length} file(s) past the ${MAX_ASSETS}-asset limit were ignored.`);

      const stills = [];
      const clips = [];
      for (const entry of found.slice(0, MAX_ASSETS)) {
        const isImage = entry.kind === 'image';
        const bucket = isImage ? stills : clips;
        const index = bucket.length + 1;
        const ext = path.extname(entry.name).toLowerCase();
        const relative = `assets/media/${isImage ? 'still' : 'clip'}_${String(index).padStart(3, '0')}${ext}`;
        const target = project.artifactPath(relative);
        linkOrCopy(entry.path, target);
        bucket.push({
          asset: relative,
          source: entry.path,
          name: entry.name,
          kind: isImage ? 'image' : 'video',
          bytes: fs.statSync(target).size,
        });
      }

      // URLs the agent supplied are recorded for the operator, never downloaded
      // here: the editor only uses what the user actually placed in the folder.
      const examples = (Array.isArray(ctx.options.examples) ? ctx.options.examples : [])
        .filter(item => /^https?:\/\//i.test(String(item)))
        .map(item => ({ url: String(item), kind: 'url' }));

      const document = {
        artifact_version: 1,
        generated_at: new Date().toISOString(),
        face: 'work/cam_raw.mp4',
        take: probe.take || null,
        stills,
        clips,
        examples,
        counts: { stills: stills.length, clips: clips.length, examples: examples.length },
        ignored: skipped,
      };
      project.writeJson('artifacts/assets.json', document);
      if (!stills.length && !clips.length) {
        ctx.warn('The footage folder has no pictures or extra clips, so every beat will be a face beat.');
      }
      ctx.log(`assets: ${stills.length} still(s), ${clips.length} clip(s)${examples.length ? `, ${examples.length} example URL(s)` : ''}`);
      return {
        artifact: 'artifacts/assets.json',
        assets: document,
        metrics: { durationMs: Date.now() - started, stills: stills.length, clips: clips.length },
      };
    },

    // ── plan ───────────────────────────────────────────────────────────────
    async plan(ctx) {
      const started = Date.now();
      const probe = readArtifact(ctx, 'artifacts/probe.json');
      const transcript = readArtifact(ctx, 'artifacts/transcript.json');
      const assets = readArtifact(ctx, 'artifacts/assets.json');
      const style = mergeStyleProfile(EDITOR_V1_PROFILE, ctx.template?.profile || ctx.template || null);
      const plan = buildPlanDocument({
        probe,
        transcript,
        assets,
        options: ctx.options,
        style,
      });
      const issues = validatePlanDocument(plan);
      if (issues.length) throw new Error(`The plan is not renderable: ${issues.slice(0, 4).join('; ')}`);
      ctx.project.writeJson('artifacts/plan.json', plan);
      ctx.log(`plan: ${plan.beats.length} beats, ${(plan.stats.face_share * 100).toFixed(0)}% face, ${plan.stats.images_per_minute.toFixed(0)} images/min`);
      return {
        artifact: 'artifacts/plan.json',
        plan,
        metrics: {
          durationMs: Date.now() - started,
          beats: plan.beats.length,
          face_share: plan.stats.face_share,
          images_per_minute: plan.stats.images_per_minute,
        },
      };
    },

    // ── build ──────────────────────────────────────────────────────────────
    async build(ctx) {
      const started = Date.now();
      const script = BUILD_SCRIPT_PATH();
      if (!fs.existsSync(script)) {
        throw new Error(`The editor driver is missing: ${script}`);
      }
      ctx.log('building the composition from the plan');
      // The driver prints warnings to stderr and a machine-readable result on the
      // last stdout line, so stdout is captured to a file: a rejected pipe would
      // lose both the diagnostic and the summary.
      const logFile = ctx.project.artifactPath('work/build.log');
      let failure = null;
      try {
        await runCapturedToFile({
          cmd: pythonPath,
          args: [script, ctx.project.dir],
          file: logFile,
          timeoutMs: 30 * 60 * 1000,
          signal: ctx.signal,
          env: { ...process.env, PYTHONUNBUFFERED: '1', EV1_SKILL: skillPath },
        });
      } catch (error) {
        if (error.code === 'ECANCELLED') throw error;
        failure = error;
      }
      let stdoutText = '';
      try { stdoutText = fs.readFileSync(logFile, 'utf8'); } catch { stdoutText = ''; }
      if (failure) {
        const detail = tail(`${stdoutText}\n${failure.stderr || ''}`, 2000);
        throw new Error(`The composition build failed: ${failure.message}${detail ? `\n${detail}` : ''}`);
      }
      let summary = null;
      for (const line of stdoutText.trim().split('\n').reverse()) {
        const candidate = line.trim();
        if (!candidate.startsWith('{')) continue;
        try { summary = JSON.parse(candidate); break; } catch { /* not the summary line */ }
      }
      if (summary && summary.ok === false) {
        throw new Error(`The composition build reported a failure: ${summary.error || 'see work/build.log'}`);
      }
      for (const relative of ['comp/index.html', 'comp/sfx-cues.txt']) {
        if (!ctx.project.hasArtifact(relative)) throw new Error(`The build did not write ${relative}.`);
      }
      const cues = fs.readFileSync(ctx.project.artifactPath('comp/sfx-cues.txt'), 'utf8')
        .split('\n').filter(line => line.trim() && !line.startsWith('#')).length;
      return {
        artifact: 'comp/index.html',
        cues,
        summary,
        metrics: {
          durationMs: Date.now() - started,
          cues,
          beats: summary?.beats ?? null,
          shots: summary?.shots ?? null,
        },
      };
    },

    // ── render ─────────────────────────────────────────────────────────────
    async render(ctx) {
      const started = Date.now();
      const compDir = ctx.project.artifactPath('comp');
      if (!fs.existsSync(path.join(compDir, 'index.html'))) throw new Error('comp/index.html is missing; run `build` first.');
      if (!fs.existsSync(hyperframesPath)) throw new Error(`The HyperFrames renderer is missing: ${hyperframesPath}`);

      // Lint first: fail on lint ERRORS only, never on warnings. `lint --json`
      // exits non-zero when it finds errors, so stdout is captured to a file
      // rather than a pipe (a rejected pipe loses the findings).
      const lintFile = ctx.project.artifactPath('work/lint.json');
      let lintFailure = null;
      try {
        await runCapturedToFile({
          cmd: hyperframesPath,
          args: ['lint', compDir, '--json'],
          file: lintFile,
          timeoutMs: 10 * 60 * 1000,
          signal: ctx.signal,
        });
      } catch (error) {
        if (error.code === 'ECANCELLED') throw error;
        lintFailure = error;
      }
      let lintReport = null;
      try { lintReport = readJsonFile(lintFile); } catch { lintReport = null; }
      const lintErrors = lintReport
        ? (Number(lintReport.errorCount) || (lintReport.findings || []).filter(item => item.severity === 'error').length)
        : null;
      if (lintReport && lintErrors > 0) {
        const detail = (lintReport.findings || [])
          .filter(item => item.severity === 'error')
          .slice(0, 5)
          .map(item => `${item.code}: ${item.message}`)
          .join(' | ');
        throw new Error(`Composition lint found ${lintErrors} error(s): ${detail}`);
      }
      if (!lintReport && lintFailure) {
        throw new Error(`Composition lint could not run: ${lintFailure.message} ${tail(lintFailure.stderr, 600)}`.trim());
      }
      if (lintReport?.warningCount) ctx.log(`lint: ${lintReport.warningCount} warning(s), 0 error(s)`);

      const outRelative = 'out/render.mp4';
      const outFile = ctx.project.artifactPath(outRelative);
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      const logFile = ctx.project.artifactPath('work/render.log');
      const quality = ['draft', 'standard', 'high'].includes(ctx.options.quality) ? ctx.options.quality : 'standard';
      ctx.log(`rendering (${quality})`);
      let failure = null;
      const renderStarted = Date.now();
      try {
        await runCapturedToFile({
          cmd: hyperframesPath,
          args: ['render', compDir, '-q', quality, '-f', String(EDITOR_FPS), '-o', outFile],
          file: logFile,
          timeoutMs: 180 * 60 * 1000,
          signal: ctx.signal,
        });
      } catch (error) {
        if (error.code === 'ECANCELLED') throw error;
        failure = error;
      }
      if (failure) {
        let logText = '';
        try { logText = fs.readFileSync(logFile, 'utf8'); } catch { /* no log */ }
        throw new Error(`The render failed: ${failure.message}\n${tail(logText, 2000)}`.trim());
      }
      if (!fs.existsSync(outFile) || fs.statSync(outFile).size < 1024) throw new Error('The render produced no usable out/render.mp4.');
      return {
        artifact: outRelative,
        metrics: {
          durationMs: Date.now() - started,
          renderMs: Date.now() - renderStarted,
          bytes: fs.statSync(outFile).size,
          quality,
          lint_warnings: lintReport?.warningCount ?? 0,
        },
      };
    },

    // ── mix ────────────────────────────────────────────────────────────────
    async mix(ctx) {
      const started = Date.now();
      const renderRelative = 'out/render.mp4';
      const render = ctx.project.artifactPath(renderRelative);
      if (!fs.existsSync(render)) throw new Error('out/render.mp4 is missing; run `render` first.');
      const mixedRelative = 'out/mixed.mp4';
      const mixed = ctx.project.artifactPath(mixedRelative);
      fs.mkdirSync(path.dirname(mixed), { recursive: true });

      const music = ctx.options.music_path || null;
      if (music && !fs.existsSync(music)) throw new Error(`The music bed is gone: ${music}`);
      if (music && !fs.existsSync(bedMixScript)) throw new Error(`The kit's bed mixer is missing: ${bedMixScript}`);

      const plan = readArtifact(ctx, 'artifacts/plan.json');
      const transcript = readArtifact(ctx, 'artifacts/transcript.json');
      const duration = Math.max(0.5, Number(plan.duration) || 0);
      const voice = ctx.project.artifactPath('work/vo.wav');
      if (!fs.existsSync(voice)) throw new Error('work/vo.wav is missing; run `prepare` first.');
      const voiceEnd = transcript.words?.length
        ? Math.min(duration, transcript.words[transcript.words.length - 1].e)
        : null;
      const premix = ctx.project.artifactPath('work/premix.wav');

      // 1. The audio bed. With a music file the kit measures voice and song and
      //    sits the bed ~5.5 LU under the voice (skill/scripts/bed-mix.py). Without
      //    one the voice IS the bed — HyperFrames renders picture only, so a bare
      //    copy of the render would ship a silent master and `validate` would
      //    (correctly) reject it.
      const makeVoiceOnlyPremix = async () => {
        await runGovernedProcess({
          cmd: ffmpegPath,
          args: [
            '-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', voice,
            '-t', duration.toFixed(3), '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', premix,
          ],
          timeoutMs: 10 * 60 * 1000,
          signal: ctx.signal,
          detached: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        if (!fs.existsSync(premix)) throw new Error('The voice premix produced no work/premix.wav.');
      };

      if (music) {
        ctx.log(`laying the music bed ${EDITOR_BED_UNDER_LU} LU under the voice`);
        try {
          await runGovernedProcess({
            cmd: pythonPath,
            args: [
              bedMixScript,
              '--voice', voice,
              '--song', music,
              '--dur', duration.toFixed(3),
              '--under', String(EDITOR_BED_UNDER_LU),
              '--out', premix,
              ...(voiceEnd ? ['--voice-end', voiceEnd.toFixed(3)] : []),
            ],
            timeoutMs: 30 * 60 * 1000,
            signal: ctx.signal,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, PYTHONUNBUFFERED: '1' },
            captureStdout: { maxBytes: 512 * 1024 },
          });
          if (!fs.existsSync(premix)) throw new Error('The bed mix produced no work/premix.wav.');
        } catch (bedError) {
          // A failed bed must never ship a silent master: fall back to the voice
          // alone, say so, and let the user retry once the bed is fixed.
          ctx.warn(`the music bed could not be mixed (${bedError.message}); the edit keeps the voice only.`);
          await makeVoiceOnlyPremix();
        }
      } else {
        await makeVoiceOnlyPremix();
      }

      // 2. Put the audio on the rendered picture (video stream copied).
      const premixVideo = ctx.project.artifactPath('work/premix.mp4');
      await runGovernedProcess({
        cmd: ffmpegPath,
        args: [
          '-hide_banner', '-nostdin', '-v', 'error', '-y',
          '-i', render, '-i', premix,
          '-map', '0:v:0', '-map', '1:a:0',
          '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
          '-shortest', '-movflags', '+faststart', premixVideo,
        ],
        timeoutMs: 30 * 60 * 1000,
        signal: ctx.signal,
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      // 3. The device-written cue sheet on top (skill/scripts/mix-sfx.py): a click
      //    on every picture change is part of the V1 look, bed or no bed.
      const cuesRelative = 'comp/sfx-cues.txt';
      let cues = 0;
      if (ctx.project.hasArtifact(cuesRelative) && fs.existsSync(mixSfxScript)) {
        cues = fs.readFileSync(ctx.project.artifactPath(cuesRelative), 'utf8')
          .split('\n').filter(line => line.trim() && !line.startsWith('#')).length;
        await runGovernedProcess({
          cmd: pythonPath,
          args: [mixSfxScript, premixVideo, ctx.project.artifactPath(cuesRelative), mixed],
          timeoutMs: 30 * 60 * 1000,
          signal: ctx.signal,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONUNBUFFERED: '1' },
          captureStdout: { maxBytes: 512 * 1024 },
        });
      } else {
        if (!ctx.project.hasArtifact(cuesRelative)) ctx.warn('No cue sheet (comp/sfx-cues.txt); the mix has no device clicks.');
        fs.copyFileSync(premixVideo, mixed);
      }
      if (!fs.existsSync(mixed) || fs.statSync(mixed).size < 1024) throw new Error('The mix produced no out/mixed.mp4.');
      return {
        artifact: mixedRelative,
        cues,
        // With no bed the stage is honestly recorded as skipped (nothing was
        // laid under the voice) even though the artifact carries the voice.
        skipped: !music,
        reason: music ? null : 'no music bed',
        metrics: {
          durationMs: Date.now() - started,
          bed: Boolean(music),
          under_lu: music ? EDITOR_BED_UNDER_LU : null,
          cues,
        },
      };
    },

    // ── finish ─────────────────────────────────────────────────────────────
    async finish(ctx) {
      const started = Date.now();
      const source = ctx.project.artifactPath('out/mixed.mp4');
      if (!fs.existsSync(source)) throw new Error('out/mixed.mp4 is missing; run `mix` first.');
      const outRelative = 'out/final.mp4';
      const out = ctx.project.artifactPath(outRelative);
      await runGovernedProcess({
        cmd: ffmpegPath,
        args: [
          '-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', source,
          '-map', '0:v:0', '-map', '0:a:0?',
          '-c:v', 'copy',
          '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11',
          '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
          '-movflags', '+faststart', out,
        ],
        timeoutMs: 60 * 60 * 1000,
        signal: ctx.signal,
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      if (!fs.existsSync(out) || fs.statSync(out).size < 1024) throw new Error('Finishing produced no usable out/final.mp4.');
      return {
        artifact: outRelative,
        metrics: {
          durationMs: Date.now() - started,
          bytes: fs.statSync(out).size,
          loudness_target: { integrated_lufs: -14, true_peak_db: -1.5 },
        },
      };
    },

    // ── validate ───────────────────────────────────────────────────────────
    async validate(ctx) {
      const started = Date.now();
      const probe = readArtifact(ctx, 'artifacts/probe.json');
      const plan = readArtifact(ctx, 'artifacts/plan.json');
      const final = ctx.project.artifactPath('out/final.mp4');
      if (!fs.existsSync(final)) throw new Error('out/final.mp4 is missing; run `finish` first.');
      const info = await probeFile(final, ctx.signal);
      const expected = Math.max(0.5, Math.min(Number(plan.duration) || 0, Number(probe.duration) || Number(plan.duration) || 0) || Number(plan.duration) || 0);
      const ratio = expected > 0 ? info.duration / expected : 0;
      const checks = {
        has_video: Boolean(info.hasVideo),
        has_audio: Boolean(info.hasAudio),
        duration_ok: ratio >= 0.95,
        resolution_ok: info.width === EDITOR_WIDTH && info.height === EDITOR_HEIGHT,
      };
      const issues = [];
      if (!checks.has_video) issues.push('the output has no video stream');
      if (!checks.has_audio) issues.push('the output has no audio stream');
      if (!checks.duration_ok) issues.push(`the output is ${info.duration.toFixed(2)}s, ${(ratio * 100).toFixed(1)}% of the ${expected.toFixed(2)}s take`);
      if (!checks.resolution_ok) issues.push(`the output is ${info.width}x${info.height}, not ${EDITOR_WIDTH}x${EDITOR_HEIGHT}`);
      const report = {
        artifact_version: 1,
        generated_at: new Date().toISOString(),
        ok: issues.length === 0,
        checked: 'out/final.mp4',
        take: { duration: Number(probe.duration) || null },
        expected_duration: round3(expected),
        output: {
          duration: info.duration,
          duration_ratio: round3(ratio),
          width: info.width,
          height: info.height,
          fps: info.fps,
          has_video: info.hasVideo,
          has_audio: info.hasAudio,
          video_codec: info.video?.codec || null,
          audio_codec: info.audio?.codec || null,
          sample_rate: info.audio?.sample_rate || null,
          channels: info.audio?.channels || null,
          bytes: fs.existsSync(final) ? fs.statSync(final).size : null,
        },
        beats: Array.isArray(plan.beats) ? plan.beats.length : null,
        checks,
        issues,
        warnings: ctx.project.manifest.warnings.slice(-20),
      };
      ctx.project.writeJson('artifacts/validate.json', report);
      for (const issue of issues) ctx.warn(issue);
      if (!report.ok) throw new Error(`The finished video failed validation: ${issues.join('; ')}`);
      ctx.log(`validated: ${info.duration.toFixed(2)}s, ${info.width}x${info.height}, video+audio`);
      return {
        artifact: 'artifacts/validate.json',
        report,
        metrics: { durationMs: Date.now() - started, duration: info.duration, ratio: round3(ratio) },
      };
    },

    // ── example analysis (no network) ──────────────────────────────────────
    async analyzeExamples({ paths = [], workDir, signal = null, log = null } = {}) {
      if (!workDir) throw new Error('analyzeExamples needs a workDir.');
      const dir = path.resolve(workDir);
      const examplesDir = path.join(dir, 'examples');
      fs.mkdirSync(examplesDir, { recursive: true });
      const files = [];
      let index = 0;
      for (const source of paths || []) {
        const resolved = path.resolve(String(source));
        if (!fs.existsSync(resolved)) throw new Error(`Example video not found: ${resolved}`);
        index += 1;
        const ext = path.extname(resolved).toLowerCase() || '.mp4';
        const target = path.join(examplesDir, `example_${String(index).padStart(2, '0')}${ext}`);
        if (path.resolve(target) !== resolved) linkOrCopy(resolved, target);
        files.push(target);
      }
      if (!files.length) throw new Error('No example video to analyze.');
      if (!fs.existsSync(analyzeScript)) throw new Error(`The example analyser is missing: ${analyzeScript}`);
      log?.(`analysing ${files.length} example(s)`);

      // Contract of driver/analyze_examples.py:
      //   python3 analyze_examples.py --out <dir> <video1> [<video2> ...]
      // → <dir>/style-profile.json + <dir>/contact-sheet.jpg, last stdout line is
      // a JSON summary. stdout goes to a file so a failure keeps its diagnostic
      // AND the success summary survives a rejected pipe.
      const logFile = path.join(dir, 'analysis.log');
      let failure = null;
      try {
        await runCapturedToFile({
          cmd: pythonPath,
          args: [analyzeScript, '--out', dir, ...files],
          file: logFile,
          timeoutMs: 60 * 60 * 1000,
          signal,
          env: { ...process.env, PYTHONUNBUFFERED: '1' },
        });
      } catch (error) {
        if (error.code === 'ECANCELLED') throw error;
        failure = error;
      }
      let stdoutText = '';
      try { stdoutText = fs.readFileSync(logFile, 'utf8'); } catch { stdoutText = ''; }
      if (failure) {
        const detail = tail(`${stdoutText}\n${failure.stderr || ''}`, 2000);
        throw new Error(`Analysing the examples failed: ${failure.message}${detail ? `\n${detail}` : ''}`);
      }
      const profileFile = path.join(dir, 'style-profile.json');
      if (!fs.existsSync(profileFile)) throw new Error('The analysis produced no style-profile.json.');
      const contactSheet = path.join(dir, 'contact-sheet.jpg');
      let summary = null;
      for (const line of stdoutText.trim().split('\n').reverse()) {
        const candidate = line.trim();
        if (!candidate.startsWith('{')) continue;
        try { summary = JSON.parse(candidate); break; } catch { /* not the summary */ }
      }
      return {
        profile: readJsonFile(profileFile),
        profilePath: profileFile,
        contactSheet: fs.existsSync(contactSheet) ? contactSheet : null,
        examples: files,
        summary,
      };
    },

    // ── example download (network, one named URL at a time) ─────────────────
    async downloadExample({ url, dir, signal = null, log = null } = {}) {
      const value = String(url || '').trim();
      if (!/^https?:\/\//i.test(value)) {
        throw new Error('Only http(s) example URLs are downloaded; local example files are copied by the analysis runner.');
      }
      if (!dir) throw new Error('downloadExample needs a directory.');
      const outDir = path.resolve(dir);
      fs.mkdirSync(outDir, { recursive: true });
      const before = new Set(fs.readdirSync(outDir));
      log?.(`downloading ${value}`);
      let failure = null;
      try {
        await runGovernedProcess({
          cmd: ytdlpPath,
          args: [
            '--no-playlist', '--no-progress', '--no-warnings', '--restrict-filenames', '--no-exec',
            '--match-filter', `duration<=${EXAMPLE_MAX_DURATION_S}`,
            '--max-filesize', String(EXAMPLE_MAX_BYTES),
            '--socket-timeout', '30', '--retries', '3',
            '-f', 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b',
            '--merge-output-format', 'mp4',
            '-o', path.join(outDir, 'example_%(id)s.%(ext)s'),
            '--', value,
          ],
          timeoutMs: 30 * 60 * 1000,
          signal,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
      } catch (error) {
        failure = error;
      }
      const produced = fs.readdirSync(outDir)
        .filter(name => !before.has(name) && !name.startsWith('.'))
        .map(name => path.join(outDir, name));
      if (failure) {
        const stderr = String(failure.stderr || '');
        if (/does not pass filter|duration/i.test(stderr) && !produced.length) {
          throw new Error(`That example is longer than ${EXAMPLE_MAX_DURATION_S}s (or has no readable duration); pick a shorter one.`);
        }
        throw new Error(`The example could not be downloaded: ${failure.message} ${tail(stderr, 600)}`.trim());
      }
      if (!produced.length) throw new Error('The example download produced no file.');
      const file = produced.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
      const bytes = fs.statSync(file).size;
      if (bytes > EXAMPLE_MAX_BYTES) {
        try { fs.unlinkSync(file); } catch { /* best effort */ }
        throw new Error(`The example is larger than ${Math.round(EXAMPLE_MAX_BYTES / (1024 * 1024))} MB.`);
      }
      let duration = null;
      try { duration = (await probeFile(file, signal)).duration; } catch { duration = null; }
      if (duration && duration > EXAMPLE_MAX_DURATION_S + 1) {
        try { fs.unlinkSync(file); } catch { /* best effort */ }
        throw new Error(`That example is ${Math.round(duration)}s long; the limit is ${EXAMPLE_MAX_DURATION_S}s.`);
      }
      return { file, bytes, duration, url: value };
    },

    // Exposed for the runner/tests: probe one arbitrary file with this engine set.
    probeFile,
  };

  // `build` refers to the resolvable script path through a function so an env
  // override applied after construction is still honoured.
  function BUILD_SCRIPT_PATH() {
    return process.env.VIDMYO_EDITOR_BUILD_SCRIPT || buildScript;
  }

  return engines;
}
