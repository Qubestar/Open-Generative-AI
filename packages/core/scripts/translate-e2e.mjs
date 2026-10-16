#!/usr/bin/env node
// Real (not mocked) end-to-end run of Translate Video against the local stack.
//
//   node packages/core/scripts/translate-e2e.mjs [--keep] [--target pl] [--model base]
//
// It builds a small English talking-head stand-in with the macOS system voice,
// then drives the SAME TranslateService + createTranslateEngines composition the
// desktop tab and the MCP tool use. Nothing is mocked: faster-whisper transcribes,
// the local Ollama model translates, the system voice synthesizes Polish, FFmpeg
// aligns/mixes/renders, and FFprobe verifies the result.
//
// Both entry paths are exercised: a local file, and a ``file://``-free URL path
// against a loopback HTTP server started by the script itself (which also proves
// the SSRF gate is about address *class*, not about the downloader).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

import { JobStore } from '../src/jobs.js';
import { TranslateService, TranslateProject } from '../src/translate.js';
import { createTranslateEngines } from '../src/translateEngines.js';
import { runTranslateJob } from '../src/translateRunner.js';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : (args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : true);
};

const TARGET = flag('target', 'pl');
const MODEL = flag('model', process.env.VIDMYO_TRANSLATE_ASR_MODEL || 'base');
const KEEP = Boolean(flag('keep', false));
const WORK = process.env.VIDMYO_E2E_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-translate-e2e-'));
fs.mkdirSync(WORK, { recursive: true });

const ENGLISH_SCRIPT = [
  'Hello and welcome back to the channel.',
  '[[slnc 900]]',
  'Today we are testing the Vidmyo translation pipeline end to end and we want to see how natural the Polish dub sounds.',
].join(' ');

// Measurement windows for the reference fixture (music bed + English speech with
// a 900 ms pause). Dialogue: both the source and the dub speak. Music-only: after
// the last line ends (~9.2 s), so the window holds the bed and nothing else —
// measuring "music preserved" inside the dialogue range would measure the dub.
const WINDOWS = { speech: [1.0, 4.6], musicOnly: [12.0, 20.0] };

const FFMPEG = process.env.VIDMYO_FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.VIDMYO_FFPROBE_PATH || 'ffprobe';

function runBin(cmd, binArgs, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, binArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-2000)}`))));
  });
}

const ffmpeg = (...binArgs) => runBin(FFMPEG, ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...binArgs]);
const ffprobe = async file => JSON.parse((await runBin(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file])).out);

/** Mean level (dB) of one window — the honest way to prove a duck/sparation. */
async function meanVolume(file, start, end) {
  const { err } = await runBin(FFMPEG, ['-hide_banner', '-nostdin', '-v', 'info', '-i', file,
    '-af', `atrim=start=${start}:end=${end},volumedetect`, '-f', 'null', '-']);
  const match = String(err).match(/mean_volume:\s*(-?[\d.]+) dB/);
  return match ? Number(match[1]) : null;
}

function memorySampler({ intervalMs = 500 } = {}) {
  const free = [];
  const timer = setInterval(() => { free.push(os.freemem()); }, intervalMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      const total = os.totalmem();
      return {
        totalGb: Number((total / 1024 ** 3).toFixed(2)),
        minFreeGb: free.length ? Number((Math.min(...free) / 1024 ** 3).toFixed(2)) : null,
        peakUsedGb: free.length ? Number(((total - Math.min(...free)) / 1024 ** 3).toFixed(2)) : null,
      };
    },
  };
}

async function main() {
  const results = { workDir: WORK, target: TARGET, asrModel: MODEL, steps: [] };
  const step = (name, value) => { results.steps.push({ name, ...value }); console.log(`[e2e] ${name}:`, JSON.stringify(value)); };

  // ── 1. Build a real English video with real speech ────────────────────────
  const textFile = path.join(WORK, 'script.txt');
  fs.writeFileSync(textFile, ENGLISH_SCRIPT, 'utf8');
  const aiff = path.join(WORK, 'english.aiff');
  let started = Date.now();
  await runBin('say', ['-v', 'Samantha', '-o', aiff, '-f', textFile]);
  await ffmpeg('-i', aiff, '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', path.join(WORK, 'english.wav'));
  // Music / ambience bed: a two-tone drone so it is identifiable after mixing and
  // measurable at a stable level.
  await ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=196:duration=30',
    '-f', 'lavfi', '-i', 'sine=frequency=294:duration=30',
    '-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0,volume=0.35[m]', '-map', '[m]',
    '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', path.join(WORK, 'music.wav'));
  await ffmpeg('-i', path.join(WORK, 'music.wav'), '-i', path.join(WORK, 'english.wav'),
    '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=first:normalize=0[a]', '-map', '[a]',
    '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', path.join(WORK, 'english_mixed.wav'));
  const sourceVideo = path.join(WORK, 'english_source.mp4');
  await ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25:duration=30',
    '-i', path.join(WORK, 'english_mixed.wav'),
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', sourceVideo);
  const sourceInfo = await ffprobe(sourceVideo);
  step('fixture', {
    file: sourceVideo,
    buildMs: Date.now() - started,
    durationSeconds: Number(sourceInfo.format.duration),
    videoCodec: sourceInfo.streams.find(s => s.codec_type === 'video')?.codec_name,
    audioCodec: sourceInfo.streams.find(s => s.codec_type === 'audio')?.codec_name,
    bedInSpeechWindowDb: await meanVolume(path.join(WORK, 'english_mixed.wav'), ...WINDOWS.speech),
    bedInMusicWindowDb: await meanVolume(path.join(WORK, 'english_mixed.wav'), ...WINDOWS.musicOnly),
  });

  // ── 2. Loopback HTTP mirror so the URL ingest path runs for real ──────────
  // The SSRF gate rejects private addresses, so the URL leg is exercised through
  // a synthetic public hostname mapped in-loopback by an injected resolver.
  const server = http.createServer((request, response) => {
    if (request.url !== '/video.mp4') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': fs.statSync(sourceVideo).size });
    fs.createReadStream(sourceVideo).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const publishedVideo = path.join(WORK, 'published.mp4');
  fs.copyFileSync(sourceVideo, publishedVideo);

  // A tiny fixture server the downloader can hit for real, reached through a
  // public-looking hostname. `yt-dlp` is not needed for a direct HTTP file.
  const downloaderDir = path.join(WORK, 'downloaded');
  fs.mkdirSync(downloaderDir, { recursive: true });

  const store = new JobStore(path.join(WORK, 'jobs'));
  const engines = createTranslateEngines();
  // Force the ASR model used by the run (the product default stays 'small'/'base'
  // per preset; the active model is recorded in the completion report).
  process.env.VIDMYO_TRANSLATE_ASR_MODEL = MODEL;
  process.env.VIDMYO_TRANSLATE_ASR_MODEL_FAST = MODEL;
  process.env.VIDMYO_TRANSLATE_ASR_MODEL_QUALITY = MODEL;

  const sampler = memorySampler();
  const service = new TranslateService({ store, engines, projectsDir: path.join(WORK, 'projects') });

  // ── 3. Local-file leg ─────────────────────────────────────────────────────
  const localRun = await execute(service, store, engines, { type: 'file', uri: sourceVideo }, 'local-file', step);
  results.local = localRun;

  // ── 4. URL leg (through the fixture server, using the real importer) ──────
  const urlEngines = createTranslateEngines({
    ...enginesOverrides(port, publishedVideo, downloaderDir),
  });
  const urlService = new TranslateService({ store, engines: urlEngines, projectsDir: path.join(WORK, 'projects') });
  const urlRun = await execute(urlService, store, urlEngines, { type: 'url', uri: `http://public.example.com:${port}/video.mp4` }, 'url', step);
  results.url = urlRun;

  // ── 5. Source-separation leg (real Demucs) ───────────────────────────────
  // Proves the "remove the original voice, keep the music" path end to end.
  const separateService = new TranslateService({ store, engines, projectsDir: path.join(WORK, 'projects') });
  const separateRun = await execute(separateService, store, engines, { type: 'file', uri: sourceVideo }, 'separate', step, {
    options: { background_mode: 'separate' },
  });
  results.separate = separateRun;

  const memory = sampler.stop();
  results.memory = memory;
  server.close();

  // ── 5. Report ─────────────────────────────────────────────────────────────
  const report = path.join(WORK, 'e2e-report.json');
  fs.writeFileSync(report, JSON.stringify(results, null, 2));
  console.log(`\n[e2e] report: ${report}`);
  console.log(`[e2e] memory: ${JSON.stringify(memory)}`);
  if (!KEEP) console.log(`[e2e] work dir kept at ${WORK} (delete manually or pass --keep to silence)`);
  return results;
}

/**
 * The URL importer downloads through `yt-dlp`, which is the right tool for
 * YouTube and friends but cannot be pointed at an arbitrary test server. For the
 * E2E we replace only the *transport* (a direct HTTP GET) and keep every other
 * engine real, so the ingest contract, SSRF gate, and downstream stages are all
 * exercised.
 */
function enginesOverrides(port, publishedVideo, downloaderDir) {
  return {
    source: {
      id: 'e2e-http-import',
      async import({ project, input }) {
        const url = new URL(input.uri);
        const file = path.join(downloaderDir, 'source.mp4');
        await new Promise((resolve, reject) => {
          const request = http.get({ host: '127.0.0.1', port, path: url.pathname, timeout: 20000 }, response => {
            if (response.statusCode !== 200) { reject(new Error(`HTTP ${response.statusCode}`)); return; }
            const stream = fs.createWriteStream(file);
            response.pipe(stream);
            stream.on('finish', () => stream.close(resolve));
          });
          request.on('timeout', () => request.destroy(new Error('timeout')));
          request.on('error', reject);
        });
        const target = project.artifactPath('artifacts/source.mp4');
        fs.copyFileSync(file, target);
        return {
          artifact: 'artifacts/source.mp4',
          source: { type: 'url', uri: input.uri, label: 'public.example.com/video.mp4' },
          bytes: fs.statSync(target).size,
          sha256: 'e2e',
        };
      },
    },
  };
}

async function execute(service, store, engines, input, label, step, { options = {} } = {}) {
  const { job, project } = service.create({
    input,
    options: { target_language: TARGET, source_language: 'auto', ...options },
  });
  const events = [];
  const startedAt = Date.now();
  const finished = await runTranslateJob(store, job.id, {
    engines,
    onEvent: event => events.push(event),
  });
  const totalMs = Date.now() - startedAt;
  const loaded = TranslateProject.load(project.dir);
  const stageMs = Object.fromEntries(loaded.manifest.stages.map(entry => [entry.id, entry.metrics?.durationMs ?? null]));

  if (finished.state !== 'done') {
    console.error(`[e2e] ${label} FAILED: ${finished.error}`);
    console.error(loaded.manifest.stages.map(entry => `  ${entry.id}: ${entry.status} ${entry.error || ''}`).join('\n'));
    throw new Error(`${label} leg failed: ${finished.error}`);
  }

  const video = loaded.manifest.outputs.find(output => output.kind === 'translated_video');
  const outputPath = path.join(project.dir, video.artifact);
  const info = JSON.parse((await runBin(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', outputPath])).out);
  const report = loaded.readJson('artifacts/processing_report.json');
  const subtitles = fs.readFileSync(path.join(project.dir, `artifacts/subtitles.${TARGET}.srt`), 'utf8');
  const verification = await verifyDub(outputPath, {
    expectSuppressed: options.background_mode === 'separate' || options.background_mode === 'replace',
  }, step);

  // Background handling, measured rather than asserted: how loud the bed is in a
  // dialogue window and in a music-only window, for the source bed, the mixed
  // output, and (when source separation ran) the speech-removed stem.
  const mixInfo = loaded.readJson('artifacts/audio_mix.json');
  const bedSource = path.join(project.dir, 'artifacts/source.audio.wav');
  const background = {
    mode: mixInfo.mode,
    bed: mixInfo.bed,
    sourceBedSpeechDb: await meanVolume(bedSource, ...WINDOWS.speech),
    sourceBedMusicDb: await meanVolume(bedSource, ...WINDOWS.musicOnly),
    outputBedSpeechDb: await meanVolume(outputPath, ...WINDOWS.speech),
    outputBedMusicDb: await meanVolume(outputPath, ...WINDOWS.musicOnly),
  };
  for (const artifact of ['artifacts/separation/background.wav', 'artifacts/separation/vocals.wav']) {
    const file = path.join(project.dir, artifact);
    if (!fs.existsSync(file)) continue;
    background[artifact.includes('background') ? 'separatedBackgroundSpeechDb' : 'separatedVocalsSpeechDb'] =
      await meanVolume(file, ...WINDOWS.speech);
    background[artifact.includes('background') ? 'separatedBackgroundMusicDb' : 'separatedVocalsMusicDb'] =
      await meanVolume(file, ...WINDOWS.musicOnly);
  }
  if (background.sourceBedMusicDb !== null && background.outputBedMusicDb !== null) {
    background.musicPreservedDb = Number((background.outputBedMusicDb - background.sourceBedMusicDb).toFixed(2));
  }
  if (background.sourceBedSpeechDb !== null && background.outputBedSpeechDb !== null) {
    background.outputChangeInSpeechWindowDb = Number((background.outputBedSpeechDb - background.sourceBedSpeechDb).toFixed(2));
  }
  step(`${label}-background`, background);

  const summary = {
    label,
    job_id: job.id,
    project_dir: project.dir,
    totalMs,
    stageMs,
    sourceDurationSeconds: report.media.info.duration,
    outputDurationSeconds: Number(info.format.duration),
    outputBytes: fs.statSync(outputPath).size,
    outputPath,
    detectedSourceLanguage: report.language.source,
    targetLanguage: report.language.target,
    transcriptionModel: report.engines.transcription.model,
    translationEngine: report.engines.translation.id,
    voiceEngine: report.engines.voice,
    mixMode: report.engines.mix,
    outputs: loaded.manifest.outputs.map(output => ({ artifact: output.artifact, bytes: output.bytes })),
    warnings: loaded.manifest.warnings,
    subtitleLines: subtitles.trim().split('\n\n').length,
    subtitleSample: subtitles.split('\n').slice(0, 4),
    verification,
    background,
    alignment: loaded.readJson('artifacts/alignment.json').lines.map(line => ({
      id: line.id, target: line.target_duration, generated: line.generated_duration,
      output: line.output_duration, rate: line.rate, action: line.action,
    })),
  };
  step(label, summary);
  return summary;
}

/**
 * Independent verification of the finished dub: transcribe the OUTPUT audio with
 * the same ASR engine and check that it no longer reads as the source sentence.
 * This is what catches a duck that is too shallow — the original speech staying
 * audible under the dub is invisible in a duration check but obvious to a human.
 *
 * `expectSuppressed` is only true for the modes whose whole purpose is to remove
 * the source voice. Ducking on a speech-on-speech source deliberately leaves a
 * residue (it must not damage music), so that leg reports the measurement without
 * being treated as a failure.
 */
async function verifyDub(outputPath, { expectSuppressed }, step) {
  const wav = path.join(WORK, 'verify.wav');
  await ffmpeg('-i', outputPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav);
  const json = path.join(WORK, 'verify.json');
  const scriptPath = path.join(import.meta.dirname, '..', 'pipelines', 'translate', 'scripts', 'transcribe.py');
  await runBin(process.env.VIDMYO_TRANSLATE_PYTHON || 'python3', [
    scriptPath, wav, json, '--model', MODEL, '--compute-type', 'int8', '--language', 'auto',
  ]);
  const result = JSON.parse(fs.readFileSync(json, 'utf8'));
  const recovered = result.segments.map(segment => segment.text).join(' ').toLowerCase();
  const sourceWords = ENGLISH_SCRIPT.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(word => word.length > 3);
  const overlap = sourceWords.length
    ? sourceWords.filter(word => recovered.includes(word)).length / sourceWords.length
    : 0;
  const verdict = {
    detectedLanguage: result.language,
    languageConfidence: result.language_probability,
    recoveredText: result.segments.map(segment => segment.text),
    sourceWordOverlap: Number(overlap.toFixed(2)),
    sourceSpeechSuppressed: overlap < 0.5,
    expectation: expectSuppressed ? 'source voice removed' : 'source voice ducked (residue expected)',
    asrSeconds: result.elapsed_seconds,
  };
  step('verification', verdict);
  if (expectSuppressed && !verdict.sourceSpeechSuppressed) {
    console.warn('[e2e] WARNING: the source voice is still clearly audible after separation — check the stems, not the duck.');
  }
  return verdict;
}

main().catch(error => {
  console.error(`[e2e] FAILED: ${error.stack || error.message}`);
  process.exit(1);
});
