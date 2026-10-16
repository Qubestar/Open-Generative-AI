// Translate Video engines — the only place that touches the local machine.
//
// Every engine is a small object with a stable shape so the runner never cares
// which implementation is behind it, and tests can inject deterministic fakes:
//
//   transcription.transcribe(ctx) → { language, segments: [{ id, start, end, text, words }] }
//   translation.translate(ctx)     → [{ id, text }]
//   translation.shorten(ctx)       → { text }
//   voice.synthesize(ctx)          → { file, engine }
//   voice.availability()           → { available, error? }
//   separation.separate(ctx)       → { background, vocals }
//   mixer.buildSpeechTrack(ctx)    → relative artifact path
//   mixer.mix(ctx)                 → relative artifact path
//   render.render(ctx)             → relative artifact path
//
// Local by default: faster-whisper for speech recognition, a local Ollama (or
// any OpenAI-compatible loopback server) for translation, macOS `say` or a local
// Voicebox/Chatterbox profile for speech, FFmpeg for extraction/mix/render.
// Nothing here sends user media to a remote AI service.
//
// Subprocess policy: every child goes through `runGovernedProcess` with an
// argument array (never a shell string), a wall-clock timeout, and SIGTERM→SIGKILL
// process-group escalation driven by the job's AbortSignal. The governor lease
// is held by the JOB for the whole pipeline (heavy class, concurrency 1) and is
// deliberately not re-acquired per child, so releasing a child can never drop
// the job's exclusive slot.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { runGovernedProcess, runGovernedFfmpeg } from './governedProcess.js';
import { resolveFfmpegBinary, resolveFfprobeBinary, escapeFfmpegFilterPath } from './rendererAdapter.js';
import { tryProbeFfmpegCapabilities } from './ffmpegCapabilities.js';
import {
  MAX_DOWNLOAD_BYTES, sanitizeArtifactName, assertResolvablePublicHost, translateLanguage,
  assertSafeLocalFile, SOURCE_VIDEO_EXTENSIONS,
} from './translate.js';

export const DEFAULT_TRANSLATE_SCIPTS_DIR = fileURLToPath(new URL('../pipelines/translate/scripts/', import.meta.url));
const DEFAULT_TRANSCRIBE_SCRIPT = path.join(DEFAULT_TRANSLATE_SCIPTS_DIR, 'transcribe.py');

// Mirrors the language set the local Voicebox/Chatterbox service accepts.
export const VOICEBOX_LANGUAGES = [
  'ar', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'it', 'ja',
  'ko', 'ms', 'nl', 'no', 'pl', 'pt', 'ru', 'sv', 'sw', 'tr', 'zh',
];

export const DEFAULT_OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';
export const DEFAULT_VOICEBOX_ENDPOINT = 'http://127.0.0.1:17493';

export function defaultPython() {
  return process.env.VIDMYO_TRANSLATE_PYTHON || process.env.VIDMYO_REPURPOSE_PYTHON || 'python3';
}

export function defaultFfmpeg() {
  try { return resolveFfmpegBinary(); } catch { return process.env.VIDMYO_FFMPEG_PATH || 'ffmpeg'; }
}

export function defaultFfprobe() {
  try { return resolveFfprobeBinary(); } catch { return 'ffprobe'; }
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function sleep(ms) {
  return new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
}

// ── Media probing / extraction ──────────────────────────────────────────────

export function parseProbeOutput(stdout) {
  const value = JSON.parse(stdout);
  const streams = Array.isArray(value.streams) ? value.streams : [];
  const video = streams.find(stream => stream.codec_type === 'video') || null;
  const audio = streams.find(stream => stream.codec_type === 'audio') || null;
  const [num, den] = String(video?.avg_frame_rate || '0/1').split('/').map(Number);
  return {
    duration: Number(value.format?.duration) || Number(video?.duration) || 0,
    size: Number(value.format?.size) || 0,
    bitRate: Number(value.format?.bit_rate) || null,
    formatName: value.format?.format_name || null,
    width: video ? Number(video.width) || null : null,
    height: video ? Number(video.height) || null : null,
    fps: den ? Number((num / den).toFixed(3)) : null,
    videoCodec: video?.codec_name || null,
    audioCodec: audio?.codec_name || null,
    sampleRate: audio ? Number(audio.sample_rate) || null : null,
    channels: audio ? Number(audio.channels) || null : null,
    hasAudio: Boolean(audio),
    hasVideo: Boolean(video),
  };
}

export async function probeMedia(file, { ffprobePath = defaultFfprobe(), signal = null, timeoutMs = 60000 } = {}) {
  const result = await runGovernedProcess({
    cmd: ffprobePath,
    args: ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    timeoutMs,
    signal,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    captureStdout: { maxBytes: 4 * 1024 * 1024 },
  });
  return parseProbeOutput(result.stdout.toString('utf8'));
}

// ── Import ──────────────────────────────────────────────────────────────────

const YTDLP_ARGS = ['--no-playlist', '--no-progress', '--no-warnings', '--restrict-filenames', '--no-exec'];

export function createSourceImporter({ ytdlpPath = process.env.VIDMYO_YTDLP_PATH || 'yt-dlp' } = {}) {
  return {
    id: 'local-import',
    async import(ctx) {
      const { project, input, signal, log } = ctx;
      if (input.type === 'url') {
        await assertResolvablePublicHost(input.uri, ctx.lookupImpl ? { lookupImpl: ctx.lookupImpl } : {});
        const outDir = path.join(project.dir, 'artifacts');
        fs.mkdirSync(outDir, { recursive: true });
        const template = path.join(outDir, 'source.%(ext)s');
        log(`downloading ${input.uri}`);
        await runGovernedProcess({
          cmd: ytdlpPath,
          args: [
            ...YTDLP_ARGS,
            '--max-filesize', String(MAX_DOWNLOAD_BYTES),
            '--socket-timeout', '30',
            '--retries', '3',
            '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b',
            '--merge-output-format', 'mp4',
            '-o', template,
            '--', input.uri,
          ],
          timeoutMs: 30 * 60 * 1000,
          signal,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        const produced = fs.readdirSync(outDir).filter(name => name.startsWith('source.'));
        if (!produced.length) throw new Error('The video URL could not be downloaded.');
        // Prefer a real container when the downloader left a partial file behind.
        const chosen = produced.find(name => SOURCE_VIDEO_EXTENSIONS.includes(path.extname(name).toLowerCase())) || produced[0];
        for (const name of produced) if (name !== chosen) { try { fs.unlinkSync(path.join(outDir, name)); } catch { /* leave it */ } }
        const file = path.join(outDir, chosen);
        const bytes = fs.statSync(file).size;
        if (bytes === 0) throw new Error('The downloaded video is empty.');
        if (bytes > MAX_DOWNLOAD_BYTES) throw new Error('The downloaded video exceeded the 4 GiB translate limit.');
        return {
          artifact: `artifacts/${chosen}`,
          source: { type: 'url', uri: input.uri, label: safeLabel(input.uri) },
          bytes, sha256: sha256File(file),
        };
      }
      const resolved = assertSafeLocalFile(input.uri);
      const extension = path.extname(resolved).toLowerCase();
      const name = `source${extension}`;
      const target = project.artifactPath(`artifacts/${name}`);
      if (path.resolve(resolved) !== path.resolve(target)) fs.copyFileSync(resolved, target);
      return {
        artifact: `artifacts/${name}`,
        source: { type: input.type, uri: resolved, label: sanitizeArtifactName(path.basename(resolved)) },
        bytes: fs.statSync(target).size, sha256: sha256File(target),
      };
    },
  };
}

function safeLabel(uri) {
  try {
    const url = new URL(uri);
    return sanitizeArtifactName(`${url.hostname}${url.pathname}`) || url.hostname;
  } catch {
    return 'video';
  }
}

// ── Audio extraction ────────────────────────────────────────────────────────

export function createAudioExtractor({ ffmpegPath = defaultFfmpeg() } = {}) {
  return {
    id: 'ffmpeg-audio',
    async extract(ctx) {
      const { project, signal } = ctx;
      const media = ctx.media.artifact;
      const asr = 'artifacts/source.asr.wav';
      const background = 'artifacts/source.audio.wav';
      await runGovernedFfmpeg({
        cmd: ffmpegPath,
        args: ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', project.artifactPath(media),
          '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
          project.artifactPath(asr)],
        timeoutMs: 30 * 60 * 1000, signal,
      });
      await runGovernedFfmpeg({
        cmd: ffmpegPath,
        args: ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', project.artifactPath(media),
          '-vn', '-sn', '-dn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le',
          project.artifactPath(background)],
        timeoutMs: 30 * 60 * 1000, signal,
      });
      return { asr, background };
    },
  };
}

// ── Transcription (faster-whisper, local) ───────────────────────────────────

export function transcriptionModelFor(quality, { fastModel = null, qualityModel = null } = {}) {
  if (quality === 'fast') return fastModel || process.env.VIDMYO_TRANSLATE_ASR_MODEL_FAST || 'base';
  return qualityModel || process.env.VIDMYO_TRANSLATE_ASR_MODEL || process.env.VIDMYO_TRANSLATE_ASR_MODEL_QUALITY || 'small';
}

export function createFasterWhisperTranscriber({
  python = defaultPython(),
  script = DEFAULT_TRANSCRIBE_SCRIPT,
  models = {},
  languages = null,
} = {}) {
  return {
    id: 'faster-whisper',
    local: true,
    languages,
    model: null,
    async transcribe(ctx) {
      const { project, options, signal, log } = ctx;
      const model = transcriptionModelFor(options.quality, models);
      this.model = model;
      const out = 'artifacts/transcript.json';
      log(`transcribing with faster-whisper (${model})`);
      await runGovernedProcess({
        cmd: python,
        args: [
          script,
          project.artifactPath(ctx.audio.asr),
          project.artifactPath(out),
          '--model', model,
          '--compute-type', process.env.VIDMYO_TRANSLATE_ASR_COMPUTE_TYPE || 'int8',
          '--language', options.source_language || 'auto',
          '--word-timestamps',
          '--device', 'cpu',
        ],
        timeoutMs: 120 * 60 * 1000,
        signal,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      });
      const transcript = project.readJson(out);
      if (!Array.isArray(transcript.segments)) throw new Error('Transcription produced no segments.');
      return transcript;
    },
  };
}

// ── Translation (local LLM) ─────────────────────────────────────────────────

export const TRANSLATION_BATCH_SIZE = 25;

export function buildTranslationPrompt({ sourceLanguage, targetLanguage, segments, context = [], mode = 'translate', maxSeconds = null }) {
  const target = translateLanguage(targetLanguage).name;
  const source = sourceLanguage && sourceLanguage !== 'auto' ? translateLanguage(sourceLanguage).name : 'the source language';
  const contextBlock = context.length
    ? `Earlier lines, for continuity only (do not re-translate them):\n${context.map(line => `- ${line}`).join('\n')}\n\n`
    : '';
  const instruction = mode === 'shorten'
    ? `Rewrite each line in ${target} so it can be spoken in AT MOST ${maxSeconds} seconds at a natural pace, keeping the same meaning, tone and named entities. Prefer shorter synonyms and drop filler words. Never drop information that changes the meaning.`
    : `Translate each line from ${source} into ${target} for a DUBBED video. Rules:\n- Natural spoken ${target}, not literal word-for-word translation.\n- Preserve meaning, tone, emotion, register, terminology, jokes and slang.\n- Read the surrounding lines as context so pronouns and callbacks make sense.\n- Keep each translation about as long as the original line, so it fits the original speaking window.\n- Keep proper nouns, brand names and numbers accurate.\n- Never add commentary, notes or explanations.`;
  return `${contextBlock}${instruction}

Return ONLY minified JSON of exactly this shape, one entry per input line, ids unchanged:
{"lines":[{"id":"<id>","text":"<translated text>"}]}

Input lines:
${JSON.stringify({ lines: segments.map(segment => ({ id: segment.id, text: segment.text, seconds: Number((segment.end - segment.start).toFixed(3)) })) })}`;
}

export function parseTranslationResponse(content, expectedIds) {
  const text = String(content || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('The translation engine returned no JSON.');
  let parsed;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { throw new Error('The translation engine returned invalid JSON.'); }
  const lines = Array.isArray(parsed?.lines) ? parsed.lines : (Array.isArray(parsed?.translations) ? parsed.translations : null);
  if (!lines) throw new Error('The translation engine returned an unexpected shape.');
  const byId = new Map();
  for (const line of lines) {
    const id = String(line?.id ?? '');
    const value = typeof line?.text === 'string' ? line.text : (typeof line?.translation === 'string' ? line.translation : null);
    if (id && value !== null) byId.set(id, value.trim());
  }
  return expectedIds.map(id => ({ id, text: byId.get(id) ?? null }));
}

export function createOllamaTranslator({
  endpoint = process.env.VIDMYO_TRANSLATE_OLLAMA_URL || DEFAULT_OLLAMA_ENDPOINT,
  model = process.env.VIDMYO_TRANSLATE_MODEL || 'llama3.1:8b',
  fetchImpl = fetch,
  languages = null,
} = {}) {
  const chat = async ({ prompt, signal, timeoutMs = 15 * 60 * 1000 }) => {
    const base = String(endpoint).replace(/\/+$/, '');
    const response = await fetchImpl(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        options: { temperature: 0.2, num_ctx: 8192 },
        messages: [
          { role: 'system', content: 'You are a professional dubbing translator. You always answer with minified JSON only.' },
          { role: 'user', content: prompt },
        ],
      }),
    });
    if (!response.ok) throw new Error(`The local translation model responded with HTTP ${response.status}.`);
    const payload = await response.json();
    const content = payload?.message?.content ?? payload?.response ?? null;
    if (typeof content !== 'string') throw new Error('The local translation model returned an unexpected response.');
    return content;
  };

  return {
    id: `ollama:${model}`,
    local: true,
    endpoint, model, languages,
    async translate(ctx) {
      const { segments, options, signal, log } = ctx;
      const context = [];
      const translations = [];
      for (let index = 0; index < segments.length; index += TRANSLATION_BATCH_SIZE) {
        signal?.throwIfAborted();
        const batch = segments.slice(index, index + TRANSLATION_BATCH_SIZE);
        const prompt = buildTranslationPrompt({
          sourceLanguage: options.source_language,
          targetLanguage: options.target_language,
          segments: batch,
          context,
        });
        const ids = batch.map(segment => String(segment.id));
        let parsed = null;
        for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
          try {
            const content = await chat({ prompt: attempt === 0 ? prompt : `${prompt}\n\nIMPORTANT: return one entry for every input id.`, signal });
            const lines = parseTranslationResponse(content, ids);
            if (lines.every(line => line.text)) parsed = lines;
          } catch (error) {
            if (signal?.aborted) throw error;
            if (attempt === 1) throw error;
          }
        }
        if (!parsed) {
          // One unparseable window must not throw away the whole translation.
          log(`translation window ${index / TRANSLATION_BATCH_SIZE + 1} could not be parsed; keeping source text for those lines`);
          parsed = batch.map(segment => ({ id: String(segment.id), text: null }));
        }
        translations.push(...parsed);
        context.push(...parsed.filter(line => line.text).slice(-3).map(line => line.text));
      }
      return translations;
    },

    async shorten(ctx) {
      const { text, targetLanguage, maxSeconds, sourceText, signal } = ctx;
      const prompt = buildTranslationPrompt({
        sourceLanguage: null,
        targetLanguage,
        segments: [{ id: 'line', text, start: 0, end: maxSeconds }],
        mode: 'shorten',
        maxSeconds: Number(maxSeconds.toFixed(2)),
      });
      const content = await chat({ prompt: `${prompt}\n\nOriginal source line for reference: ${sourceText || ''}`, signal });
      const lines = parseTranslationResponse(content, ['line']);
      const value = lines[0]?.text;
      if (!value) throw new Error('The adaptation pass returned no text.');
      return { text: value };
    },
  };
}

// ── Voice ───────────────────────────────────────────────────────────────────

export const VOICEBOX_SAY_NOTE = 'Standard local voice (no cloning).';

export function parseSayVoices(stdout) {
  const voices = [];
  for (const line of String(stdout || '').split('\n')) {
    const match = line.match(/^([^\s].*?)\s{2,}([a-z]{2,3})_([A-Z]{2})\s+(#.*)?$/);
    if (!match) continue;
    voices.push({ name: match[1].trim(), locale: `${match[2]}_${match[3]}`, language: match[2].toLowerCase() });
  }
  return voices;
}

export function createMacosSayVoice({ languages = null, runner = null } = {}) {
  let cached = null;
  const listVoices = async () => {
    if (cached) return cached;
    if (process.platform !== 'darwin') { cached = []; return cached; }
    try {
      const result = await runGovernedProcess({
        cmd: 'say', args: ['-v', '?'], timeoutMs: 20000,
        stdio: ['ignore', 'pipe', 'pipe'], detached: false,
        captureStdout: { maxBytes: 512 * 1024 },
      });
      cached = parseSayVoices(result.stdout.toString('utf8'));
    } catch { cached = []; }
    return cached;
  };
  const preferred = { pl: ['Zosia'], en: ['Samantha', 'Alex'], es: ['Monica'], de: ['Anna'], fr: ['Thomas'], it: ['Alice'], pt: ['Luciana'], nl: ['Xander'], ru: ['Milena'], ja: ['Kyoko'], zh: ['Tingting'], ko: ['Yuna'], sv: ['Alva'], da: ['Sara'], no: ['Nora'], fi: ['Satu'], tr: ['Yelda'], hi: ['Lekha'], th: ['Kanya'], ar: ['Maged'], he: ['Carmit'], el: ['Melina'], cs: ['Zuzana'], sk: ['Laura'], hu: ['Mariska'], ro: ['Ioana'], id: ['Damayanti'], vi: ['Linh'] };

  const engine = {
    id: 'macos-say',
    local: true,
    supportsClone: false,
    languages,
    cloneLanguages: [],
    async availability() {
      if (process.platform !== 'darwin') return { available: false, error: 'The macOS system voice is only available on macOS.' };
      const voices = await listVoices();
      if (!voices.length) return { available: false, error: 'No macOS system voices are installed. Add voices in System Settings → Accessibility → Spoken Content.' };
      return { available: true };
    },
    async supportedLanguages() {
      return [...new Set((await listVoices()).map(voice => voice.language))];
    },
    async synthesize(ctx) {
      const { text, language, outFile, signal } = ctx;
      const voices = await listVoices();
      const candidates = preferred[language] || [];
      const chosen = voices.find(voice => candidates.includes(voice.name))
        || voices.find(voice => voice.language === language)
        || null;
      if (!chosen) throw new Error(`No macOS system voice is installed for ${language}.`);
      const textFile = `${outFile}.txt`;
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(textFile, text, 'utf8');
      const aiff = `${outFile}.aiff`;
      try {
        const run = runner || ((cmd, args, options) => runGovernedProcess({ cmd, args, ...options }));
        // `--data-format` is not supported by every macOS `say` build, so the
        // system voice writes AIFF and FFmpeg normalizes it to 24 kHz mono.
        await run('say', ['-v', chosen.name, '-o', aiff, '-f', textFile], {
          timeoutMs: 10 * 60 * 1000, signal, stdio: ['ignore', 'ignore', 'pipe'], detached: false,
        });
        const ffmpegPath = ctx.ffmpegPath || defaultFfmpeg();
        await runGovernedFfmpeg({
          cmd: ffmpegPath,
          args: ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', aiff, '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', outFile],
          timeoutMs: 5 * 60 * 1000, signal,
        });
      } finally {
        try { fs.unlinkSync(textFile); } catch { /* best effort */ }
        try { fs.unlinkSync(aiff); } catch { /* best effort */ }
      }
      if (!fs.existsSync(outFile) || fs.statSync(outFile).size < 44) throw new Error('The system voice produced no audio.');
      return { file: outFile, engine: 'macos-say', voice: chosen.name };
    },
  };
  return engine;
}

export function createVoiceboxVoice({
  endpoint = process.env.VIDMYO_VOICEBOX_URL || DEFAULT_VOICEBOX_ENDPOINT,
  narrate = null,
  fetchImpl = fetch,
  languages = VOICEBOX_LANGUAGES,
} = {}) {
  const base = String(endpoint).replace(/\/+$/, '');
  const profiles = async () => {
    const response = await fetchImpl(`${base}/profiles`, { signal: AbortSignal.timeout(3000), redirect: 'manual' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const value = await response.json();
    if (!Array.isArray(value)) throw new Error('invalid profile list');
    return value.filter(profile => profile?.id && profile?.name).map(profile => ({ id: String(profile.id), name: String(profile.name) }));
  };

  return {
    id: 'voicebox',
    local: true,
    supportsClone: true,
    languages,
    cloneLanguages: languages,
    async availability() {
      try {
        const list = await profiles();
        if (!list.length) return { available: false, error: 'Voicebox is running but has no voice profiles. Create or import one, then check again.' };
        return { available: true, profiles: list };
      } catch (error) {
        return { available: false, error: `Voicebox is not reachable at ${base} (${error.message}). Translated audio will use the standard local voice.` };
      }
    },
    async synthesize(ctx) {
      const { text, language, voiceId, outFile, signal, run } = ctx;
      if (!voiceId) throw new Error('Choose a Voicebox voice profile before cloning a voice.');
      if (typeof narrate === 'function') {
        // Desktop path: the canonical narration implementation from electron/lib/voicebox.js.
        await narrate({ text, outWav: outFile, voiceId, language, endpoint: base, approved: true, run, signal, fetchImpl });
        return { file: outFile, engine: 'voicebox', voice: voiceId };
      }
      const response = await fetchImpl(`${base}/generate`, {
        method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
        body: JSON.stringify({ profile_id: voiceId, text, language, normalize: true }),
      });
      if (!response.ok) throw new Error(`Voicebox could not start narration (HTTP ${response.status}).`);
      const started = await response.json();
      const id = String(started?.id || '');
      if (!id) throw new Error('Voicebox returned no generation id.');
      const deadline = Date.now() + 15 * 60 * 1000;
      let status = null;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        const statusResponse = await fetchImpl(`${base}/generate/${encodeURIComponent(id)}/status`, {
          redirect: 'manual',
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15 * 60 * 1000)]) : AbortSignal.timeout(15 * 60 * 1000),
        });
        if (!statusResponse.ok) throw new Error(`Voicebox status check failed (HTTP ${statusResponse.status}).`);
        status = await readLastSseJson(statusResponse);
        if (['completed', 'failed', 'cancelled', 'canceled', 'not_found'].includes(status?.status)) break;
      }
      if (status?.status !== 'completed') throw new Error(`Voicebox narration ${status?.status || 'timed out'}.`);
      const audio = await fetchImpl(`${base}/audio/${encodeURIComponent(id)}`, {
        redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000),
      });
      if (!audio.ok) throw new Error(`Voicebox audio download failed (HTTP ${audio.status}).`);
      const bytes = Buffer.from(await audio.arrayBuffer());
      if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Voicebox returned an invalid WAV file.');
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, bytes);
      return { file: outFile, engine: 'voicebox', voice: voiceId };
    },
  };
}

async function readLastSseJson(response) {
  const text = await response.text();
  const entries = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(Boolean);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(entries[index]); } catch { /* heartbeat */ }
  }
  throw new Error('Voicebox returned an invalid generation status.');
}

// ── Alignment ───────────────────────────────────────────────────────────────

export const STRETCH_MIN = 0.85;
export const STRETCH_MAX = 1.20;

export function planAlignment({ generatedSeconds, targetSeconds }) {
  if (!(generatedSeconds > 0) || !(targetSeconds > 0)) return { action: 'keep', rate: 1 };
  const rate = generatedSeconds / targetSeconds;
  if (rate > STRETCH_MAX) {
    // Too long to stretch gracefully: ask translation to shorten first.
    return { action: 'shorten', rate, maxSeconds: targetSeconds };
  }
  if (rate >= 1.01) return { action: 'speed', rate };
  return { action: 'keep', rate };
}

export function buildAtempoChain(rate) {
  // atempo accepts 0.5–100 per instance; clamp to the advertised window.
  const clamped = Math.min(Math.max(rate, 0.5), 2.0);
  const parts = [];
  let remaining = clamped;
  while (remaining > 2.0) { parts.push('atempo=2.0'); remaining /= 2.0; }
  while (remaining < 0.5) { parts.push('atempo=0.5'); remaining /= 0.5; }
  parts.push(`atempo=${remaining.toFixed(4)}`);
  return parts.join(',');
}

// ── Separation (optional) ───────────────────────────────────────────────────

export const DEFAULT_SEPARATION_SCRIPT = path.join(DEFAULT_TRANSLATE_SCIPTS_DIR, 'separate.py');

/**
 * Optional local source separation (Demucs, MIT). It is never required: when it
 * is unavailable or fails, the job degrades to ducking and still completes.
 */
export function createDemucsSeparator({
  python = defaultPython(),
  script = DEFAULT_SEPARATION_SCRIPT,
  enabled = process.env.VIDMYO_TRANSLATE_DEMUCS !== '0',
} = {}) {
  const engine = {
    id: 'demucs',
    available: Boolean(enabled),
    async availability() {
      if (!enabled) return { available: false, error: 'Source separation is disabled (VIDMYO_TRANSLATE_DEMUCS=0).' };
      try {
        await runGovernedProcess({
          cmd: python,
          args: ['-c', 'import demucs, torch; print("ok")'],
          timeoutMs: 120000, stdio: ['ignore', 'pipe', 'pipe'], detached: false,
          captureStdout: { maxBytes: 4096 },
        });
        return { available: true };
      } catch (error) {
        return { available: false, error: `Demucs is not available for ${python} (${String(error.message).slice(0, 200)}).` };
      }
    },
    async separate(ctx) {
      const { project, signal, log } = ctx;
      const outDir = project.artifactPath('artifacts/separation');
      fs.mkdirSync(outDir, { recursive: true });
      log?.('separating the original audio into vocals and background');
      await runGovernedProcess({
        cmd: python,
        args: [script, project.artifactPath('artifacts/source.audio.wav'), outDir,
          '--model', process.env.VIDMYO_TRANSLATE_DEMUCS_MODEL || 'htdemucs',
          '--device', process.env.VIDMYO_TRANSLATE_DEMUCS_DEVICE || 'auto'],
        timeoutMs: 120 * 60 * 1000,
        signal,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      });
      const result = JSON.parse(fs.readFileSync(path.join(outDir, 'separation.json'), 'utf8'));
      // Copy the stems into the project so downstream artifacts stay inside it.
      const background = 'artifacts/separation/background.wav';
      const vocals = 'artifacts/separation/vocals.wav';
      fs.copyFileSync(result.no_vocals, project.artifactPath(background));
      fs.copyFileSync(result.vocals, project.artifactPath(vocals));
      return { background, vocals, model: result.model, device: result.device, seconds: result.elapsed_seconds };
    },
  };
  return engine;
}

// ── Mixing ──────────────────────────────────────────────────────────────────

const MIX_CHUNK = 20;

export function createFfmpegMixer({ ffmpegPath = defaultFfmpeg(), ffprobePath = defaultFfprobe() } = {}) {
  return {
    id: 'ffmpeg-mix',
    ffmpegPath,

    /** Gentle time-stretch one line into its speaking window (never beyond 0.85x–1.20x). */
    async ffmpegAtempo({ input, output, rate, signal }) {
      const chain = buildAtempoChain(rate);
      await runGovernedFfmpeg({
        cmd: ffmpegPath,
        args: ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', input,
          '-filter:a', chain, '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', output],
        timeoutMs: 10 * 60 * 1000, signal,
      });
      return output;
    },

    /** Place each fitted line at its original start time on a silent bed. */
    async buildSpeechTrack(ctx) {
      const { project, alignment, media, signal, log } = ctx;
      const bed = 'artifacts/voice/.bed.wav';
      const duration = Math.max(media.duration || 0, alignment.lines.reduce((max, line) => Math.max(max, line.start + line.output_duration), 0)) + 0.5;
      await runGovernedFfmpeg({
        cmd: ffmpegPath,
        args: ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi',
          '-i', 'anullsrc=r=24000:cl=mono', '-t', duration.toFixed(3), '-c:a', 'pcm_s16le',
          project.artifactPath(bed)],
        timeoutMs: 10 * 60 * 1000, signal,
      });

      const groups = [];
      for (let index = 0; index < alignment.lines.length; index += MIX_CHUNK) {
        groups.push(alignment.lines.slice(index, index + MIX_CHUNK));
      }
      const groupFiles = [];
      for (let index = 0; index < groups.length; index += 1) {
        const group = groups[index];
        const args = ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', project.artifactPath(bed)];
        for (const line of group) {
          args.push('-itsoffset', line.start.toFixed(3), '-i', project.artifactPath(line.file));
        }
        const inputs = ['[0:a]'].concat(group.map((_, offset) => `[${offset + 1}:a]`)).join('');
        args.push('-filter_complex', `${inputs}amix=inputs=${group.length + 1}:duration=first:normalize=0[a]`,
          '-map', '[a]', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', project.artifactPath(`artifacts/voice/.group${index}.wav`));
        await runGovernedFfmpeg({ cmd: ffmpegPath, args, timeoutMs: 30 * 60 * 1000, signal });
        groupFiles.push(`artifacts/voice/.group${index}.wav`);
      }

      const speech = 'artifacts/speech.wav';
      if (groupFiles.length <= 1) {
        const source = groupFiles[0] || bed;
        fs.copyFileSync(project.artifactPath(source), project.artifactPath(speech));
      } else {
        const args = ['-hide_banner', '-nostdin', '-v', 'error', '-y'];
        for (const file of groupFiles) args.push('-i', project.artifactPath(file));
        const inputs = groupFiles.map((_, index) => `[${index}:a]`).join('');
        args.push('-filter_complex', `${inputs}amix=inputs=${groupFiles.length}:duration=first:normalize=0[a]`,
          '-map', '[a]', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', project.artifactPath(speech));
        await runGovernedFfmpeg({ cmd: ffmpegPath, args, timeoutMs: 30 * 60 * 1000, signal });
      }
      for (const file of groupFiles) { try { fs.unlinkSync(project.artifactPath(file)); } catch { /* best effort */ } }

      // Normalise dialogue loudness before it is used as a sidechain key AND as
      // the mixed dialogue. Without this, a quiet TTS voice sits below the ducking
      // threshold and the original speech stays audible underneath the dub.
      const normalised = 'artifacts/voice/.speech-norm.wav';
      await runGovernedFfmpeg({
        cmd: ffmpegPath,
        args: ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', project.artifactPath(speech),
          '-af', 'loudnorm=I=-15:TP=-1.5:LRA=11', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le',
          project.artifactPath(normalised)],
        timeoutMs: 30 * 60 * 1000, signal,
      });
      fs.renameSync(project.artifactPath(normalised), project.artifactPath(speech));

      log(`speech track built from ${alignment.lines.length} lines`);
      return { artifact: speech, duration };
    },

    /** Mix translated speech with the original music/ambience. */
    async mix(ctx) {
      const { project, options, signal, background } = ctx;
      const speech = ctx.speech.artifact;
      const mode = !options.translate_audio ? 'replace' : (background?.mode || options.background_mode || 'duck');
      const out = 'artifacts/mixed.wav';
      // With separation the bed is the stem with the source vocals removed; with
      // ducking the bed is the original track (speech included) and the sidechain
      // compressor pushes it under the dub.
      const bedRelative = background?.separated && background?.background
        ? background.background
        : 'artifacts/source.audio.wav';
      const bed = project.artifactPath(bedRelative);
      const info = { mode, bed: bedRelative, speech: ctx.speech.duration ?? null, warnings: [] };

      const common = ['-hide_banner', '-nostdin', '-v', 'error', '-y',
        '-i', bed,
        '-i', project.artifactPath(speech)];

      if (mode === 'replace') {
        await runGovernedFfmpeg({
          cmd: ffmpegPath,
          args: ['-hide_banner', '-nostdin', '-v', 'error', '-y',
            '-i', project.artifactPath(speech),
            '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', project.artifactPath(out)],
          timeoutMs: 30 * 60 * 1000, signal,
        });
        return { artifact: out, info };
      }

      // Both background and speech are normalised to one layout so the mix is
      // sample-accurate regardless of the source codec. `apad` keeps the
      // sidechain alive past the last dialogue line: without it
      // sidechaincompress stops producing frames when the key runs out and the
      // bed — and therefore the whole render — would be truncated.
      //
      // Ducking depth: the key is dialogue normalised to -15 LUFS, threshold
      // 0.02 (-34 dB) with ratio 20 gives ~13 dB of gain reduction while a line
      // is speaking and 0 dB in the gaps, measured on the reference fixture
      // (docs/translate/PERFORMANCE.md). A single stage is deliberate: cascading
      // compressors deepen the duck but measurably attenuate the music between
      // lines, which is exactly what this mode must not do.
      // `separate` mixes the speech-removed stem at full level (no duck needed);
      // `duck` pushes the untouched original track under the dub.
      const normalise = '[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[bg];[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad[speech];';
      const filter = mode === 'duck'
        ? `${normalise}[speech]asplit=2[speechout][side];[bg][side]sidechaincompress=threshold=0.02:ratio=20:attack=5:release=400[ducked];[ducked][speechout]amix=inputs=2:duration=first:normalize=0[mix]`
        : `${normalise}[bg]volume=0.95[bgv];[bgv][speech]amix=inputs=2:duration=first:normalize=0[mix]`;
      await runGovernedFfmpeg({
        cmd: ffmpegPath,
        args: [...common, '-filter_complex', filter, '-map', '[mix]', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', project.artifactPath(out)],
        timeoutMs: 30 * 60 * 1000, signal,
      });
      if (mode === 'separate' && !background?.separated) {
        info.warnings.push('Source separation was unavailable; the original audio was ducked under the translated voice instead.');
      }
      return { artifact: out, info };
    },
  };
}

// ── Subtitles ───────────────────────────────────────────────────────────────

export function formatSrtTimestamp(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const millis = Math.round((total - Math.floor(total)) * 1000);
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(Math.min(millis, 999), 3)}`;
}

export function buildSrt(cues) {
  const blocks = cues.map((cue, index) => [
    String(index + 1),
    `${formatSrtTimestamp(cue.start)} --> ${formatSrtTimestamp(cue.end)}`,
    String(cue.text || '').replace(/\r?\n/g, ' ').trim(),
    '',
  ].join('\n'));
  return `${blocks.join('\n')}`.trimEnd() + '\n';
}

export function createSubtitleWriter() {
  return {
    id: 'srt',
    write(ctx) {
      const { project, options, transcription, translation } = ctx;
      const target = options.target_language;
      const source = options.source_language === 'auto' ? transcription.language : options.source_language;
      const translatedCues = translation.segments.map(segment => ({
        start: segment.start,
        end: Math.max(segment.start + 0.4, segment.end),
        text: segment.translated_text || segment.source_text,
      }));
      const targetFile = `artifacts/subtitles.${target}.srt`;
      fs.writeFileSync(project.artifactPath(targetFile), buildSrt(translatedCues), 'utf8');
      const outputs = [{ artifact: targetFile, language: target, kind: 'subtitles', cues: translatedCues.length }];
      if (source && source !== target) {
        const sourceFile = `artifacts/subtitles.${source}.srt`;
        fs.writeFileSync(project.artifactPath(sourceFile), buildSrt(transcription.segments.map(segment => ({
          start: segment.start, end: segment.end, text: segment.text,
        }))), 'utf8');
        outputs.push({ artifact: sourceFile, language: source, kind: 'source_subtitles', cues: transcription.segments.length });
      }
      return { outputs };
    },
  };
}

// ── Render ──────────────────────────────────────────────────────────────────

export const BURN_IN_STYLE = 'FontName=Helvetica,FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,BorderStyle=1,Outline=2,Shadow=0,MarginV=48,MarginL=48,MarginR=48';

/**
 * Is subtitle burn-in possible with this build? Takes the result of
 * `tryProbeFfmpegCapabilities`, which is `{ ok, report }` — NOT the report
 * itself. Passing a bare report here is a bug that silently disables burn-in on a
 * libass build, which is why the shape is tested explicitly.
 */
export function burnInSupported(probe) {
  const report = probe?.ok ? probe.report : null;
  return Boolean(report?.libass && (report.filters?.subtitles || report.filters?.ass));
}

export function createFfmpegRenderer({ ffmpegPath = defaultFfmpeg() } = {}) {
  const supportsBurnIn = burnInSupported(tryProbeFfmpegCapabilities({ ffmpegPath }));
  return {
    id: 'ffmpeg-render',
    ffmpegPath,
    supportsBurnIn,
    async render(ctx) {
      const { project, options, media, signal, log } = ctx;
      const target = options.target_language;
      const out = `artifacts/video.${target}.mp4`;
      const source = project.artifactPath(media.artifact);
      const audio = ctx.mix ? project.artifactPath(ctx.mix.artifact) : null;
      const subtitle = ctx.subtitles?.outputs?.find(item => item.language === target)?.artifact || null;
      const warnings = [];
      const burn = Boolean(options.burn_subtitles && options.subtitles && subtitle);
      if (options.burn_subtitles && !burn && options.subtitles) {
        warnings.push(supportsBurnIn
          ? 'Subtitles could not be burned in because no translated subtitle file was produced.'
          : 'This FFmpeg build has no libass/subtitles filter, so subtitles were exported as a separate SRT instead of being burned in.');
        if (!supportsBurnIn) project.warn(warnings[warnings.length - 1]);
      }

      const args = ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', source];
      if (audio) args.push('-i', audio);
      if (burn) {
        args.push('-map', '0:v:0', '-map', audio ? '1:a:0' : '0:a:0',
          '-vf', `subtitles=filename='${escapeFfmpegFilterPath(project.artifactPath(subtitle))}':force_style='${BURN_IN_STYLE}'`,
          '-c:v', 'libx264', '-preset', options.quality === 'fast' ? 'veryfast' : 'medium', '-crf', '20', '-pix_fmt', 'yuv420p');
      } else {
        args.push('-map', '0:v:0', '-map', audio ? '1:a:0' : '0:a:0', '-c:v', 'copy');
      }
      if (audio) args.push('-c:a', 'aac', '-b:a', '192k');
      args.push('-movflags', '+faststart', '-shortest', project.artifactPath(out));

      try {
        await runGovernedFfmpeg({ cmd: ffmpegPath, args, timeoutMs: 120 * 60 * 1000, signal });
      } catch (error) {
        if (!burn) throw error;
        // A burn-in failure must never throw away an otherwise finished
        // translation: retry without burning subtitles and keep the SRT.
        log(`subtitle burn-in failed (${error.message}); rendering without burned subtitles`);
        project.warn('Subtitle burn-in failed; the translated video was rendered without burned subtitles.');
        const fallback = ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', source];
        if (audio) fallback.push('-i', audio);
        fallback.push('-map', '0:v:0', '-map', audio ? '1:a:0' : '0:a:0', '-c:v', 'copy');
        if (audio) fallback.push('-c:a', 'aac', '-b:a', '192k');
        fallback.push('-movflags', '+faststart', '-shortest', project.artifactPath(out));
        await runGovernedFfmpeg({ cmd: ffmpegPath, args: fallback, timeoutMs: 120 * 60 * 1000, signal });
        warnings.push('Burned subtitles were skipped.');
      }
      if (!fs.existsSync(project.artifactPath(out))) throw new Error('The render produced no output file.');
      return { artifact: out, burned: burn, warnings };
    },
  };
}

// ── Lip sync (experimental, never required) ─────────────────────────────────

export function createLipsyncProvider({ enabled = process.env.VIDMYO_TRANSLATE_LIPSYNC === '1' } = {}) {
  return {
    id: 'local-lipsync',
    available: Boolean(enabled),
    experimental: true,
    async apply() {
      throw new Error('No local lip-sync backend is configured in this build.');
    },
  };
}

// ── Default engine set ──────────────────────────────────────────────────────

/**
 * Assemble the engine set used by the desktop bridge, the CLI, and MCP.
 * Pass `overrides` to substitute any engine (tests, alternative providers).
 */
export function createTranslateEngines(overrides = {}) {
  const ffmpegPath = overrides.ffmpegPath || defaultFfmpeg();
  const ffprobePath = overrides.ffprobePath || defaultFfprobe();

  const voicebox = overrides.voiceboxVoice || createVoiceboxVoice({
    narrate: overrides.voiceboxNarrate || null,
    fetchImpl: overrides.fetchImpl || fetch,
  });
  const say = overrides.sayVoice || createMacosSayVoice();

  const voice = overrides.voice || {
    id: 'translate-voice',
    local: true,
    supportsClone: true,
    languages: [...new Set([...(voicebox.languages || []), ...(say.languages || [])])].length
      ? [...new Set([...(voicebox.languages || []), ...(say.languages || [])])]
      : VOICEBOX_LANGUAGES,
    cloneLanguages: voicebox.cloneLanguages || VOICEBOX_LANGUAGES,
    async availability() {
      const [clone, standard] = await Promise.all([voicebox.availability(), say.availability()]);
      return {
        available: clone.available || standard.available,
        clone_available: clone.available,
        clone_error: clone.available ? null : clone.error,
        standard_available: standard.available,
        standard_error: standard.available ? null : standard.error,
        profiles: clone.profiles || [],
      };
    },
    // Prefer the cloning provider when a profile was chosen and it is reachable;
    // otherwise use the standard local voice and never silently go to a cloud API.
    async synthesize(ctx) {
      const wantsClone = Boolean(ctx.cloneVoice && ctx.voiceId);
      if (wantsClone) {
        const status = await voicebox.availability();
        if (status.available) return voicebox.synthesize(ctx);
        ctx.warn?.(`Voice cloning is unavailable (${status.error || 'provider offline'}); used the standard local voice instead.`);
      }
      return say.synthesize({ ...ctx, ffmpegPath });
    },
  };

  return {
    source: overrides.source || createSourceImporter(),
    audio: overrides.audio || createAudioExtractor({ ffmpegPath }),
    transcription: overrides.transcription || createFasterWhisperTranscriber({ python: overrides.python }),
    translation: overrides.translation || createOllamaTranslator({ fetchImpl: overrides.fetchImpl || fetch }),
    voice,
    separation: overrides.separation || createDemucsSeparator({ python: overrides.python }),
    mixer: overrides.mixer || createFfmpegMixer({ ffmpegPath, ffprobePath }),
    subtitles: overrides.subtitles || createSubtitleWriter(),
    render: overrides.render || createFfmpegRenderer({ ffmpegPath }),
    lipsync: overrides.lipsync || createLipsyncProvider(),
    ffmpegPath,
    ffprobePath,
    probe: overrides.probe || ((file, signal) => probeMedia(file, { ffprobePath, signal })),
  };
}
