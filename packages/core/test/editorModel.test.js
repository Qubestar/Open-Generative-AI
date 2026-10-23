// Editor tab — presentation rules.
// Pure module: asserts the checks the panel relies on before it lets a user (or
// an agent through the same options) start an expensive local render.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EDITOR_ENGINES, EDITOR_PROGRESS_LABELS, EDITOR_STAGES, MAX_FACE_SHARE,
  defaultEditorForm, describeAnalysisJob, describeEditorJob, editorEngineOptions, editorModeOptions,
  editorPayloadFromForm, exampleList, exampleProfileSummary, formatDurationMs, isAbsolutePath,
  normalizeExampleUrl, stageChecklist, templateRows, validateEditorForm,
} from '../../studio/src/editorModel.mjs';

const CAPABILITIES = {
  engines: [
    { id: 'v1', name: 'V1', description: 'Documentary edit.', modes: ['original', 'custom'] },
  ],
  modes: [{ id: 'original', label: 'Original' }, { id: 'custom', label: 'Custom' }],
  qualities: ['draft', 'standard', 'high'],
  pacings: ['reference', 'long'],
};

const VALID = {
  engine: 'v1',
  mode: 'original',
  input_dir: '/Users/luke/Videos/take',
  output_dir: '/Users/luke/Videos/edits',
  template_id: null,
  music_path: null,
  quality: 'standard',
  pacing: 'reference',
  face_share: 0.3,
  example_urls: [],
  example_videos: [],
};

test('the default form starts on V1 / Original with the contract defaults', () => {
  const form = defaultEditorForm(CAPABILITIES);
  assert.equal(form.engine, 'v1');
  assert.equal(form.mode, 'original');
  assert.equal(form.quality, 'standard');
  assert.equal(form.pacing, 'reference');
  assert.equal(form.face_share, 0.3);
  assert.equal(form.music_path, null);
  assert.equal(form.template_id, null);
  assert.deepEqual(form.example_urls, []);
  assert.deepEqual(form.example_videos, []);

  // Without capabilities the tab still starts on the bundled engine, not blank.
  assert.equal(defaultEditorForm(null).engine, 'v1');
});

test('engines and modes come from capabilities, never a hardcoded UI list', () => {
  assert.deepEqual(editorEngineOptions(CAPABILITIES).map(option => option.value), ['v1']);
  // An engine that offers only Original hides the Custom switch.
  const originalOnly = { ...CAPABILITIES, engines: [{ id: 'v2', name: 'V2', modes: ['original'] }] };
  assert.deepEqual(editorModeOptions(originalOnly, 'v2').map(option => option.value), ['original']);
  assert.deepEqual(editorModeOptions(CAPABILITIES, 'v1').map(option => option.label), ['Original', 'Custom']);
  // An unknown engine falls back to the first engine's modes rather than an empty control.
  assert.equal(editorModeOptions(CAPABILITIES, 'nope').length, 2);
  assert.equal(editorEngineOptions(null)[0].value, EDITOR_ENGINES[0].id);
});

test('a valid form passes with no errors', () => {
  const result = validateEditorForm(VALID);
  assert.deepEqual(result, { ok: true, errors: {} });
  assert.equal(validateEditorForm({ ...VALID, music_path: '/Users/luke/Music/bed.mp3' }).ok, true);
});

test('both folders are required and both must be absolute', () => {
  const missing = validateEditorForm({ ...VALID, input_dir: '', output_dir: '' });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.input_dir, /folder that holds your footage/);
  assert.match(missing.errors.output_dir, /where the finished edit/);

  const relative = validateEditorForm({ ...VALID, input_dir: 'Videos/take', output_dir: 'edits' });
  assert.match(relative.errors.input_dir, /full path/);
  assert.match(relative.errors.output_dir, /full path/);

  assert.equal(validateEditorForm({ ...VALID, input_dir: '/Users/luke' }).ok, true);
  assert.equal(isAbsolutePath('C:\\footage'), true);
  assert.equal(isAbsolutePath('footage'), false);
  assert.equal(isAbsolutePath(''), false);
});

test('the output folder must differ from the footage folder', () => {
  const same = validateEditorForm({ ...VALID, output_dir: VALID.input_dir });
  assert.match(same.errors.output_dir, /different one/);
});

test('custom mode needs an example unless a template is applied', () => {
  const custom = { ...VALID, mode: 'custom' };
  const empty = validateEditorForm(custom);
  assert.equal(empty.ok, false);
  assert.match(empty.errors.examples, /at least one example video/);

  // A URL is enough.
  assert.equal(validateEditorForm({ ...custom, example_urls: ['https://youtu.be/abc'] }).ok, true);
  // A local file is enough.
  assert.equal(validateEditorForm({ ...custom, example_videos: ['/Users/luke/Videos/ref.mp4'] }).ok, true);
  // A saved template is enough on its own.
  assert.equal(validateEditorForm({ ...custom, template_id: 'teal-cuts' }).ok, true);
  // Original mode never asks for examples.
  assert.equal(validateEditorForm({ ...VALID, mode: 'original' }).ok, true);
});

test('music bed and face share are validated, not silently repaired', () => {
  assert.match(validateEditorForm({ ...VALID, music_path: 'bed.mp3' }).errors.music_path, /Browse/);
  assert.equal(validateEditorForm({ ...VALID, face_share: 0 }).ok, true);
  assert.equal(validateEditorForm({ ...VALID, face_share: MAX_FACE_SHARE }).ok, true);
  assert.match(validateEditorForm({ ...VALID, face_share: 0.9 }).errors.face_share, /between 0%/);
  assert.match(validateEditorForm({ ...VALID, face_share: -0.1 }).errors.face_share, /between 0%/);
  assert.match(validateEditorForm({ ...VALID, quality: 'best' }).errors.quality, /draft, standard or high/);
  assert.match(validateEditorForm({ ...VALID, pacing: 'fast' }).errors.pacing, /reference or long/);
  assert.match(validateEditorForm({ ...VALID, engine: 'v9' }).errors.engine, /not available/);
});

test('example helpers keep order, drop blanks and validate links', () => {
  const form = {
    example_urls: ['https://youtu.be/abc', ''],
    example_videos: ['/Users/luke/Videos/ref.mp4', 'https://youtu.be/abc'],
  };
  assert.deepEqual(exampleList(form), ['https://youtu.be/abc', '/Users/luke/Videos/ref.mp4']);
  assert.deepEqual(exampleList(null), []);
  assert.equal(normalizeExampleUrl(' youtu.be/abc '), null);
  assert.equal(normalizeExampleUrl('https://youtu.be/abc'), 'https://youtu.be/abc');
  assert.equal(normalizeExampleUrl('ftp://x/y.mp4'), null);
});

test('the payload carries exactly the backend field names', () => {
  const payload = editorPayloadFromForm({
    ...VALID, mode: 'custom', template_id: 'teal-cuts',
    music_path: '/Users/luke/Music/bed.mp3', face_share: 0.45,
  });
  assert.deepEqual(payload, {
    input_dir: '/Users/luke/Videos/take',
    output_dir: '/Users/luke/Videos/edits',
    mode: 'custom',
    engine: 'v1',
    template_id: 'teal-cuts',
    music_path: '/Users/luke/Music/bed.mp3',
    quality: 'standard',
    pacing: 'reference',
    face_share: 0.45,
  });
  assert.equal(editorPayloadFromForm({ ...VALID, music_path: '  ' }).music_path, null);
});

test('describeEditorJob summarizes a running job and names the current stage', () => {
  const job = {
    job_id: 'job_1', state: 'running', progress: 62,
    stages: [
      { id: 'probe', label: EDITOR_PROGRESS_LABELS.probe, status: 'done' },
      { id: 'prepare', label: EDITOR_PROGRESS_LABELS.prepare, status: 'done' },
      { id: 'transcribe', label: EDITOR_PROGRESS_LABELS.transcribe, status: 'running' },
      { id: 'assets', label: EDITOR_PROGRESS_LABELS.assets, status: 'pending' },
    ],
  };
  const view = describeEditorJob(job);
  assert.equal(view.state, 'running');
  assert.equal(view.stage, 'transcribe');
  assert.equal(view.stageLabel, 'Transcribing the take');
  assert.equal(view.progress, 62);
  assert.equal(view.summary, 'Transcribing the take…');
  assert.equal(view.isRunning, true);
  assert.equal(view.isDone, false);
  assert.equal(view.isFailed, false);
  assert.equal(view.outputPath, null);
  assert.deepEqual(view.warnings, []);
});

test('a finished job reports final.mp4 and its duration', () => {
  const job = {
    job_id: 'job_2', state: 'done', progress: 100, output_dir: '/Users/luke/Videos/edits/take-20261023-101010',
    outputs: [{ kind: 'final_video', artifact: 'out/final.mp4', duration_ms: 42300 }],
    warnings: ['Music bed was shorter than the take; the tail is dry.'],
  };
  const view = describeEditorJob(job);
  assert.equal(view.isDone, true);
  assert.equal(view.progress, 100);
  assert.equal(view.summary, 'Finished. final.mp4 is in the output folder.');
  assert.equal(view.outputPath, '/Users/luke/Videos/edits/take-20261023-101010/out/final.mp4');
  assert.equal(view.durationMs, 42300);
  assert.equal(formatDurationMs(view.durationMs), '42.3s');
  assert.deepEqual(view.warnings, ['Music bed was shorter than the take; the tail is dry.']);
});

test('a job with no output entries still resolves the contract path once done', () => {
  const view = describeEditorJob({ state: 'done', progress: 100, output_dir: '/tmp/proj' });
  assert.equal(view.outputPath, '/tmp/proj/out/final.mp4');
  // An unfinished job makes no promise about a file that does not exist yet.
  assert.equal(describeEditorJob({ state: 'running', progress: 10, output_dir: '/tmp/proj' }).outputPath, null);
});

test('failures and cancellations read as sentences, not codes', () => {
  const failed = describeEditorJob({ state: 'error', progress: 40, error: 'ffmpeg exited 1', stage: 'render',
    stages: [{ id: 'render', status: 'failed', label: 'Rendering the picture', error: 'ffmpeg exited 1' }] });
  assert.equal(failed.isFailed, true);
  assert.equal(failed.isRunning, false);
  assert.match(failed.summary, /Stopped: ffmpeg exited 1/);
  assert.match(failed.error, /ffmpeg/);

  const cancelled = describeEditorJob({ state: 'cancelled', progress: 20, stages: [] });
  assert.equal(cancelled.isCancelled, true);
  assert.match(cancelled.summary, /Cancelled/);

  const idle = describeEditorJob(null);
  assert.equal(idle.state, 'idle');
  assert.equal(idle.progress, 0);
  assert.equal(idle.isRunning, false);
  assert.equal(idle.summary, 'No edit selected.');
});

test('stageChecklist lists every stage before a job exists, then mirrors the job', () => {
  const empty = stageChecklist(null);
  assert.equal(empty.length, EDITOR_STAGES.length);
  assert.deepEqual(empty.map(entry => entry.id), EDITOR_STAGES);
  assert.ok(empty.every(entry => entry.status === 'pending' && entry.error === null));

  const checklist = stageChecklist({
    state: 'running',
    stages: [
      { id: 'probe', status: 'done', label: 'Inspecting footage', metrics: { duration_s: 42.5 } },
      { id: 'prepare', status: 'skipped' },
      { id: 'transcribe', status: 'running' },
      { id: 'assets', status: 'failed', error: 'no pictures found' },
      { id: 'plan', status: 'pending' },
    ],
  });
  assert.deepEqual(checklist.map(entry => entry.status), ['done', 'skipped', 'running', 'failed', 'pending']);
  assert.equal(checklist[0].metrics.duration_s, 42.5);
  // A stage without a label is labelled from the shared progress table.
  assert.equal(checklist[1].label, 'Preparing camera plate and voice');
  assert.equal(checklist[3].error, 'no pictures found');

  // A terminal job with no stage list has nothing honest to show.
  assert.deepEqual(stageChecklist({ state: 'done', stages: [] }), []);
});

test('the bridge analysis envelope becomes progress plus measured profile', () => {
  const view = describeAnalysisJob(
    { job: { state: 'running', checkpoints: { stage: 'analyze', progress: 55 } } },
    null,
  );
  assert.equal(view.progress, 55);
  assert.equal(view.stage, 'analyze');
  assert.equal(view.isRunning, true);
  assert.match(view.summary, /Measuring cuts/);

  const measured = { cut_median_s: 0.42, cuts_per_minute: 141, palette: ['#112233', 'bad', '#445566'] };
  const done = describeAnalysisJob({ state: 'done', progress: 100 }, measured);
  assert.equal(done.isDone, true);
  assert.equal(done.progress, 100);
  assert.match(done.summary, /Style measured/);
  assert.equal(done.profile, measured);

  const failed = describeAnalysisJob({ state: 'error', error: 'yt-dlp exited 1' }, null);
  assert.equal(failed.isFailed, true);
  assert.match(failed.summary, /yt-dlp exited 1/);
});

test('the measured profile formats real numbers and drops junk swatches', () => {
  const summary = exampleProfileSummary({
    cut_median_s: 0.42, cuts_per_minute: 141, burst_ratio: 0.18,
    aspect_ratio: '16:9', palette: ['#112233', { hex: '#445566' }, 'not-a-colour', '#778'],
  });
  assert.equal(summary.cutMedianLabel, '0.42 s');
  assert.equal(summary.cutsPerMinuteLabel, '141/min');
  assert.deepEqual(summary.palette, ['#112233', '#445566', '#778']);
  assert.ok(summary.lines.some(line => /Median cut 0\.42 s/.test(line)));
  assert.ok(summary.lines.some(line => /18% of shots/.test(line)));

  // style-profile.json may nest the measurements under `style`.
  const nested = exampleProfileSummary({
    style: { cut_median_s: 1.35, cuts_per_minute: 44, palette: ['#0f2a33', '#e8e2d2'] },
    aspect_ratio: '16:9',
  });
  assert.equal(nested.cutMedianLabel, '1.35 s');
  assert.equal(nested.cutsPerMinuteLabel, '44/min');
  assert.deepEqual(nested.palette, ['#0f2a33', '#e8e2d2']);

  const none = exampleProfileSummary(null);
  assert.deepEqual(none.lines, []);
  assert.deepEqual(none.palette, []);
  // A profile with no measurements reports nothing rather than zeros.
  assert.deepEqual(exampleProfileSummary({}).lines, []);
});

test('templateRows turn saved templates into one readable line each', () => {
  const rows = templateRows([
    {
      id: 'teal-cuts-1a2b3c', name: 'Teal cuts', engine: 'v1', created_at: '2026-10-20T10:00:00.000Z',
      cut_median_s: 0.42, cuts_per_minute: 141, palette: ['#112233', '#445566'],
      examples: ['https://youtu.be/abc', '/Users/luke/Videos/ref.mp4'],
    },
    { id: 'bare', name: 'Bare' },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'teal-cuts-1a2b3c');
  assert.equal(rows[0].name, 'Teal cuts');
  assert.equal(rows[0].cutMedianLabel, '0.42 s');
  assert.equal(rows[0].cutsPerMinuteLabel, '141/min');
  assert.equal(rows[0].exampleCount, 2);
  assert.deepEqual(rows[0].palette, ['#112233', '#445566']);
  assert.equal(rows[0].detail, 'median cut 0.42 s · 141 cuts/min · 2 examples');
  // A template saved without a measurement says so instead of inventing numbers.
  assert.equal(rows[1].detail, 'not measured yet');
  assert.deepEqual(templateRows(null), []);
});

test('durations read well and stay empty when unknown', () => {
  assert.equal(formatDurationMs(0), '');
  assert.equal(formatDurationMs(null), '');
  assert.equal(formatDurationMs(-5), '');
  assert.equal(formatDurationMs(640), '640 ms');
  assert.equal(formatDurationMs(42300), '42.3s');
  assert.equal(formatDurationMs(125000), '2m 5s');
  assert.equal(formatDurationMs(3725000), '1h 2m');
});

test('agent rows separate connected, signed-in, offline and missing agents', async () => {
  const { editorAgentRows, defaultBrainAgent } = await import('../../studio/src/editorModel.mjs');
  const rows = editorAgentRows([
    { id: 'opencode', label: 'OpenCode', installed: true, ready: true },
    { id: 'codex', label: 'Codex', installed: true, ready: false, signed_in: true, human_reason: 'This ChatGPT plan has no Codex model access.' },
    { id: 'claude_code', label: 'Claude Code', installed: true, ready: false, signed_in: false, human_reason: 'Not signed in on this machine.' },
    { id: 'x', label: 'Missing', installed: false },
  ]);
  assert.deepEqual(rows.map(row => row.status), ['ready', 'error', 'offline', 'missing']);
  assert.deepEqual(rows.map(row => row.selectable), [true, false, false, false]);
  assert.equal(rows[1].reason, 'This ChatGPT plan has no Codex model access.');
  assert.equal(defaultBrainAgent(rows), 'opencode');
  assert.equal(defaultBrainAgent([]), '');
});
