// Translate Video runner — drives a `translate` job through its stage list.
//
// Design rules this file enforces:
//   - Every stage writes its own artifact and is recorded in the project
//     manifest, so a failure in a late stage never re-runs transcription.
//   - Optional stages degrade instead of failing the job: no lip-sync backend,
//     no source separation, no subtitle burn-in => a warning plus a finished
//     translated video.
//   - One heavy job at a time. The JOB holds a single heavy governor lease for
//     the whole pipeline; individual children inherit the job's AbortSignal for
//     cancellation but never re-acquire (and therefore can never release) it.
//   - Measured timings are recorded per stage and surfaced in the completion
//     report, so performance claims come from real runs.

import fs from 'node:fs';
import crypto from 'node:crypto';

import { TranslateProject, TRANSLATE_JOB_TYPE } from './translate.js';
import { planAlignment, STRETCH_MAX } from './translateEngines.js';

const SHORTEN_ATTEMPTS = 2;

function hashKey(...parts) {
  return crypto.createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}

export async function runTranslateJob(store, jobId, {
  engines,
  signal = null,
  onEvent = null,
  waitForSlotMs = 10 * 60 * 1000,
} = {}) {
  if (!engines) throw new Error('runTranslateJob requires translate engines');
  const job = store.get(jobId);
  if (!job) throw new Error(`No such job: ${jobId}`);
  if (job.type !== TRANSLATE_JOB_TYPE) throw new Error(`Job ${jobId} is not a translate job`);
  const project = TranslateProject.load(job.params.projectDir);

  const emit = payload => {
    if (typeof onEvent !== 'function') return;
    try { onEvent({ job_id: jobId, ...payload }); } catch { /* observers must not break the run */ }
  };
  const log = message => { store.log(jobId, message); emit({ event: 'log', message: String(message) }); };

  // ── Admission (heavy, concurrency 1) ──────────────────────────────────────
  if (store.governor && !store.get(jobId).checkpoints?.leaseToken) {
    try {
      await store.admitAsync(jobId, { resourceClass: 'heavy', waitForSlotMs });
    } catch (error) {
      store.setState(jobId, 'error', { error: `Governor admission denied: ${error.message}`, admit: false });
      emit({ event: 'error', error: error.message });
      return store.get(jobId);
    }
  }
  if (store.get(jobId).state === 'queued') {
    store.setState(jobId, 'running', { admit: false });
  }
  if (store.get(jobId).state !== 'running') {
    emit({ event: 'error', error: store.get(jobId).error || 'job could not start' });
    return store.get(jobId);
  }

  const context = {
    jobId,
    project,
    options: project.manifest.options,
    media: null,
    audio: null,
    transcription: null,
    translation: null,
    synthesized: null,
    alignment: null,
    background: null,
    speech: null,
    mix: null,
    subtitles: null,
    render: null,
    log,
    signal,
    warn: message => { const text = project.warn(message); emit({ event: 'warning', message: text }); return text; },
    runId: jobId,
  };

  const timings = {};
  const cancelled = () => store.get(jobId)?.state === 'cancelled';

  try {
    // Hydrate already-finished stages so a resume never redoes work.
    hydrate(context);

    let stage = project.nextStage();
    while (stage) {
      if (cancelled() || signal?.aborted) {
        log('cancelled');
        emit({ event: 'cancelled', stage });
        return store.get(jobId);
      }
      project.setRunning(stage);
      store.checkpoint(jobId, 'stage', stage);
      emit({ event: 'stage', stage, status: 'running', progress: project.progress() });

      const startedAt = Date.now();
      let result;
      try {
        result = await runStage(stage, context, engines);
      } catch (error) {
        if (cancelled() || signal?.aborted) {
          emit({ event: 'cancelled', stage });
          return store.get(jobId);
        }
        timings[stage] = Date.now() - startedAt;
        if (isDegradable(stage)) {
          // An optional stage must never throw away finished work.
          project.setSkipped(stage, error.message);
          project.warn(`${stage} was skipped: ${error.message}`);
          log(`${stage} skipped: ${error.message}`);
          emit({ event: 'stage', stage, status: 'skipped', error: error.message, progress: project.progress() });
          stage = project.nextStage();
          continue;
        }
        project.setFailed(stage, error);
        store.setState(jobId, 'error', { error: `${stage}: ${error.message}` });
        store.checkpoint(jobId, 'metrics', { stages: timings, totalMs: Object.values(timings).reduce((a, b) => a + b, 0) });
        log(`${stage} failed: ${error.message}`);
        emit({ event: 'error', stage, error: error.message, progress: project.progress() });
        return store.get(jobId);
      }

      timings[stage] = Date.now() - startedAt;
      applyResult(stage, context, result);
      project.setDone(stage, { artifact: artifactOf(stage, result, context), metrics: { durationMs: timings[stage] } });
      store.checkpoint(jobId, 'progress', project.progress());
      emit({
        event: 'stage', stage, status: 'done', progress: project.progress(),
        duration_ms: timings[stage],
      });
      stage = project.nextStage();
    }

    // ── Finalize ────────────────────────────────────────────────────────────
    const outputs = context.validate?.outputs || project.manifest.outputs;
    for (const output of outputs) {
      const file = project.artifactPath(output.artifact);
      if (fs.existsSync(file)) {
        store.addArtifact(jobId, { path: file, kind: output.kind || 'file' });
      }
    }
    const metrics = {
      stages: timings,
      totalMs: Object.values(timings).reduce((a, b) => a + b, 0),
      sourceDurationSeconds: context.media?.duration ?? null,
      outputs: outputs.map(output => ({ artifact: output.artifact, bytes: output.bytes ?? null })),
    };
    store.checkpoint(jobId, 'metrics', metrics);
    store.checkpoint(jobId, 'progress', 100);
    store.checkpoint(jobId, 'outputs', outputs);
    store.setState(jobId, 'done');
    log(`translation complete (${(metrics.totalMs / 1000).toFixed(1)}s)`);
    emit({ event: 'done', progress: 100, metrics });
    return store.get(jobId);
  } finally {
    if (store.governor) store.releaseLease(jobId);
  }
}

function isDegradable(stage) {
  return stage === 'lipsync' || stage === 'mix' || stage === 'subtitles';
}

function artifactOf(stage, result, context) {
  if (!result) return null;
  if (result.artifact) return result.artifact;
  if (result.outputs?.[0]?.artifact) return result.outputs[0].artifact;
  if (stage === 'import') return context.media?.artifact || null;
  if (stage === 'analyze') return 'artifacts/media-info.json';
  if (stage === 'extract_audio') return 'artifacts/source.asr.wav';
  if (stage === 'transcribe') return 'artifacts/transcript.json';
  if (stage === 'translate') return 'artifacts/translation.json';
  if (stage === 'synthesize') return 'artifacts/voice/index.json';
  if (stage === 'align') return 'artifacts/alignment.json';
  return null;
}

// ── Stage implementations ───────────────────────────────────────────────────

async function runStage(stage, ctx, engines) {
  switch (stage) {
    case 'import': return stageImport(ctx, engines);
    case 'analyze': return stageAnalyze(ctx, engines);
    case 'extract_audio': return stageExtractAudio(ctx, engines);
    case 'transcribe': return stageTranscribe(ctx, engines);
    case 'translate': return stageTranslate(ctx, engines);
    case 'synthesize': return stageSynthesize(ctx, engines);
    case 'align': return stageAlign(ctx, engines);
    case 'mix': return stageMix(ctx, engines);
    case 'subtitles': return stageSubtitles(ctx, engines);
    case 'lipsync': return stageLipsync(ctx, engines);
    case 'render': return stageRender(ctx, engines);
    case 'validate': return stageValidate(ctx, engines);
    default: throw new Error(`Unknown translate stage: ${stage}`);
  }
}

async function stageImport(ctx, engines) {
  const { project } = ctx;
  if (project.has('artifacts/media.json')) {
    const cached = project.readJson('artifacts/media.json');
    if (cached?.artifact && project.has(cached.artifact)) return cached;
  }
  const result = await engines.source.import({
    project,
    input: project.manifest.input,
    signal: ctx.signal,
    log: ctx.log,
  });
  const media = { ...result, detectedAt: new Date().toISOString() };
  project.writeJson('artifacts/media.json', media);
  return media;
}

async function stageAnalyze(ctx, engines) {
  const { project, media } = ctx;
  if (project.has('artifacts/media-info.json')) return project.readJson('artifacts/media-info.json');
  const info = await engines.probe(project.artifactPath(media.artifact), ctx.signal);
  if (!info.hasVideo) throw new Error('That file has no video stream.');
  if (!info.hasAudio) throw new Error('That video has no audio track, so there is nothing to translate. Add a subtitle-only mode for silent video.');
  project.writeJson('artifacts/media-info.json', info);
  return info;
}

async function stageExtractAudio(ctx, engines) {
  const { project } = ctx;
  if (project.has('artifacts/source.asr.wav') && project.has('artifacts/source.audio.wav')) {
    return { asr: 'artifacts/source.asr.wav', background: 'artifacts/source.audio.wav' };
  }
  return engines.audio.extract({ project, media: ctx.media, signal: ctx.signal, log: ctx.log });
}

async function stageTranscribe(ctx, engines) {
  const { project, options } = ctx;
  if (project.has('artifacts/transcript.json')) {
    const cached = project.readJson('artifacts/transcript.json');
    if (Array.isArray(cached?.segments) && cached.segments.length) return cached;
  }
  const transcript = await engines.transcription.transcribe({
    project, audio: ctx.audio, options, signal: ctx.signal, log: ctx.log,
  });
  const segments = (transcript.segments || [])
    .map((segment, index) => ({
      id: `seg_${String(index + 1).padStart(4, '0')}`,
      start: Number(segment.start) || 0,
      end: Number(segment.end) || 0,
      text: String(segment.text || '').trim(),
      words: Array.isArray(segment.words) ? segment.words : [],
    }))
    .filter(segment => segment.text && segment.end > segment.start);
  if (!segments.length) throw new Error('No speech was detected in this video.');
  const result = {
    language: String(transcript.language || options.source_language || '').toLowerCase().split(/[-_]/)[0] || null,
    languageProbability: transcript.languageProbability ?? transcript.language_probability ?? null,
    duration: transcript.duration || ctx.media?.duration || null,
    model: engines.transcription.model || null,
    segments,
  };
  project.writeJson('artifacts/transcript.json', result);
  project.manifest.language = { source: result.language };
  project.save();
  return result;
}

async function stageTranslate(ctx, engines) {
  const { project, options, transcription } = ctx;
  if (project.has('artifacts/translation.json')) {
    const cached = project.readJson('artifacts/translation.json');
    if (Array.isArray(cached?.segments) && cached.segments.length) return cached;
  }
  const sourceLanguage = options.source_language === 'auto' ? transcription.language : options.source_language;
  const sameLanguage = sourceLanguage && sourceLanguage === options.target_language;

  let lines;
  if (sameLanguage) {
    ctx.warn(`Source and target language are both ${options.target_language}; the transcript is used unchanged.`);
    lines = transcription.segments.map(segment => ({ id: segment.id, text: segment.text }));
  } else {
    lines = await engines.translation.translate({
      segments: transcription.segments,
      options: { ...options, source_language: sourceLanguage },
      sourceLanguage,
      signal: ctx.signal,
      log: ctx.log,
    });
  }
  const byId = new Map(lines.map(line => [String(line.id), line.text]));
  const segments = transcription.segments.map(segment => {
    const translated = byId.get(segment.id);
    return {
      id: segment.id,
      start: segment.start,
      end: segment.end,
      target_duration: Number((segment.end - segment.start).toFixed(3)),
      source_text: segment.text,
      translated_text: (translated && translated.trim()) ? translated.trim() : segment.text,
      adapted: false,
    };
  });
  const missing = segments.filter(segment => segment.translated_text === segment.source_text).length;
  if (missing && !sameLanguage) ctx.warn(`${missing} line(s) kept the source text because the translation engine returned no replacement.`);
  const result = {
    source_language: sourceLanguage || null,
    target_language: options.target_language,
    engine: engines.translation.id,
    model: engines.translation.model || null,
    segments,
  };
  project.writeJson('artifacts/translation.json', result);
  return result;
}

async function stageSynthesize(ctx, engines) {
  const { project, options, translation } = ctx;
  const cacheDir = 'artifacts/voice';
  fs.mkdirSync(project.artifactPath(cacheDir), { recursive: true });
  const index = [];
  const availability = typeof engines.voice.availability === 'function' ? await engines.voice.availability() : { available: true };
  if (!availability.available) throw new Error(availability.error || 'No local voice engine is available.');

  for (const segment of translation.segments) {
    ctx.signal?.throwIfAborted();
    const voiceId = options.voice_id || 'standard';
    const key = hashKey(segment.translated_text, voiceId, options.target_language, options.quality);
    const relative = `${cacheDir}/${segment.id}.${key}.wav`;
    const file = project.artifactPath(relative);
    if (!(fs.existsSync(file) && fs.statSync(file).size > 44)) {
      await engines.voice.synthesize({
        text: segment.translated_text,
        language: options.target_language,
        voiceId: options.voice_id,
        cloneVoice: options.clone_voice,
        outFile: file,
        signal: ctx.signal,
        run: engines.run,
        ffmpegPath: engines.ffmpegPath,
        warn: ctx.warn,
      });
    }
    const info = await engines.probe(file, ctx.signal);
    index.push({
      id: segment.id,
      file: relative,
      text: segment.translated_text,
      generated_duration: Number((info.duration || 0).toFixed(3)),
      voice: voiceId,
    });
    ctx.log(`voice ${index.length}/${translation.segments.length}`);
  }
  const result = {
    engine: options.voice_id && availability.clone_available ? 'voicebox' : 'local-standard',
    cloned: Boolean(options.clone_voice && options.voice_id && availability.clone_available),
    clone_unavailable_reason: options.clone_voice && options.voice_id && !availability.clone_available
      ? (availability.clone_error || 'voice cloning provider unavailable')
      : null,
    lines: index,
  };
  project.writeJson('artifacts/voice/index.json', result);
  return result;
}

async function stageAlign(ctx, engines) {
  const { project, options, translation, synthesized } = ctx;
  if (project.has('artifacts/alignment.json')) {
    const cached = project.readJson('artifacts/alignment.json');
    if (Array.isArray(cached?.lines) && cached.lines.length) return cached;
  }
  fs.mkdirSync(project.artifactPath('artifacts/voice/fitted'), { recursive: true });
  const byId = new Map(synthesized.lines.map(line => [line.id, line]));
  const lines = [];

  for (const segment of translation.segments) {
    ctx.signal?.throwIfAborted();
    const entry = byId.get(segment.id);
    if (!entry) throw new Error(`No synthesized audio for ${segment.id}.`);
    const target = Math.max(segment.target_duration, 0.3);
    let text = segment.translated_text;
    let generated = Math.max(entry.generated_duration, 0.05);
    let plan = planAlignment({ generatedSeconds: generated, targetSeconds: target });
    let attempts = 0;

    while (plan.action === 'shorten' && attempts < SHORTEN_ATTEMPTS) {
      attempts += 1;
      let shortened;
      try {
        shortened = await engines.translation.shorten({
          text, sourceText: segment.source_text, targetLanguage: options.target_language,
          maxSeconds: target, signal: ctx.signal,
        });
      } catch (error) {
        ctx.warn(`Could not shorten line ${segment.id} (${error.message}); the line keeps its stretch.`);
        break;
      }
      if (!shortened?.text || shortened.text === text) break;
      text = shortened.text;
      ctx.log(`adapting ${segment.id} to fit ${target.toFixed(2)}s (attempt ${attempts})`);
      const file = project.artifactPath(entry.file);
      await engines.voice.synthesize({
        text, language: options.target_language, voiceId: options.voice_id,
        cloneVoice: options.clone_voice, outFile: file, signal: ctx.signal,
        run: engines.run, ffmpegPath: engines.ffmpegPath, warn: ctx.warn,
      });
      const info = await engines.probe(file, ctx.signal);
      generated = Number((info.duration || generated).toFixed(3));
      plan = planAlignment({ generatedSeconds: generated, targetSeconds: target });
    }

    const fittedRelative = `artifacts/voice/fitted/${segment.id}.wav`;
    const source = project.artifactPath(entry.file);
    const fitted = project.artifactPath(fittedRelative);
    let rate = 1;
    if (plan.action === 'speed' || (plan.action === 'shorten' && generated / target > 1.01)) {
      rate = Math.min(Math.max(generated / target, 0.5), STRETCH_MAX);
      if (rate > 1.02 || rate < 0.98) {
        await engines.mixer.ffmpegAtempo({ input: source, output: fitted, rate, signal: ctx.signal });
      } else {
        fs.copyFileSync(source, fitted);
        rate = 1;
      }
    } else {
      fs.copyFileSync(source, fitted);
    }
    const fittedInfo = await engines.probe(fitted, ctx.signal);
    if (generated / target > STRETCH_MAX + 0.05) {
      ctx.warn(`Line ${segment.id} is longer than its speaking window even after adaptation; transcribed speech may overlap the next line.`);
    }
    lines.push({
      id: segment.id,
      start: Number(segment.start.toFixed(3)),
      end: Number(segment.end.toFixed(3)),
      target_duration: Number(target.toFixed(3)),
      generated_duration: Number(generated.toFixed(3)),
      output_duration: Number((fittedInfo.duration || generated).toFixed(3)),
      action: plan.action,
      adaptations: attempts,
      rate: Number(rate.toFixed(4)),
      text,
      file: fittedRelative,
    });
  }
  const result = { engine: 'ffmpeg-atempo', lines };
  project.writeJson('artifacts/alignment.json', result);
  return result;
}

async function stageMix(ctx, engines) {
  const { project, options } = ctx;
  let background = { mode: options.background_mode || 'duck', separated: false };
  if (background.mode === 'separate') {
    const separationStatus = typeof engines.separation?.availability === 'function'
      ? await engines.separation.availability()
      : { available: Boolean(engines.separation?.available) };
    if (separationStatus.available) {
      try {
        const separated = await engines.separation.separate({
          project, signal: ctx.signal, log: ctx.log,
        });
        background = { mode: 'separate', separated: true, ...separated };
      } catch (error) {
        // Source separation must never destroy a translation job.
        ctx.warn(`Source separation failed (${error.message}); falling back to ducking the original audio.`);
        background = { mode: 'duck', separated: false };
      }
    } else {
      ctx.warn('Source separation is not available in this build; the original audio is ducked under the translated voice.');
      background = { mode: 'duck', separated: false };
    }
  }
  ctx.background = background;
  const speech = options.translate_audio
    ? await engines.mixer.buildSpeechTrack({
      project, alignment: ctx.alignment, media: ctx.media, signal: ctx.signal, log: ctx.log,
    })
    : null;
  const mixed = await engines.mixer.mix({
    project, options, background, speech, signal: ctx.signal, log: ctx.log,
  });
  const result = {
    mode: mixed.info?.mode || background.mode,
    speech: speech?.artifact || null,
    artifact: mixed.artifact,
    warnings: mixed.info?.warnings || [],
  };
  for (const warning of result.warnings) ctx.warn(warning);
  project.writeJson('artifacts/audio_mix.json', result);
  return result;
}

async function stageSubtitles(ctx, engines) {
  const { project } = ctx;
  const result = engines.subtitles.write({ project, options: ctx.options, transcription: ctx.transcription, translation: ctx.translation });
  project.writeJson('artifacts/subtitles.json', result);
  return result;
}

async function stageLipsync(ctx, engines) {
  if (!engines.lipsync?.available) {
    throw new Error('No local lip-sync backend is configured; the translated video is produced without lip sync.');
  }
  const result = await engines.lipsync.apply({
    project, media: ctx.media, mix: ctx.mix, alignment: ctx.alignment, signal: ctx.signal,
  });
  return result;
}

async function stageRender(ctx, engines) {
  const { project } = ctx;
  const result = await engines.render.render({
    project, options: ctx.options, media: ctx.media,
    mix: ctx.mix, subtitles: ctx.subtitles, signal: ctx.signal, log: ctx.log,
  });
  for (const warning of result.warnings || []) ctx.warn(warning);
  return result;
}

async function stageValidate(ctx, engines) {
  const { project, media } = ctx;
  const rendered = ctx.render.artifact;
  const info = await engines.probe(project.artifactPath(rendered), ctx.signal);
  const issues = [];
  if (!info.hasVideo) issues.push('the output has no video stream');
  if (!info.hasAudio) issues.push('the output has no audio stream');
  const drift = info.duration && media.duration ? Math.abs(info.duration - media.duration) : 0;
  if (media.duration && drift > Math.max(1.5, media.duration * 0.05)) {
    issues.push(`output duration ${info.duration.toFixed(2)}s differs from the source ${media.duration.toFixed(2)}s`);
  }
  for (const issue of issues) ctx.warn(issue);

  const outputs = [];
  const add = (artifact, kind, extra = {}) => {
    try {
      const file = project.artifactPath(artifact);
      if (!fs.existsSync(file)) return;
      outputs.push({ artifact, kind, bytes: fs.statSync(file).size, ...extra });
    } catch { /* artifact outside the project */ }
  };
  add(rendered, 'translated_video', { language: ctx.options.target_language });
  const subtitle = ctx.subtitles?.outputs?.find(item => item.language === ctx.options.target_language)?.artifact;
  if (subtitle) add(subtitle, 'translated_subtitles', { language: ctx.options.target_language });
  for (const item of ctx.subtitles?.outputs || []) {
    if (item.artifact !== subtitle) add(item.artifact, item.kind, { language: item.language });
  }
  add('artifacts/transcript.json', 'source_transcript');
  add('artifacts/translation.json', 'translation');
  if (ctx.mix?.speech) add(ctx.mix.speech, 'translated_audio');
  add('artifacts/source.audio.wav', 'source_audio');
  add('artifacts/alignment.json', 'alignment');

  const report = {
    contract_version: project.manifest.contract_version,
    job_id: ctx.jobId,
    generated_at: new Date().toISOString(),
    source: project.manifest.input,
    language: {
      source: ctx.translation.source_language || ctx.transcription.language || null,
      target: ctx.options.target_language,
      detected_by: engines.transcription.id,
    },
    engines: {
      transcription: { id: engines.transcription.id, model: ctx.transcription.model || engines.transcription.model || null },
      translation: { id: engines.translation.id, model: engines.translation.model || null },
      voice: ctx.synthesized?.engine || null,
      cloned: Boolean(ctx.synthesized?.cloned),
      mix: ctx.mix?.mode || null,
      renderer: engines.render.id,
    },
    media: { source: info, info },
    outputs,
    warnings: project.manifest.warnings,
    issues,
  };
  project.writeJson('artifacts/processing_report.json', report);
  add('artifacts/processing_report.json', 'processing_report');
  // A silent video of pure audio would be a real failure; duration drift is a warning.
  if (!info.hasVideo || !info.hasAudio) throw new Error(`Output validation failed: ${issues.join('; ')}`);
  project.manifest.outputs = outputs;
  project.save();
  return { ...report, outputs };
}

/** Re-read finished stages from disk so a resumed job continues where it stopped. */
function hydrate(ctx) {
  const { project } = ctx;
  const read = (relative) => {
    try { return project.has(relative) ? project.readJson(relative) : null; } catch { return null; }
  };
  ctx.media = read('artifacts/media.json');
  ctx.mediaInfo = read('artifacts/media-info.json');
  if (ctx.media && ctx.mediaInfo) ctx.media = { ...ctx.media, ...ctx.mediaInfo };
  const status = id => project.manifest.stages.find(entry => entry.id === id)?.status;
  if (status('extract_audio') === 'done') {
    ctx.audio = { asr: 'artifacts/source.asr.wav', background: 'artifacts/source.audio.wav' };
  }
  if (status('transcribe') === 'done') ctx.transcription = read('artifacts/transcript.json');
  if (status('translate') === 'done') ctx.translation = read('artifacts/translation.json');
  if (status('synthesize') === 'done') ctx.synthesized = read('artifacts/voice/index.json');
  if (status('align') === 'done') ctx.alignment = read('artifacts/alignment.json');
  if (status('mix') === 'done') {
    ctx.mix = read('artifacts/audio_mix.json');
    ctx.background = { mode: ctx.mix?.mode || 'duck', separated: ctx.mix?.mode === 'separate' };
    if (ctx.mix?.speech) ctx.speech = { artifact: ctx.mix.speech };
  }
  if (status('subtitles') === 'done') ctx.subtitles = read('artifacts/subtitles.json');
  if (status('render') === 'done') {
    const file = `artifacts/video.${project.manifest.options.target_language}.mp4`;
    if (project.has(file)) ctx.render = { artifact: file };
  }
}

/** Attach a stage result to the shared context for later stages. */
function applyResult(stage, ctx, result) {
  switch (stage) {
    case 'import': ctx.media = { ...ctx.media, ...result }; break;
    case 'analyze': ctx.mediaInfo = result; ctx.media = { ...ctx.media, ...result }; break;
    case 'extract_audio': ctx.audio = result; break;
    case 'transcribe': ctx.transcription = result; break;
    case 'translate': ctx.translation = result; break;
    case 'synthesize': ctx.synthesized = result; break;
    case 'align': ctx.alignment = result; break;
    case 'mix': ctx.mix = result; break;
    case 'subtitles': ctx.subtitles = result; break;
    case 'lipsync': ctx.lipsync = result; break;
    case 'render': ctx.render = result; break;
    case 'validate': ctx.validate = result; break;
    default: break;
  }
}

/** Register an already-created translate job for resumption (crash recovery). */
export function resumeTranslateJob(store, jobId) {
  const job = store.get(jobId);
  if (!job || job.type !== TRANSLATE_JOB_TYPE) throw new Error(`No such translate job: ${jobId}`);
  if (!TranslateProject.exists(job.params?.projectDir)) throw new Error('The translate project for that job is missing.');
  if (job.state === 'error') {
    const project = TranslateProject.load(job.params.projectDir);
    return { job, project, nextStage: project.nextStage(), resumable: Boolean(project.nextStage()) };
  }
  return { job, project: TranslateProject.load(job.params.projectDir), nextStage: project.nextStage(), resumable: false };
}
