// Tests for Screen Studio pure state machine and reducer model.
// Phase 5, Step 5 (Checkpoint E).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialScreenStudioState,
  screenStudioReducer,
  formatDuration,
  formatBytes,
  SCREEN_STUDIO_STATUS,
  SCREEN_STUDIO_MODES,
  newExportJobId,
  exportOutcome,
} from '../../studio/src/screenStudioModel.mjs';

test('formatDuration formats seconds to MM:SS', () => {
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(5), '00:05');
  assert.equal(formatDuration(65), '01:05');
  assert.equal(formatDuration(600), '10:00');
  assert.equal(formatDuration(3661), '61:01');
});

test('formatBytes formats bytes to human-readable strings', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(500), '500 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(2.5 * 1024 * 1024 * 1024), '2.50 GB');
});

test('screenStudioReducer: permission handling', () => {
  let state = initialScreenStudioState();
  assert.equal(state.status, SCREEN_STUDIO_STATUS.IDLE);

  // Permission denied
  state = screenStudioReducer(state, {
    type: 'SET_PERMISSION',
    granted: false,
    reason: 'Screen recording not allowed',
  });
  assert.equal(state.status, SCREEN_STUDIO_STATUS.PERMISSION_DENIED);
  assert.equal(state.permission.granted, false);
  assert.equal(state.permission.reason, 'Screen recording not allowed');

  // Permission granted
  state = screenStudioReducer(state, {
    type: 'SET_PERMISSION',
    granted: true,
  });
  assert.equal(state.status, SCREEN_STUDIO_STATUS.IDLE);
  assert.equal(state.permission.granted, true);
});

test('screenStudioReducer: SET_SOURCES adopts the first enumerated screen when the current index is not in the list', () => {
  let state = initialScreenStudioState();
  // Default state starts at index 0, but the real screens here are [1, 2]
  // (index 0 is a camera): the reducer must move off the stale 0.
  state = screenStudioReducer(state, {
    type: 'SET_SOURCES',
    screens: [
      { index: 1, name: 'Capture screen 0', isScreen: true },
      { index: 2, name: 'Capture screen 1', isScreen: true },
    ],
    audio: [{ index: 0, name: 'Scarlett 18i8 USB' }],
  });
  assert.equal(state.selectedScreenIndex, 1);
  assert.equal(state.sources.screens.length, 2);
  assert.equal(state.sources.audio.length, 1);
});

test('screenStudioReducer: SET_SOURCES keeps a still-valid selection and tolerates an empty list', () => {
  let state = initialScreenStudioState({ selectedScreenIndex: 2 });
  state = screenStudioReducer(state, {
    type: 'SET_SOURCES',
    screens: [{ index: 1 }, { index: 2 }],
    audio: [],
  });
  assert.equal(state.selectedScreenIndex, 2, 'existing valid selection is preserved');

  state = screenStudioReducer(state, { type: 'SET_SOURCES', screens: [], audio: [] });
  assert.equal(state.selectedScreenIndex, 2, 'empty list does not invent an index');
});

test('screenStudioReducer: full recording lifecycle', () => {
  let state = initialScreenStudioState({
    permission: { granted: true, reason: null, canPrompt: false },
  });

  // 1. Select screen
  state = screenStudioReducer(state, { type: 'SELECT_SCREEN', screenIndex: 1 });
  assert.equal(state.selectedScreenIndex, 1);

  // 2. Start recording
  state = screenStudioReducer(state, { type: 'START_RECORDING_REQUEST' });
  assert.equal(state.status, SCREEN_STUDIO_STATUS.STARTING_RECORDING);

  state = screenStudioReducer(state, {
    type: 'START_RECORDING_SUCCESS',
    jobId: 'job_rec123',
    startedAtMs: Date.now(),
  });
  assert.equal(state.status, SCREEN_STUDIO_STATUS.RECORDING);
  assert.equal(state.recording.jobId, 'job_rec123');

  // 3. Update timer & governor
  state = screenStudioReducer(state, { type: 'UPDATE_TIMER', elapsedSec: 15 });
  assert.equal(state.recording.elapsedSec, 15);

  state = screenStudioReducer(state, {
    type: 'UPDATE_GOVERNOR_STATUS',
    governorBusy: true,
    heldBy: 'job_other456',
  });
  assert.equal(state.recording.governorBusy, true);
  assert.equal(state.recording.heldBy, 'job_other456');

  // 4. Stop recording
  state = screenStudioReducer(state, { type: 'STOP_RECORDING_REQUEST' });
  assert.equal(state.status, SCREEN_STUDIO_STATUS.STOPPING_RECORDING);

  state = screenStudioReducer(state, {
    type: 'STOP_RECORDING_SUCCESS',
    result: {
      jobId: 'job_rec123',
      outputPath: '/fake/rec.mp4',
      durationSec: 15,
      fileSize: 1024 * 1024,
      samplesCount: 450,
      dataUrl: 'data:video/mp4;base64,AAAA',
      tooLarge: false,
    },
  });
  assert.equal(state.status, SCREEN_STUDIO_STATUS.RECORDED);
  assert.equal(state.recordedResult.durationSec, 15);
  assert.equal(state.preview.dataUrl, 'data:video/mp4;base64,AAAA');
  assert.equal(state.preview.tooLarge, false);
});

test('screenStudioReducer: cancel recording returns to idle', () => {
  let state = initialScreenStudioState();
  state = screenStudioReducer(state, {
    type: 'START_RECORDING_SUCCESS',
    jobId: 'job_rec123',
  });
  assert.equal(state.status, SCREEN_STUDIO_STATUS.RECORDING);

  state = screenStudioReducer(state, { type: 'CANCEL_RECORDING_SUCCESS' });
  assert.equal(state.status, SCREEN_STUDIO_STATUS.IDLE);
  assert.equal(state.recording.jobId, null);
});

test('screenStudioReducer: cancel recording failure surfaces the error and code (never a silent success)', () => {
  let state = initialScreenStudioState();
  state = screenStudioReducer(state, { type: 'START_RECORDING_SUCCESS', jobId: 'job_rec456' });
  assert.equal(state.status, SCREEN_STUDIO_STATUS.RECORDING);

  state = screenStudioReducer(state, {
    type: 'CANCEL_RECORDING_FAILURE',
    error: 'No recording session currently active',
    code: 'ENOSESSION',
  });
  assert.equal(state.status, SCREEN_STUDIO_STATUS.ERROR);
  assert.match(state.error, /No recording session currently active/);
  assert.match(state.error, /ENOSESSION/);
});

test('screenStudioReducer: export lifecycle with success and cancellation', () => {
  let state = initialScreenStudioState({
    status: SCREEN_STUDIO_STATUS.RECORDED,
    recordedResult: { jobId: 'job_rec123', outputPath: '/fake/rec.mp4' },
  });

  // Start export
  const exportJobId = newExportJobId('screen');
  state = screenStudioReducer(state, {
    type: 'START_EXPORT_REQUEST',
    jobId: exportJobId,
  });
  assert.equal(state.status, SCREEN_STUDIO_STATUS.EXPORTING);
  assert.equal(state.exportJob.jobId, exportJobId);

  // Cancellation outcome
  const cancelOutcome = exportOutcome({ ok: false, cancelled: true, jobId: exportJobId });
  state = screenStudioReducer(state, {
    type: 'EXPORT_FINISHED',
    jobId: exportJobId,
    outcome: cancelOutcome,
  });
  assert.equal(state.status, SCREEN_STUDIO_STATUS.RECORDED);
  assert.equal(state.exportJob.outcome.state, 'cancelled');
  assert.equal(state.exportJob.outcome.label, 'Anulowano');

  // Re-export and succeed
  state = screenStudioReducer(state, {
    type: 'START_EXPORT_REQUEST',
    jobId: exportJobId,
  });
  const successOutcome = exportOutcome({
    ok: true,
    jobId: exportJobId,
    outputPath: '/fake/out.mp4',
    encoder: { name: 'h264_videotoolbox' },
  });
  state = screenStudioReducer(state, {
    type: 'EXPORT_FINISHED',
    jobId: exportJobId,
    outcome: successOutcome,
  });
  assert.equal(state.status, SCREEN_STUDIO_STATUS.EXPORTED);
  assert.equal(state.exportJob.outcome.state, 'done');
  assert.equal(state.exportJob.outcome.label, 'Gotowe');
  assert.equal(state.exportJob.outputPath, '/fake/out.mp4');
});
