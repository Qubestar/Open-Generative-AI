// Translate Video — presentation logic for the desktop tab.
//
// Everything here is pure: no DOM, no Electron, no network. It is what
// `TranslateStudio.jsx` renders and what the studio tests assert, which keeps the
// component a thin shell over testable rules.

export const STAGE_ORDER = [
  'import', 'analyze', 'extract_audio', 'transcribe', 'translate',
  'synthesize', 'align', 'mix', 'subtitles', 'lipsync', 'render', 'validate',
];

export const STAGE_LABELS = {
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

export const QUALITY_CHOICES = [
  { id: 'fast', label: 'Fast', detail: 'Smaller transcription model, quicker first result.' },
  { id: 'quality', label: 'Quality', detail: 'Better transcription and translation fidelity.' },
];

export const BACKGROUND_CHOICES = [
  { id: 'duck', label: 'Duck the original', detail: 'Keeps music, ambience and effects; the original voice drops under the dub.' },
  { id: 'separate', label: 'Remove the original voice', detail: 'Local source separation (Demucs). Slower, but the source speech is gone rather than turned down.' },
  { id: 'keep', label: 'Keep everything', detail: 'Original audio at full level underneath the dub.' },
  { id: 'replace', label: 'Replace the audio', detail: 'Translated voice only — no music or ambience.' },
];

export const CONSENT_NOTICE = 'Use voice cloning only with permission from the speaker.';

/** The state the tab starts in. Polish is the default target. */
export function defaultTranslateForm() {
  return {
    url: '',
    inputPath: null,
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
    voice_id: null,
  };
}

/**
 * The background mode to start a job with, given what this machine can do.
 * Ducking is dependency-free and preserves music exactly, but on a speech-heavy
 * source it only lowers the original voice. When local source separation is
 * available it removes the source voice instead, which is what a viewer hears as
 * "translated"; the UI starts there and still lets the user pick ducking.
 */
export function preferredBackgroundMode(capabilities) {
  if (capabilities?.modes?.source_separation) return 'separate';
  return 'duck';
}

export function languageOptions(capabilities, kind) {
  const list = (kind === 'source' ? capabilities?.source_languages : capabilities?.target_languages) || [];
  const options = list.map(item => ({ value: item.code, label: item.name, native: item.native }));
  if (kind === 'source' && !options.some(option => option.value === 'auto')) {
    options.unshift({ value: 'auto', label: 'Auto detect', native: null });
  }
  return options;
}

export function isUrlLike(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

/**
 * Validate the form before the backend is asked to do anything. Returns the
 * first blocking problem as a human sentence, or null.
 */
export function translateFormError(form, capabilities = null) {
  const url = String(form?.url || '').trim();
  const hasFile = Boolean(form?.inputPath);
  if (!url && !hasFile) return 'Paste a video link or choose a video file first.';
  if (url && hasFile) return 'Use either a video link or a local file, not both.';
  if (url && !isUrlLike(url)) return 'That does not look like an http(s) video link.';
  if (url && !hasFile) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return 'Only http and https video links can be imported.';
    } catch {
      return 'That does not look like a valid video link.';
    }
  }
  if (!form?.target_language) return 'Choose a target language.';
  if (form.source_language !== 'auto' && form.source_language === form.target_language) {
    return 'Source and target language must differ, or set the source language to auto-detect.';
  }
  const targets = capabilities?.target_languages?.map(item => item.code);
  if (targets && targets.length && !targets.includes(form.target_language)) {
    return `The active translation engine cannot translate into ${form.target_language}.`;
  }
  if (form.translate_audio) {
    const voiceLanguages = capabilities?.voice_languages?.map(item => item.code);
    if (voiceLanguages && voiceLanguages.length && !voiceLanguages.includes(form.target_language)) {
      return `No local voice is available for ${form.target_language}. Turn off "Translate speech" to produce subtitles only.`;
    }
  }
  return null;
}

/** Build the backend payload from the form. URL wins only when no file is set. */
export function translateInputFromForm(form) {
  const url = String(form?.url || '').trim();
  if (form?.inputPath) return { type: 'file', uri: form.inputPath };
  if (url) return { type: 'url', uri: url };
  return null;
}

export function translateOptionsFromForm(form) {
  const options = {
    source_language: form.source_language,
    target_language: form.target_language,
    translate_audio: form.translate_audio,
    clone_voice: form.clone_voice && Boolean(form.voice_id),
    preserve_background: form.background_mode !== 'replace',
    background_mode: form.background_mode,
    subtitles: form.subtitles,
    burn_subtitles: form.burn_subtitles,
    lip_sync: form.lip_sync,
    quality: form.quality,
  };
  if (form.voice_id) options.voice_id = form.voice_id;
  return options;
}

/**
 * Non-blocking warnings shown next to the options — most importantly the
 * "translation works but this voice does not" case, which must never be a
 * silent downgrade.
 */
export function translateOptionWarnings(form, capabilities) {
  const warnings = [];
  if (!capabilities) return warnings;
  const cloneLanguages = capabilities.voice_clone_languages?.map(item => item.code) || [];
  const voice = capabilities.engines?.voice;
  if (form.clone_voice) {
    if (voice && voice.available === false) {
      warnings.push(`${voice.unavailable_reason || 'The voice engine is unavailable.'} The standard local voice will be used instead.`);
    } else if (!cloneLanguages.length) {
      warnings.push('Voice cloning is not available in this build; the standard local voice will be used.');
    } else if (!cloneLanguages.includes(form.target_language)) {
      warnings.push(`Voice cloning does not support ${form.target_language} yet; the standard local voice will be used.`);
    } else if (!form.voice_id) {
      warnings.push('Choose a voice profile to clone; without one the standard local voice is used.');
    }
  }
  if (!capabilities.modes?.source_separation && form.background_mode === 'separate') {
    warnings.push('Source separation is not installed; the original audio will be ducked instead.');
  }
  if (form.lip_sync && !capabilities.modes?.lip_sync) {
    warnings.push('Lip sync is experimental and no local backend is configured; the job will finish without it.');
  }
  if (form.burn_subtitles && capabilities.modes?.burn_subtitles === false) {
    warnings.push('This FFmpeg build cannot burn subtitles in; a separate SRT file is produced instead.');
  }
  return warnings;
}

/** Translate one backend job summary into the checklist the panel renders. */
export function stageChecklist(job) {
  if (!job?.stages?.length) {
    return STAGE_ORDER.map(id => ({ id, label: STAGE_LABELS[id], status: 'pending', glyph: '○' }));
  }
  return job.stages.map(entry => ({
    id: entry.id,
    label: entry.label || STAGE_LABELS[entry.id] || entry.id,
    status: entry.status,
    error: entry.error || null,
    glyph: entry.status === 'done' ? '✓'
      : entry.status === 'running' ? '→'
        : entry.status === 'failed' ? '✕'
          : entry.status === 'skipped' ? '–' : '○',
  }));
}

export function jobPhase(job) {
  if (!job) return 'idle';
  if (job.state === 'done') return 'complete';
  if (job.state === 'error') return 'failed';
  if (job.state === 'cancelled') return 'cancelled';
  return 'running';
}

export function progressPercent(job) {
  if (!job) return 0;
  if (job.state === 'done') return 100;
  return Math.max(0, Math.min(100, Number(job.progress) || 0));
}

export function languagePairLabel(job) {
  const target = (job?.target_language || '').toUpperCase();
  const source = job?.source_language ? String(job.source_language).toUpperCase() : 'AUTO';
  if (!target) return '';
  return `${source} → ${target}`;
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '';
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

export function outputLabel(output) {
  const names = {
    translated_video: 'Translated video',
    translated_subtitles: 'Translated subtitles',
    source_subtitles: 'Source subtitles',
    source_transcript: 'Source transcript',
    translation: 'Translation',
    translated_audio: 'Translated audio',
    source_audio: 'Extracted source audio',
    alignment: 'Timing plan',
    processing_report: 'Processing report',
  };
  return names[output?.kind] || output?.kind || 'Output';
}

export function jobTitle(job) {
  if (!job) return 'Translation';
  const input = job.input || {};
  const label = input.label || input.uri || 'video';
  return String(label).replace(/^.*[\\/]/, '').slice(0, 60);
}

export function historyRow(job) {
  return {
    id: job.job_id,
    title: jobTitle(job),
    pair: languagePairLabel(job),
    state: job.state,
    progress: progressPercent(job),
    created_at: job.created_at,
    error: job.error || null,
    retryable: Boolean(job.retryable),
  };
}

export function mediaKindFor(relativePath) {
  const value = String(relativePath || '').toLowerCase();
  if (value.endsWith('.mp4') || value.endsWith('.mov') || value.endsWith('.webm') || value.endsWith('.mkv')) return 'video/mp4';
  if (value.endsWith('.srt')) return 'text/plain';
  if (value.endsWith('.json')) return 'application/json';
  if (value.endsWith('.wav')) return 'audio/wav';
  return 'application/octet-stream';
}
