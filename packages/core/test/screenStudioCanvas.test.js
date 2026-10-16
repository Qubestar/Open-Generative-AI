import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecordingCanvasGraph } from '../src/screenStudio.js';
import { buildHelperCaptureArgs } from '../src/screenCapture.js';

const base = { inputWidth: 1920, inputHeight: 1080, width: 1920, height: 1080, fps: 30, frames: 90 };

test('canvas NONE keeps the recording full-frame with no background source', () => {
  const g = buildRecordingCanvasGraph({ ...base, backgroundPreset: 'NONE' });
  assert.match(g, /^\[0:v\]fps=30,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080/);
  assert.doesNotMatch(g, /gradients|alphamerge|overlay/);
});

test('canvas presets inset a rounded window over the background', () => {
  const g = buildRecordingCanvasGraph({ ...base, backgroundPreset: 'GRADIENT_PURPLE', preFilters: ['crop=100:100:0:0'] });
  assert.match(g, /^\[0:v\]crop=100:100:0:0,fps=30,scale=1688:950,format=yuva420p\[win\]/);
  assert.match(g, /gradients=s=1920x1080:type=radial/);
  assert.match(g, /\[win\]\[mask\]alphamerge\[rounded\]/);
  assert.match(g, /\[bg\]\[rounded\]overlay=\(W-w\)\/2:\(H-h\)\/2:shortest=1/);
  assert.match(g, /\[vout\]$/);
});

test('canvas inset fits portrait exports and keeps even dimensions', () => {
  const g = buildRecordingCanvasGraph({ ...base, width: 1080, height: 1920, backgroundPreset: 'MINIMAL_DARK' });
  const [, w, h] = g.match(/scale=(\d+):(\d+),format=yuva420p/);
  assert.equal(Number(w) % 2, 0);
  assert.equal(Number(h) % 2, 0);
  assert.ok(Number(w) <= 1080 * 0.88);
  assert.match(g, /color=c=0x09090b:s=1080x1920/);
});

test('unknown canvas preset falls back to full-frame', () => {
  const g = buildRecordingCanvasGraph({ ...base, backgroundPreset: 'BOGUS' });
  assert.doesNotMatch(g, /overlay/);
});

test('helper capture args carry display, fps, system audio and microphone', () => {
  assert.deepEqual(
    buildHelperCaptureArgs({ displayId: 3, fps: 30, systemAudio: true, microphoneId: 'mic-uid', outputPath: '/r/a.mp4' }),
    ['record', '--display', '3', '--out', '/r/a.mp4', '--fps', '30', '--system-audio', '--mic', 'mic-uid'],
  );
  assert.deepEqual(
    buildHelperCaptureArgs({ displayId: 1, outputPath: '/r/b.mp4' }),
    ['record', '--display', '1', '--out', '/r/b.mp4', '--fps', '30'],
  );
  assert.throws(() => buildHelperCaptureArgs({ displayId: -1, outputPath: '/r/c.mp4' }), /Invalid displayId/);
  assert.throws(() => buildHelperCaptureArgs({ displayId: 1, microphoneId: '', outputPath: '/r/c.mp4' }), /Invalid microphoneId/);
});

test('audio mixer graph applies per-track gains and mixes both tracks', async () => {
  const { buildRecordingAudioGraph } = await import('../src/screenStudio.js');
  const both = buildRecordingAudioGraph({ hasSystemAudio: true, hasMic: true, micVolume: 1.5, systemVolume: 0.5 });
  assert.match(both, /\[0:a\]volume=0\.5,/);
  assert.match(both, /\[1:a\]volume=1\.5,/);
  assert.match(both, /\[sys\]\[mic\]amix=inputs=2:normalize=0/);
  assert.match(buildRecordingAudioGraph({ hasSystemAudio: true, hasMic: true, micVolume: 0 }), /^\[0:a\].*\[sys\]apad\[aout\]$/);
  assert.match(buildRecordingAudioGraph({ hasMic: true }), /^\[1:a\].*\[mic\]apad\[aout\]$/);
  assert.equal(buildRecordingAudioGraph({ hasSystemAudio: true, systemVolume: 0 }), null);
  assert.match(buildRecordingAudioGraph({ hasSystemAudio: true, systemVolume: 9 }), /volume=2,/, 'gain is clamped to 200%');
});
