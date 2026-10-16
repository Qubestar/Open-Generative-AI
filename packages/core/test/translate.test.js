// Translate Video — contract, security, pipeline and resumability tests.
//
// Every expensive engine (Whisper, the translation LLM, TTS, FFmpeg) is replaced
// with a deterministic fake, so this suite is offline, fast, and safe to run
// while the desktop app is in use. The real end-to-end run is a separate,
// explicit script (see docs/translate/E2E.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { JobStore } from '../src/jobs.js';
import {
  TranslateService, TranslateProject, translateCapabilities, translateJobSummary,
  normalizeTranslateInput, normalizeTranslateOptions, planStages, assertSafeSourceUrl,
  assertSafeLocalFile, assertResolvablePublicHost, sanitizeArtifactName,
  insideTranslateProject, TRANSLATE_JOB_TYPE, TRANSLATE_STAGES,
  translateLanguage, DEFAULT_TRANSLATE_OPTIONS,
} from '../src/translate.js';
import {
  buildSrt, formatSrtTimestamp, planAlignment, buildAtempoChain, parseTranslationResponse,
  parseProbeOutput, transcriptionModelFor, parseSayVoices, burnInSupported,
} from '../src/translateEngines.js';
import { runTranslateJob } from '../src/translateRunner.js';

const tmpdir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function makeSourceVideo(dir = tmpdir('vidmyo-translate-src-'), name = 'clip.mp4') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(2048, 7));
  return file;
}

/** Deterministic stand-ins for every expensive engine. */
function fakeEngines(overrides = {}) {
  const calls = [];
  const record = name => { calls.push(name); };
  const engines = {
    ffmpegPath: '/usr/bin/false',
    ffprobePath: '/usr/bin/false',
    calls,
    probe: async file => {
      record(`probe:${path.basename(file)}`);
      const base = path.basename(file);
      if (base.startsWith('video.')) {
        return { duration: 6.0, hasVideo: true, hasAudio: true, width: 1280, height: 720, videoCodec: 'h264', audioCodec: 'aac' };
      }
      if (base.endsWith('.wav')) {
        // Duration is derived from the byte size so synthesized line length
        // actually influences the alignment stage.
        const size = fs.existsSync(file) ? fs.statSync(file).size : 64;
        return { duration: size / 100, hasVideo: false, hasAudio: true };
      }
      return { duration: 6.0, hasVideo: true, hasAudio: true, width: 1280, height: 720 };
    },
    source: {
      id: 'fake-import',
      async import({ project, input }) {
        record('import');
        const name = 'source.mp4';
        const target = project.artifactPath(`artifacts/${name}`);
        if (input.type === 'file') fs.copyFileSync(input.uri, target);
        else fs.writeFileSync(target, Buffer.alloc(1024, 3));
        return {
          artifact: `artifacts/${name}`,
          source: { type: input.type, uri: input.uri, label: input.type === 'url' ? 'example.com/watch' : 'clip.mp4' },
          bytes: fs.statSync(target).size,
          sha256: 'deadbeef',
        };
      },
    },
    audio: {
      id: 'fake-audio',
      async extract({ project }) {
        record('extract_audio');
        fs.writeFileSync(project.artifactPath('artifacts/source.asr.wav'), Buffer.alloc(64, 1));
        fs.writeFileSync(project.artifactPath('artifacts/source.audio.wav'), Buffer.alloc(64, 2));
        return { asr: 'artifacts/source.asr.wav', background: 'artifacts/source.audio.wav' };
      },
    },
    transcription: {
      id: 'fake-whisper',
      local: true,
      languages: ['en', 'pl'],
      model: 'fake-small',
      detectedLanguage: 'en',
      async transcribe({ options }) {
        record('transcribe');
        return {
          language: options.source_language === 'auto' ? this.detectedLanguage : options.source_language,
          languageProbability: 0.98,
          duration: 6.0,
          segments: [
            { id: 0, start: 0, end: 2.8, text: 'Hello and welcome back.', words: [] },
            { id: 1, start: 3.0, end: 6.0, text: 'Today we look at dubbing.', words: [] },
          ],
        };
      },
    },
    translation: {
      id: 'fake-llm',
      local: true,
      model: 'fake-translator',
      languages: ['pl', 'es', 'en', 'de'],
      translated: {},
      async translate({ segments }) {
        record('translate');
        return segments.map(segment => ({ id: segment.id, text: this.translated[segment.id] ?? `PL:${segment.text}` }));
      },
      async shorten({ text }) {
        record('shorten');
        return { text: text.slice(0, Math.max(4, Math.floor(text.length * 0.6))) };
      },
    },
    voice: {
      id: 'fake-voice',
      local: true,
      supportsClone: true,
      languages: ['pl', 'en'],
      cloneLanguages: ['pl'],
      availabilityState: { available: true, clone_available: true, clone_error: null, standard_available: true, profiles: [{ id: 'v42', name: 'Voice 42' }] },
      async availability() { return this.availabilityState; },
      async synthesize({ outFile, text }) {
        record('synthesize');
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(Math.max(64, text.length * 4), 9)]));
        return { file: outFile, engine: 'fake' };
      },
    },
    separation: { id: 'fake-demucs', available: false, async separate() { throw new Error('not configured'); } },
    mixer: {
      id: 'fake-mix',
      async ffmpegAtempo({ output, input }) {
        record('atempo');
        // Keep the byte-proportional duration model consistent after stretching.
        const size = fs.existsSync(input) ? fs.statSync(input).size : 64;
        fs.writeFileSync(output, Buffer.alloc(Math.max(64, Math.round(size * 0.8)), 5));
        return output;
      },
      async buildSpeechTrack({ project }) {
        record('build_speech');
        fs.writeFileSync(project.artifactPath('artifacts/speech.wav'), Buffer.alloc(64, 6));
        return { artifact: 'artifacts/speech.wav', duration: 6.0 };
      },
      async mix({ project, background, options }) {
        record('mix');
        fs.writeFileSync(project.artifactPath('artifacts/mixed.wav'), Buffer.alloc(64, 7));
        return { artifact: 'artifacts/mixed.wav', info: { mode: background?.mode || options.background_mode, warnings: [] } };
      },
    },
    subtitles: {
      id: 'fake-srt',
      write({ project, transcription, translation, options }) {
        record('subtitles');
        const cues = translation.segments.map(segment => ({ start: segment.start, end: segment.end, text: segment.translated_text }));
        const file = `artifacts/subtitles.${options.target_language}.srt`;
        fs.writeFileSync(project.artifactPath(file), buildSrt(cues), 'utf8');
        return { outputs: [{ artifact: file, language: options.target_language, kind: 'subtitles', cues: cues.length }] };
      },
    },
    render: {
      id: 'fake-render',
      supportsBurnIn: true,
      failures: 0,
      async render({ project, options }) {
        record('render');
        if (this.failures > 0) { this.failures -= 1; throw new Error('encoder exploded'); }
        const file = `artifacts/video.${options.target_language}.mp4`;
        fs.writeFileSync(project.artifactPath(file), Buffer.alloc(4096, 8));
        return { artifact: file, burned: false, warnings: [] };
      },
    },
    lipsync: { id: 'fake-lipsync', available: false, experimental: true, async apply() { throw new Error('no backend'); } },
  };
  return Object.assign(engines, overrides);
}

function makeService({ engines = fakeEngines() } = {}) {
  const store = new JobStore(tmpdir('vidmyo-translate-jobs-'));
  const projectsDir = tmpdir('vidmyo-translate-projects-');
  return { store, engines, service: new TranslateService({ store, engines, projectsDir }) };
}

async function runToCompletion(service, engines, jobId, options = {}) {
  const job = service.store.get(jobId);
  return runTranslateJob(service.store, jobId, { engines, ...options });
}

// ── Contract ────────────────────────────────────────────────────────────────

test('URL and local file inputs converge on one canonical input descriptor', () => {
  const file = makeSourceVideo();
  const fromFile = normalizeTranslateInput({ type: 'file', uri: file });
  const fromUrl = normalizeTranslateInput('https://example.com/watch?v=abc');
  assert.deepEqual(Object.keys(fromFile).sort(), ['type', 'uri']);
  assert.deepEqual(Object.keys(fromUrl).sort(), ['type', 'uri']);
  assert.equal(fromFile.type, 'file');
  assert.equal(fromFile.uri, path.resolve(file));
  assert.equal(fromUrl.type, 'url');
  assert.equal(fromUrl.uri, 'https://example.com/watch?v=abc');

  // A bare string is accepted and classified by shape, so the MCP `input`
  // field and the UI field take exactly the same values.
  assert.equal(normalizeTranslateInput(file).type, 'file');
  assert.equal(normalizeTranslateInput('https://example.com/a.mp4').type, 'url');
  // An existing Vidmyo media reference resolves to the same local-file shape.
  assert.equal(normalizeTranslateInput({ type: 'media', uri: file }).type, 'media');
});

test('unsafe URLs are rejected (schemes, credentials, loopback, link-local, internal)', () => {
  const rejected = [
    'file:///etc/passwd',
    'ftp://example.com/video.mp4',
    'javascript:alert(1)',
    'http://127.0.0.1/video.mp4',
    'http://localhost:8080/v.mp4',
    'http://[::1]/v.mp4',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/v.mp4',
    'http://192.168.1.20/v.mp4',
    'http://172.16.9.9/v.mp4',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://nas.local/video.mp4',
    'http://user:pass@example.com/v.mp4',
  ];
  for (const value of rejected) {
    assert.throws(() => assertSafeSourceUrl(value), /URL|cannot|invalid|Only http|credentials|addresses/i, `expected rejection: ${value}`);
  }
  assert.equal(assertSafeSourceUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});

test('a public hostname resolving into the LAN is refused before download', async () => {
  await assert.rejects(
    () => assertResolvablePublicHost('https://rebind.example.com/v.mp4', {
      lookupImpl: async () => [{ address: '192.168.0.10', family: 4 }],
    }),
    /private or link-local/i,
  );
  assert.equal(await assertResolvablePublicHost('https://cdn.example.com/v.mp4', {
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
  }), true);
});

test('unsafe or unsupported local paths are rejected', () => {
  const dir = tmpdir('vidmyo-translate-path-');
  const good = path.join(dir, 'clip.mp4');
  fs.writeFileSync(good, 'x');
  const notes = path.join(dir, 'notes.txt');
  fs.writeFileSync(notes, 'x');
  const empty = path.join(dir, 'empty.mp4');
  fs.writeFileSync(empty, '');

  assert.equal(assertSafeLocalFile(good), good);
  assert.throws(() => assertSafeLocalFile('relative/clip.mp4'), /absolute/);
  assert.throws(() => assertSafeLocalFile(path.join(dir, 'missing.mp4')), /does not exist/);
  assert.throws(() => assertSafeLocalFile(notes), /Unsupported video format/);
  assert.throws(() => assertSafeLocalFile(empty), /empty/);
  assert.throws(() => assertSafeLocalFile(dir), /not a file/);
});

test('artifact names are sanitized and project paths cannot escape', () => {
  assert.equal(sanitizeArtifactName('../../etc/pa sswd'), 'pa_sswd');
  assert.equal(sanitizeArtifactName('video_pl.mp4'), 'video_pl.mp4');
  const projectDir = tmpdir('vidmyo-translate-escape-');
  assert.throws(() => insideTranslateProject(projectDir, '../secrets.json'), /outside the translate project/);
  assert.ok(insideTranslateProject(projectDir, 'artifacts/a.srt').startsWith(projectDir));
});

test('options normalize language pairs and refuse nonsense', () => {
  const defaults = normalizeTranslateOptions({});
  assert.equal(defaults.source_language, 'auto');
  assert.equal(defaults.target_language, DEFAULT_TRANSLATE_OPTIONS.target_language);
  assert.equal(defaults.quality, 'quality');

  const spanish = normalizeTranslateOptions({ source_language: 'EN', target_language: 'ES', quality: 'fast', burn_subtitles: true });
  assert.equal(spanish.source_language, 'en');
  assert.equal(spanish.target_language, 'es');
  assert.equal(spanish.quality, 'fast');
  assert.equal(spanish.burn_subtitles, true);

  assert.throws(() => normalizeTranslateOptions({ target_language: 'klingon' }), /Unsupported language/);
  assert.throws(() => normalizeTranslateOptions({ quality: 'ultra' }), /fast.*quality/);
  assert.throws(() => normalizeTranslateOptions({ source_language: 'pl', target_language: 'pl' }), /must differ/);
  assert.throws(() => normalizeTranslateOptions({ subtitles: 'yes' }), /true or false/);
  // Audio-free jobs cannot clone a voice or lip-sync.
  const subtitlesOnly = normalizeTranslateOptions({ translate_audio: false, clone_voice: true, lip_sync: true });
  assert.equal(subtitlesOnly.clone_voice, false);
  assert.equal(subtitlesOnly.lip_sync, false);
  assert.equal(subtitlesOnly.background_mode, 'keep');
});

test('stage planning follows the requested options', () => {
  assert.deepEqual(planStages(normalizeTranslateOptions({ subtitles: false })), [
    'import', 'analyze', 'extract_audio', 'transcribe', 'translate',
    'synthesize', 'align', 'mix', 'render', 'validate',
  ]);
  const noAudio = planStages(normalizeTranslateOptions({ translate_audio: false }));
  assert.ok(!noAudio.includes('mix'));
  const everything = planStages(normalizeTranslateOptions({ lip_sync: true }));
  assert.ok(everything.indexOf('lipsync') > everything.indexOf('mix'));
  assert.equal(everything[everything.length - 1], 'validate');
  // Every planned stage is a real stage.
  for (const stage of everything) assert.ok(TRANSLATE_STAGES.includes(stage));
});

test('capability discovery reports language pairs and voice-clone support separately', async () => {
  const { service, engines } = makeService();
  const caps = await service.capabilities();
  assert.equal(caps.contract_version, 1);
  assert.ok(caps.target_languages.some(item => item.code === 'pl'));
  assert.deepEqual(caps.voice_clone_languages.map(item => item.code), ['pl']);
  assert.equal(caps.auto_detect, true);
  assert.equal(caps.modes.lip_sync, false);
  assert.equal(caps.engines.translation.local, true);
  assert.ok(caps.notes.some(note => /permission from the speaker/i.test(note)));

  // Degraded voice engine: translation still offered, fallback explained.
  const degraded = fakeEngines();
  degraded.voice = {
    ...engines.voice,
    availabilityState: {
      available: false, clone_available: false, clone_error: 'Voicebox is not reachable at http://127.0.0.1:17493',
      standard_available: false, standard_error: 'No macOS system voices are installed.', profiles: [],
    },
  };
  const caps2 = await translateCapabilities({ engines: degraded });
  assert.equal(caps2.engines.voice.available, false);
  assert.equal(caps2.engines.voice.clone_available, false);
  assert.match(caps2.engines.voice.unavailable_reason, /not reachable/);
  assert.deepEqual(caps2.voice_clone_languages.map(item => item.code), ['pl']);
});

// ── Pipeline ────────────────────────────────────────────────────────────────

test('Local file EN → PL runs every stage and publishes a complete artifact manifest', async () => {
  const { service, store, engines } = makeService();
  const source = makeSourceVideo();
  const { job, project } = service.create({
    input: { type: 'file', uri: source },
    options: { target_language: 'pl', source_language: 'auto', voice_id: 'v42' },
  });
  assert.equal(job.type, TRANSLATE_JOB_TYPE);
  assert.equal(job.state, 'queued');
  assert.equal(job.params.resourceClass, 'heavy');

  const finished = await runToCompletion(service, engines, job.id);
  assert.equal(finished.state, 'done', finished.error || '');

  const loaded = TranslateProject.load(project.dir);
  for (const entry of loaded.manifest.stages) {
    assert.equal(entry.status, 'done', `${entry.id} should be done (${entry.error || ''})`);
  }
  assert.equal(loaded.manifest.language.source, 'en');

  const kinds = loaded.manifest.outputs.map(output => output.kind);
  for (const kind of ['translated_video', 'translated_subtitles', 'source_transcript', 'translation', 'processing_report']) {
    assert.ok(kinds.includes(kind), `missing output kind ${kind}: ${kinds.join(', ')}`);
  }
  const video = loaded.manifest.outputs.find(output => output.kind === 'translated_video');
  assert.equal(video.artifact, 'artifacts/video.pl.mp4');
  assert.ok(fs.existsSync(path.join(project.dir, video.artifact)));

  const srt = fs.readFileSync(path.join(project.dir, 'artifacts/subtitles.pl.srt'), 'utf8');
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:02,800\nPL:Hello and welcome back\./);
  assert.match(srt, /PL:Today we look at dubbing\./);

  const report = loaded.readJson('artifacts/processing_report.json');
  assert.equal(report.language.target, 'pl');
  assert.equal(report.language.detected_by, 'fake-whisper');
  assert.equal(report.engines.translation.local !== false, true);

  // Job-level view used by the UI and MCP polling.
  const summary = translateJobSummary(store.get(job.id), { project: loaded });
  assert.equal(summary.state, 'done');
  assert.equal(summary.progress, 100);
  assert.equal(summary.target_language, 'pl');
  assert.equal(summary.source_language, 'en');
  assert.equal(summary.stages.length, loaded.manifest.stages.length);
  assert.ok(summary.metrics.totalMs >= 0);
});

test('URL input goes through the same stages and records its source', async () => {
  const { service, engines } = makeService();
  const { job, project } = service.create({
    input: { type: 'url', uri: 'https://www.youtube.com/watch?v=abc12345678' },
    options: { target_language: 'pl' },
  });
  const finished = await runToCompletion(service, engines, job.id);
  assert.equal(finished.state, 'done', finished.error || '');
  const project2 = TranslateProject.load(project.dir);
  assert.equal(project2.manifest.input.type, 'url');
  assert.equal(project2.readJson('artifacts/media.json').source.type, 'url');
  // Same canonical artifact name whatever the input type.
  assert.ok(project2.has('artifacts/source.mp4'));
});

test('a URL job that cannot download fails at import and leaves earlier work untouched', async () => {
  const engines = fakeEngines();
  engines.source.import = async () => { throw new Error('That video host could not be resolved.'); };
  const { service } = makeService({ engines });
  const { job, project } = service.create({ input: { type: 'url', uri: 'https://example.com/v.mp4' }, options: {} });
  const finished = await runToCompletion(service, engines, job.id);
  assert.equal(finished.state, 'error');
  assert.match(finished.error, /import: /);
  const loaded = TranslateProject.load(project.dir);
  assert.equal(loaded.stage('import').status, 'failed');
  assert.equal(loaded.stage('transcribe').status, 'pending');
});

test('a late render failure never re-runs transcription, and a retry resumes there', async () => {
  const { service, engines } = makeService();
  engines.render.failures = 1;
  const source = makeSourceVideo();
  const { job, project } = service.create({ input: { type: 'file', uri: source }, options: { target_language: 'pl' } });

  const failed = await runToCompletion(service, engines, job.id);
  assert.equal(failed.state, 'error');
  assert.match(failed.error, /render/);
  const transcribeCalls = engines.calls.filter(name => name === 'transcribe').length;
  const translateCalls = engines.calls.filter(name => name === 'translate').length;
  assert.equal(transcribeCalls, 1);
  assert.equal(translateCalls, 1);

  const loaded = TranslateProject.load(project.dir);
  assert.equal(loaded.stage('import').status, 'done');
  assert.equal(loaded.stage('transcribe').status, 'done');
  assert.equal(loaded.stage('render').status, 'failed');

  // A retry is a NEW job over the SAME project: only the failed stage re-runs.
  const retry = service.retry(job.id);
  assert.notEqual(retry.job.id, job.id);
  assert.equal(retry.job.params.projectDir, job.params.projectDir);
  assert.match(retry.job.logs.at(-1).message, /resuming at render/);

  const finished = await runToCompletion(service, engines, retry.job.id);
  assert.equal(finished.state, 'done', finished.error || '');
  assert.equal(engines.calls.filter(name => name === 'transcribe').length, 1, 'transcription must not run twice');
  assert.equal(engines.calls.filter(name => name === 'translate').length, 1, 'translation must not run twice');
  assert.equal(engines.calls.filter(name => name === 'render').length, 2);
  // The failed attempt keeps its own history.
  assert.equal(service.store.get(job.id).state, 'error');
  assert.equal(service.store.get(retry.job.id).state, 'done');
});

test('optional lip sync failure still yields a finished translated video', async () => {
  const { service, engines } = makeService();
  const source = makeSourceVideo();
  const { job, project } = service.create({
    input: { type: 'file', uri: source },
    options: { target_language: 'pl', lip_sync: true },
  });
  const finished = await runToCompletion(service, engines, job.id);
  assert.equal(finished.state, 'done', finished.error || '');
  const loaded = TranslateProject.load(project.dir);
  assert.equal(loaded.stage('lipsync').status, 'skipped');
  assert.ok(loaded.manifest.warnings.some(message => /lip-sync/i.test(message)));
  assert.ok(loaded.manifest.outputs.some(output => output.kind === 'translated_video'));
});

test('source separation failure degrades to ducking instead of failing the job', async () => {
  const { service, engines } = makeService();
  const source = makeSourceVideo();
  const { job, project } = service.create({
    input: { type: 'file', uri: source },
    options: { target_language: 'pl', background_mode: 'separate' },
  });
  const finished = await runToCompletion(service, engines, job.id);
  assert.equal(finished.state, 'done', finished.error || '');
  const loaded = TranslateProject.load(project.dir);
  assert.equal(loaded.readJson('artifacts/audio_mix.json').mode, 'duck');
  assert.ok(loaded.manifest.warnings.some(message => /separation/i.test(message)));
});

test('the voice provider boundary clones when available and falls back when not', async () => {
  const { createTranslateEngines } = await import('../src/translateEngines.js');
  const source = makeSourceVideo();

  const makeEngines = (voiceboxStatus) => {
    const fake = fakeEngines();
    const say = {
      id: 'fake-say', local: true, supportsClone: false, languages: ['pl', 'en'], cloneLanguages: [],
      async availability() { return { available: true }; },
      async synthesize({ outFile, text }) {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(Math.max(64, text.length * 4), 1)]));
        return { file: outFile, engine: 'fake-say' };
      },
    };
    const voicebox = {
      id: 'fake-voicebox', local: true, supportsClone: true, languages: ['pl'], cloneLanguages: ['pl'],
      async availability() { return voiceboxStatus; },
      async synthesize({ outFile, text }) {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(Math.max(64, text.length * 4), 2)]));
        return { file: outFile, engine: 'fake-voicebox' };
      },
    };
    return createTranslateEngines({
      ffmpegPath: '/usr/bin/false',
      source: fake.source, audio: fake.audio, transcription: fake.transcription,
      translation: fake.translation, mixer: fake.mixer, subtitles: fake.subtitles,
      render: fake.render, probe: fake.probe, separation: fake.separation, lipsync: fake.lipsync,
      sayVoice: say, voiceboxVoice: voicebox,
    });
  };

  // Cloning available: the cloning provider is used.
  const clonedEngines = makeEngines({ available: true, clone_available: true, profiles: [{ id: 'v42', name: 'Voice 42' }] });
  const cloned = makeService({ engines: clonedEngines });
  const first = cloned.service.create({
    input: { type: 'file', uri: source },
    options: { target_language: 'pl', clone_voice: true, voice_id: 'v42' },
  });
  const firstRun = await runToCompletion(cloned.service, clonedEngines, first.job.id);
  assert.equal(firstRun.state, 'done', firstRun.error || '');
  const voiceIndex = TranslateProject.load(first.project.dir).readJson('artifacts/voice/index.json');
  assert.equal(voiceIndex.cloned, true);
  assert.equal(voiceIndex.engine, 'voicebox');

  // Cloning unavailable: standard local voice plus an explicit warning — never a
  // silent cloud substitution.
  const fallbackEngines = makeEngines({
    available: false, clone_available: false, clone_error: 'Voicebox is not reachable',
    standard_available: true, profiles: [],
  });
  const fallback = makeService({ engines: fallbackEngines });
  const second = fallback.service.create({
    input: { type: 'file', uri: source },
    options: { target_language: 'pl', clone_voice: true, voice_id: 'v42' },
  });
  const secondRun = await runToCompletion(fallback.service, fallbackEngines, second.job.id);
  assert.equal(secondRun.state, 'done', secondRun.error || '');
  const fallbackProject = TranslateProject.load(second.project.dir);
  assert.equal(fallbackProject.readJson('artifacts/voice/index.json').cloned, false);
  assert.ok(fallbackProject.manifest.warnings.some(message => /cloning/i.test(message)), fallbackProject.manifest.warnings.join(' | '));
  assert.ok(fallbackProject.manifest.outputs.some(output => output.kind === 'translated_video'));
});

test('auto-detected source already matching the target skips the LLM and warns', async () => {
  const { service, engines } = makeService();
  engines.transcription.detectedLanguage = 'pl';
  const source = makeSourceVideo();
  const { job, project } = service.create({ input: { type: 'file', uri: source }, options: { target_language: 'pl' } });
  const finished = await runToCompletion(service, engines, job.id);
  assert.equal(finished.state, 'done', finished.error || '');
  assert.equal(engines.calls.filter(name => name === 'translate').length, 0);
  const loaded = TranslateProject.load(project.dir);
  assert.ok(loaded.manifest.warnings.some(message => /unchanged/i.test(message)));
  assert.equal(loaded.readJson('artifacts/translation.json').segments[0].translated_text, 'Hello and welcome back.');
});

test('overlong translations are adapted until they fit the speaking window', async () => {
  const { service, engines } = makeService();
  // A translation three times too long must trigger shorten + re-synthesis.
  engines.translation.translated = { seg_0001: `PL:${'x'.repeat(120)}` };
  const source = makeSourceVideo();
  const { job, project } = service.create({ input: { type: 'file', uri: source }, options: { target_language: 'pl' } });
  const finished = await runToCompletion(service, engines, job.id);
  assert.equal(finished.state, 'done', finished.error || '');
  const loaded = TranslateProject.load(project.dir);
  const alignment = loaded.readJson('artifacts/alignment.json');
  const adapted = alignment.lines.find(line => line.id === 'seg_0001');
  assert.ok(adapted.adaptations >= 1, 'the adaptation pass must run for an overlong line');
  assert.ok(engines.calls.includes('shorten'));
  // The line actually got shorter after the adaptation pass re-synthesized it,
  // and the fitted output stays inside the speaking window.
  assert.ok(adapted.text.length < `PL:${'x'.repeat(120)}`.length);
  assert.ok(adapted.output_duration < adapted.generated_duration, 'the fitted line must be shorter than the raw synthesis');
  assert.ok(adapted.output_duration <= adapted.target_duration * 1.21, `fitted ${adapted.output_duration}s vs window ${adapted.target_duration}s`);
  for (const line of alignment.lines) {
    assert.ok(line.rate >= 0.5 && line.rate <= 1.21, `rate ${line.rate} must stay in the gentle stretch window`);
  }
});

test('a line that cannot be shortened enough is time-stretched, never sped up unnaturally', async () => {
  const { service, engines } = makeService();
  // The adaptation pass returns the same text, so the only remaining option is
  // a gentle stretch bounded by STRETCH_MAX.
  engines.translation.shorten = async ({ text }) => ({ text });
  engines.translation.translated = { seg_0001: `PL:${'x'.repeat(400)}` };
  const source = makeSourceVideo();
  const { job, project } = service.create({ input: { type: 'file', uri: source }, options: { target_language: 'pl' } });
  const finished = await runToCompletion(service, engines, job.id);
  assert.equal(finished.state, 'done', finished.error || '');
  const alignment = TranslateProject.load(project.dir).readJson('artifacts/alignment.json');
  const line = alignment.lines.find(item => item.id === 'seg_0001');
  assert.ok(engines.calls.includes('atempo'), 'the line must be time-stretched');
  assert.ok(line.rate <= 1.21, `rate ${line.rate} must not exceed the stretch ceiling`);
  assert.equal(line.action, 'shorten');
});

test('cancelling mid-pipeline stops the job and leaves finished stages on disk', async () => {
  const { service, store, engines } = makeService();
  let jobId = null;
  engines.transcription.transcribe = async function transcribe() {
    store.cancel(jobId);
    return { language: 'en', segments: [{ id: 0, start: 0, end: 1, text: 'hello', words: [] }] };
  };
  const source = makeSourceVideo();
  const { job, project } = service.create({ input: { type: 'file', uri: source }, options: { target_language: 'pl' } });
  jobId = job.id;
  const finished = await runTranslateJob(store, jobId, { engines });
  assert.equal(finished.state, 'cancelled');
  const loaded = TranslateProject.load(project.dir);
  assert.equal(loaded.stage('import').status, 'done');
  assert.equal(loaded.stage('translate').status, 'pending');
  assert.equal(loaded.stage('render').status, 'pending');
  assert.equal(engines.calls.filter(name => name === 'render').length, 0);
});

test('capabilities and job listings are available without a running pipeline', async () => {
  const { service } = makeService();
  const source = makeSourceVideo();
  service.create({ input: { type: 'file', uri: source }, options: { target_language: 'es' } });
  const list = service.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].target_language, 'es');
  assert.equal(list[0].state, 'queued');
  assert.equal(service.list({ state: 'done' }).length, 0);
});

// ── Queue / resource safety ─────────────────────────────────────────────────

test('only one heavy translate job runs at a time', async () => {
  const { service, store } = makeService();
  const source = makeSourceVideo();
  const first = service.create({ input: { type: 'file', uri: source }, options: { target_language: 'pl' } });
  const second = service.create({ input: { type: 'file', uri: source }, options: { target_language: 'pl' } });
  assert.equal(store.governor.heavyLimit, 1);

  const lease = await store.admitAsync(first.job.id, { resourceClass: 'heavy', waitForSlotMs: 0 });
  assert.ok(lease.token);
  await assert.rejects(
    () => store.admitAsync(second.job.id, { resourceClass: 'heavy', waitForSlotMs: 0 }),
    /Resource limit reached/,
  );
  store.releaseLease(first.job.id);
  const secondLease = await store.admitAsync(second.job.id, { resourceClass: 'heavy', waitForSlotMs: 0 });
  assert.ok(secondLease.token);
  store.releaseLease(second.job.id);
});

// ── Pure helpers ────────────────────────────────────────────────────────────

test('SRT output is UTF-8 with Polish diacritics preserved', () => {
  const srt = buildSrt([
    { start: 0, end: 1.5, text: 'Zażółć gęślą jaźń' },
    { start: 61.25, end: 62.5, text: 'Zażółć\ngęślą' },
  ]);
  assert.equal(formatSrtTimestamp(61.25), '00:01:01,250');
  assert.equal(formatSrtTimestamp(3725.5), '01:02:05,500');
  const bytes = Buffer.from(srt, 'utf8');
  assert.equal(bytes.toString('utf8'), srt);
  assert.match(srt, /Zażółć gęślą jaźń/);
  assert.match(srt, /Zażółć gęślą/);
});

test('alignment planning keeps speech inside the 0.85x–1.20x window', () => {
  assert.deepEqual(planAlignment({ generatedSeconds: 2, targetSeconds: 2 }), { action: 'keep', rate: 1 });
  assert.equal(planAlignment({ generatedSeconds: 2.3, targetSeconds: 2 }).action, 'speed');
  assert.equal(planAlignment({ generatedSeconds: 4, targetSeconds: 2 }).action, 'shorten');
  assert.equal(buildAtempoChain(1.15), 'atempo=1.1500');
  assert.match(buildAtempoChain(0.4), /atempo=0\.5000/);
});

test('translation responses are parsed leniently but never invented', () => {
  const parsed = parseTranslationResponse('```json\n{"lines":[{"id":"a","text":"Ala"},{"id":"b","text":"Ola"}]}\n```', ['a', 'b', 'c']);
  assert.deepEqual(parsed, [
    { id: 'a', text: 'Ala' },
    { id: 'b', text: 'Ola' },
    { id: 'c', text: null },
  ]);
  assert.throws(() => parseTranslationResponse('no json here', ['a']), /no JSON/);
  assert.throws(() => parseTranslationResponse('{"other":1}', ['a']), /unexpected shape/);
});

test('ffprobe output and whisper model selection are mapped deterministically', () => {
  const info = parseProbeOutput(JSON.stringify({
    format: { duration: '12.5', size: '1024', format_name: 'mov,mp4,m4a' },
    streams: [
      { codec_type: 'video', width: 1920, height: 1080, avg_frame_rate: '30000/1001', codec_name: 'h264' },
      { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
    ],
  }));
  assert.equal(info.duration, 12.5);
  assert.equal(info.hasVideo, true);
  assert.equal(info.hasAudio, true);
  assert.equal(info.fps, 29.97);
  assert.equal(transcriptionModelFor('fast'), process.env.VIDMYO_TRANSLATE_ASR_MODEL_FAST || 'base');
  assert.equal(transcriptionModelFor('quality'), process.env.VIDMYO_TRANSLATE_ASR_MODEL || process.env.VIDMYO_TRANSLATE_ASR_MODEL_QUALITY || 'small');
});

test('macOS voice list parsing maps locales to language codes', () => {
  const voices = parseSayVoices([
    'Zosia               pl_PL    # Witaj, nazywam się Zosia.',
    'Samantha            en_US    # Hello, my name is Samantha.',
    'Kyoko               ja_JP    # こんにちは、京子です。',
    '',
  ].join('\n'));
  assert.equal(voices.length, 3);
  assert.equal(voices[0].language, 'pl');
  assert.equal(voices[1].language, 'en');
  assert.equal(voices[2].language, 'ja');
  assert.equal(translateLanguage('PL-PL').name, 'Polish');
});

test('subtitle burn-in is only claimed when the probe says libass is available', () => {
  // The real shape from tryProbeFfmpegCapabilities: { ok, report }.
  assert.equal(burnInSupported({ ok: true, report: { libass: true, filters: { subtitles: true } } }), true);
  assert.equal(burnInSupported({ ok: true, report: { libass: true, filters: { ass: true } } }), true);
  // Homebrew's GPL build here has no libass: honest false, and the renderer then
  // exports a separate SRT instead of failing.
  assert.equal(burnInSupported({ ok: true, report: { libass: false, filters: { subtitles: false, ass: false } } }), false);
  assert.equal(burnInSupported({ ok: true, report: { libass: true, filters: { subtitles: false, ass: false } } }), false);
  assert.equal(burnInSupported({ ok: false, code: 'FFMPEG_MISSING' }), false);
  assert.equal(burnInSupported(null), false);
  // Regression guard: a bare report (the wrong shape) must NOT be read as support.
  assert.equal(burnInSupported({ libass: true, filters: { subtitles: true } }), false);
});

test('every translate job type is isolated from other Vidmyo job types', () => {
  const { service, store } = makeService();
  store.create({ type: 'image', params: {} });
  const source = makeSourceVideo();
  const { job } = service.create({ input: { type: 'file', uri: source }, options: {} });
  assert.equal(service.list().length, 1);
  assert.equal(service.get(job.id).summary.job_id, job.id);
  assert.equal(service.get('job_does_not_exist'), null);
  assert.throws(() => service.cancel('job_does_not_exist'), /No such translate job/);
});
