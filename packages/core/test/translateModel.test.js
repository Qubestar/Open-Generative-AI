// Translate Video tab — presentation rules.
// Pure module: asserts the checks the panel relies on before it lets a user (or
// an agent through the same options) start an expensive local job.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKGROUND_CHOICES, CONSENT_NOTICE, STAGE_LABELS, defaultTranslateForm, formatBytes,
  formatDuration, historyRow, jobPhase, jobTitle, languageOptions, languagePairLabel,
  outputLabel, preferredBackgroundMode, progressPercent, stageChecklist, translateFormError,
  translateInputFromForm, translateOptionWarnings, translateOptionsFromForm,
} from '../../studio/src/translateModel.mjs';

const CAPABILITIES = {
  source_languages: [{ code: 'auto', name: 'Auto detect' }, { code: 'en', name: 'English' }, { code: 'pl', name: 'Polish' }],
  target_languages: [{ code: 'pl', name: 'Polish' }, { code: 'es', name: 'Spanish' }],
  voice_languages: [{ code: 'pl', name: 'Polish' }, { code: 'es', name: 'Spanish' }],
  voice_clone_languages: [{ code: 'pl', name: 'Polish' }],
  modes: { audio: true, subtitles: true, burn_subtitles: true, source_separation: true, lip_sync: false },
  engines: { voice: { id: 'translate-voice', available: true, supports_clone: true } },
};

test('the default form targets Polish from an auto-detected source', () => {
  const form = defaultTranslateForm();
  assert.equal(form.source_language, 'auto');
  assert.equal(form.target_language, 'pl');
  assert.equal(form.translate_audio, true);
  assert.equal(form.clone_voice, true);
  assert.equal(form.background_mode, 'duck');
  assert.equal(form.burn_subtitles, false);
  assert.equal(form.lip_sync, false);
});

test('input validation catches every blocking case before a job is created', () => {
  const base = defaultTranslateForm();
  assert.match(translateFormError(base, CAPABILITIES), /Paste a video link or choose a video file/);
  assert.match(translateFormError({ ...base, url: 'not a url' }, CAPABILITIES), /look like an http/);
  assert.match(translateFormError({ ...base, url: 'ftp://host/v.mp4' }, CAPABILITIES), /http/);
  assert.match(translateFormError({ ...base, url: 'https://x/v.mp4', inputPath: '/tmp/a.mp4' }, CAPABILITIES), /not both/);
  assert.match(translateFormError({ ...base, url: 'https://x/v.mp4', source_language: 'pl', target_language: 'pl' }, CAPABILITIES), /must differ/);
  assert.match(translateFormError({ ...base, url: 'https://x/v.mp4', target_language: 'de' }, CAPABILITIES), /cannot translate into de/);
  assert.match(translateFormError({ ...base, url: 'https://x/v.mp4', target_language: 'de', translate_audio: false }, CAPABILITIES), /cannot translate into de/);
  assert.equal(translateFormError({ ...base, url: 'https://x/v.mp4' }, CAPABILITIES), null);
  assert.equal(translateFormError({ ...base, inputPath: '/tmp/a.mp4' }, CAPABILITIES), null);
});

test('a target with no local voice is blocked only when speech is translated', () => {
  const caps = { ...CAPABILITIES, voice_languages: [{ code: 'pl', name: 'Polish' }] };
  const form = { ...defaultTranslateForm(), url: 'https://x/v.mp4', target_language: 'es' };
  assert.match(translateFormError(form, caps), /No local voice is available for es/);
  assert.equal(translateFormError({ ...form, translate_audio: false }, caps), null);
});

test('the form becomes the canonical input + options payload', () => {
  const form = { ...defaultTranslateForm(), url: 'https://youtu.be/abc', voice_id: 'voice42', quality: 'fast' };
  assert.deepEqual(translateInputFromForm(form), { type: 'url', uri: 'https://youtu.be/abc' });
  assert.deepEqual(translateInputFromForm({ ...form, inputPath: '/Users/me/clip.mov' }), { type: 'file', uri: '/Users/me/clip.mov' });

  const options = translateOptionsFromForm(form);
  assert.equal(options.clone_voice, true);
  assert.equal(options.voice_id, 'voice42');
  assert.equal(options.preserve_background, true);
  assert.equal(options.quality, 'fast');

  // Cloning is only requested when a profile was chosen, so the backend never
  // claims to clone without a reference.
  assert.equal(translateOptionsFromForm({ ...form, voice_id: null }).clone_voice, false);
  // Replace mode means the background is deliberately not preserved.
  const replaced = translateOptionsFromForm({ ...form, background_mode: 'replace' });
  assert.equal(replaced.preserve_background, false);
  assert.equal(replaced.background_mode, 'replace');
  assert.equal(translateOptionsFromForm({ ...form, translate_audio: false }).translate_audio, false);
});

test('option warnings explain fallbacks without blocking the job', () => {
  const form = { ...defaultTranslateForm(), url: 'https://x/v.mp4' };

  const noCloning = translateOptionWarnings(form, { ...CAPABILITIES, voice_clone_languages: [] });
  assert.ok(noCloning.some(text => /Voice cloning is not available/.test(text)));

  const wrongLanguage = translateOptionWarnings({ ...form, target_language: 'es' }, CAPABILITIES);
  assert.ok(wrongLanguage.some(text => /does not support es/.test(text)));

  const noProfile = translateOptionWarnings({ ...form, voice_id: null }, CAPABILITIES);
  assert.ok(noProfile.some(text => /Choose a voice profile/.test(text)));

  const voiceDown = translateOptionWarnings(form, {
    ...CAPABILITIES,
    engines: { voice: { available: false, unavailable_reason: 'Voicebox is not reachable' } },
  });
  assert.ok(voiceDown.some(text => /Voicebox is not reachable/.test(text)));

  const noSeparation = translateOptionWarnings({ ...form, background_mode: 'separate' }, {
    ...CAPABILITIES, modes: { ...CAPABILITIES.modes, source_separation: false },
  });
  assert.ok(noSeparation.some(text => /Source separation is not installed/.test(text)));

  const lipSync = translateOptionWarnings({ ...form, lip_sync: true }, CAPABILITIES);
  assert.ok(lipSync.some(text => /Lip sync is experimental/.test(text)));

  const burn = translateOptionWarnings({ ...form, burn_subtitles: true }, {
    ...CAPABILITIES, modes: { ...CAPABILITIES.modes, burn_subtitles: false },
  });
  assert.ok(burn.some(text => /cannot burn subtitles in/.test(text)));

  // A fully configured request has nothing to say: cloning on with a chosen
  // profile, a clone-capable language, and every optional stage available.
  assert.deepEqual(translateOptionWarnings({ ...form, voice_id: 'voice42' }, CAPABILITIES), []);
});

test('the consent notice is part of the surfaced options', () => {
  assert.match(CONSENT_NOTICE, /permission from the speaker/);
  assert.equal(BACKGROUND_CHOICES.length, 4);
  assert.ok(BACKGROUND_CHOICES.some(choice => choice.id === 'duck'));
  assert.ok(BACKGROUND_CHOICES.some(choice => choice.id === 'separate'));
});

test('progress, phases and the stage checklist reflect the backend job', () => {
  const job = {
    job_id: 'job_1', state: 'running', progress: 52,
    stages: [
      { id: 'import', label: 'Downloaded / imported video', status: 'done' },
      { id: 'analyze', label: 'Analyzed video', status: 'done' },
      { id: 'extract_audio', label: 'Extracted audio', status: 'done' },
      { id: 'transcribe', label: 'Transcribed speech', status: 'done' },
      { id: 'translate', label: 'Translating', status: 'running' },
      { id: 'render', label: 'Rendering', status: 'pending' },
    ],
  };
  assert.equal(jobPhase(job), 'running');
  assert.equal(progressPercent(job), 52);
  const checklist = stageChecklist(job);
  assert.deepEqual(checklist.map(entry => entry.glyph), ['✓', '✓', '✓', '✓', '→', '○']);
  assert.equal(checklist[0].label, 'Downloaded / imported video');

  assert.equal(jobPhase({ state: 'done' }), 'complete');
  assert.equal(progressPercent({ state: 'done', progress: 40 }), 100);
  assert.equal(jobPhase({ state: 'error' }), 'failed');
  assert.equal(jobPhase({ state: 'cancelled' }), 'cancelled');
  assert.equal(jobPhase(null), 'idle');
  assert.equal(stageChecklist(null).length, Object.keys(STAGE_LABELS).length);
});

test('the starting background mode follows what the machine can actually do', () => {
  // With local separation installed, start from "remove the original voice" —
  // measurements show ducking alone leaves a speech-on-speech residue.
  assert.equal(preferredBackgroundMode({ modes: { source_separation: true } }), 'separate');
  assert.equal(preferredBackgroundMode({ modes: { source_separation: false } }), 'duck');
  assert.equal(preferredBackgroundMode(null), 'duck');
  assert.equal(preferredBackgroundMode({}), 'duck');
});

test('language lists come from capabilities, never a hardcoded UI list', () => {
  const source = languageOptions(CAPABILITIES, 'source');
  assert.equal(source[0].value, 'auto');
  assert.deepEqual(source.map(option => option.value), ['auto', 'en', 'pl']);
  const target = languageOptions(CAPABILITIES, 'target');
  assert.deepEqual(target.map(option => option.value), ['pl', 'es']);
  // Without capabilities the selects are simply empty rather than wrong.
  assert.deepEqual(languageOptions(null, 'target'), []);
});

test('history rows and output labels read well for every state', () => {
  const row = historyRow({
    job_id: 'job_9', state: 'running', progress: 64,
    source_language: 'en', target_language: 'pl',
    input: { type: 'url', label: 'interview.mp4' },
    created_at: '2026-10-15T10:00:00.000Z',
  });
  assert.deepEqual(row, {
    id: 'job_9', title: 'interview.mp4', pair: 'EN → PL', state: 'running',
    progress: 64, created_at: '2026-10-15T10:00:00.000Z', error: null, retryable: false,
  });
  assert.equal(languagePairLabel({ source_language: null, target_language: 'pl' }), 'AUTO → PL');
  assert.equal(jobTitle({ input: { uri: '/Users/me/Videos/clip.mov' } }), 'clip.mov');
  assert.equal(outputLabel({ kind: 'translated_video' }), 'Translated video');
  assert.equal(outputLabel({ kind: 'translated_subtitles' }), 'Translated subtitles');
  assert.equal(outputLabel({ kind: 'something_new' }), 'something_new');
  assert.equal(formatBytes(313232), '306 KB');
  assert.equal(formatBytes(0), '');
  assert.equal(formatDuration(22003), '22.0s');
  assert.equal(formatDuration(125000), '2m 5s');
});
