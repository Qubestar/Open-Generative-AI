import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  auditAvatarModelLicense,
  createAvatarAlphaPipeline,
  generate2dMascotAvatar,
  render2dMascotVideo,
  extractAudioEnvelope,
  AVATAR_ENGINES,
} from '../src/avatarStudio.js';

test('auditAvatarModelLicense blocks restricted Wav2Lip and unverified LivePortrait InsightFace models', () => {
  const wav2lipAudit = auditAvatarModelLicense(AVATAR_ENGINES.WAV2LIP_RESTRICTED);
  assert.equal(wav2lipAudit.commercialAllowed, false);
  assert.match(wav2lipAudit.reason, /non-commercial/i);

  // In strict compliance with Rule 7, LivePortrait fails closed until dependency & weight audits are completed
  const livePortraitAudit = auditAvatarModelLicense(AVATAR_ENGINES.LIVEPORTRAIT_MPS);
  assert.equal(livePortraitAudit.commercialAllowed, false);
  assert.match(livePortraitAudit.reason, /InsightFace/i);

  // 2D Mascot fallback is verified and permitted
  const mascotAudit = auditAvatarModelLicense(AVATAR_ENGINES.CUTOUT_2D_FALLBACK);
  assert.equal(mascotAudit.commercialAllowed, true);
});

test('createAvatarAlphaPipeline enforces license gate and blocks unverified engines', () => {
  // Wav2Lip must be rejected by commercial license gate
  assert.throws(() => {
    createAvatarAlphaPipeline({
      sourceImagePath: '/tmp/face.png',
      audioPath: '/tmp/audio.wav',
      engine: AVATAR_ENGINES.WAV2LIP_RESTRICTED,
    });
  }, /Commercial license gate rejected/);

  // LivePortrait must also fail closed pending license and benchmark audit
  assert.throws(() => {
    createAvatarAlphaPipeline({
      sourceImagePath: '/tmp/face.png',
      audioPath: '/tmp/audio.wav',
      engine: AVATAR_ENGINES.LIVEPORTRAIT_MPS,
    });
  }, /Commercial license gate rejected/);
});

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { resolveFfmpegBinary, resolveFfprobeBinary } from '../src/rendererAdapter.js';

test('extractAudioEnvelope decodes PCM from real audio and computes per-frame RMS and mouth openness', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-envelope-test-'));
  try {
    const ffmpegBin = resolveFfmpegBinary();
    const audioPath = path.join(tmpDir, 'test_speech.wav');
    // Generate 2.0s audio: 0..1.0s silence, 1.0..2.0s tone
    const audioGen = spawnSync(ffmpegBin, [
      '-y',
      '-f', 'lavfi', '-i', 'aevalsrc=if(gt(t\\,1.0)\\,sin(2*PI*440*t)\\,0):d=2.0:s=16000',
      '-c:a', 'pcm_s16le',
      audioPath,
    ], { encoding: 'utf8' });
    assert.equal(audioGen.status, 0);

    const env = extractAudioEnvelope(audioPath, { fps: 30, sampleRate: 16000 });
    assert.ok(Math.abs(env.durationSec - 2.0) < 0.1, `Duration ${env.durationSec} should be ~2.0s`);
    assert.equal(env.fps, 30);
    assert.ok(env.mouthStates.length >= 58 && env.mouthStates.length <= 62);

    // Frame at t=0.5s (silence) should have openness ~ 0
    const silentFrame = env.mouthStates[15]; // frame 15 is 0.5s
    assert.equal(silentFrame.openness, 0);

    // Frame at t=1.5s (loud tone) should have openness > 0.5
    const loudFrame = env.mouthStates[45]; // frame 45 is 1.5s
    assert.ok(loudFrame.openness > 0.5, `Loud frame openness should be > 0.5, got ${loudFrame.openness}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('render2dMascotVideo fails with error if supplied audioPath does not exist', async () => {
  const mascot = generate2dMascotAvatar({ characterName: 'TestBot' });
  await assert.rejects(
    () => render2dMascotVideo(mascot, '/tmp/nonexistent_mascot.mp4', {
      audioPath: '/tmp/completely_nonexistent_audio_file_12345.wav',
    }),
    /Supplied audio file not found/
  );
});

test('render2dMascotVideo falls back to synthetic tone when no audio is requested and labels source', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-mascot-synth-'));
  try {
    const mascot = generate2dMascotAvatar({ characterName: 'SynthBot', audioDurationSec: 1.0 });
    const outPath = path.join(tmpDir, 'synth_mascot.mp4');
    const res = await render2dMascotVideo(mascot, outPath, {
      audioPath: null, // explicit no audio requested
      width: 320,
      height: 320,
    });
    assert.equal(res.ok, true);
    assert.equal(res.audioSource, 'synthetic_tone');
    assert.ok(fs.existsSync(outPath));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('render2dMascotVideo decodes audio from real file, computes envelope dynamically, probes duration, and animates mouth', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-mascot-real-'));
  try {
    const ffmpegBin = resolveFfmpegBinary();
    const ffprobeBin = resolveFfprobeBinary();

    // 1. Generate real audio file with distinct silent segment (0..0.6s) and loud speech tone (0.6..1.4s)
    const audioPath = path.join(tmpDir, 'real_narration.wav');
    const audioGen = spawnSync(ffmpegBin, [
      '-y',
      '-f', 'lavfi', '-i', 'aevalsrc=if(gt(t\\,0.6)\\,0.8*sin(2*PI*500*t)\\,0):d=1.4:s=16000',
      '-c:a', 'pcm_s16le',
      audioPath,
    ], { encoding: 'utf8' });
    assert.equal(audioGen.status, 0);

    // 2. Pass NO pre-computed amplitude envelope or mouth states — let render2dMascotVideo extract and probe it!
    const mascot = generate2dMascotAvatar({
      characterName: 'RealAudioBot',
      color: '#06b6d4',
      // no amplitudeEnvelope provided!
    });
    assert.equal(mascot.mouthStates.length, 0);

    const exportPath = path.join(tmpDir, 'real_audio_mascot.mp4');
    let recordedChildProcess = null;

    const result = await render2dMascotVideo(mascot, exportPath, {
      fps: 30,
      width: 360,
      height: 360,
      audioPath, // real audio path supplied!
      onSpawn: (proc) => {
        recordedChildProcess = proc;
        assert.ok(proc.pid > 0);
      },
    });

    assert.equal(result.ok, true);
    assert.ok(recordedChildProcess !== null);
    assert.equal(result.audioSource, 'real_narration_file');
    // Probed duration should match ~1.4s of audio, NOT the default 5.0s
    assert.ok(Math.abs(result.durationSec - 1.4) < 0.1, `Probed duration ${result.durationSec}s must be ~1.4s`);
    assert.ok(fs.existsSync(exportPath));

    // 3. Verify probe has both video and audio streams
    const probeProc = spawnSync(ffprobeBin, [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,duration',
      '-of', 'json',
      exportPath,
    ], { encoding: 'utf8' });
    const probeData = JSON.parse(probeProc.stdout);
    const vStream = probeData.streams?.find(s => s.codec_type === 'video');
    const aStream = probeData.streams?.find(s => s.codec_type === 'audio');
    assert.ok(vStream, 'Video stream must exist');
    assert.ok(aStream, 'Audio stream must exist');

    // 4. Extract frame during silence (t=0.2s) vs during loud speech tone (t=1.0s)
    const frameSilence = path.join(tmpDir, 'mouth_silence.png');
    const frameSpeech = path.join(tmpDir, 'mouth_speech.png');

    spawnSync(ffmpegBin, ['-y', '-ss', '0.2', '-i', exportPath, '-vframes', '1', frameSilence]);
    spawnSync(ffmpegBin, ['-y', '-ss', '1.0', '-i', exportPath, '-vframes', '1', frameSpeech]);

    assert.ok(fs.existsSync(frameSilence));
    assert.ok(fs.existsSync(frameSpeech));

    const hashSilence = crypto.createHash('sha256').update(fs.readFileSync(frameSilence)).digest('hex');
    const hashSpeech = crypto.createHash('sha256').update(fs.readFileSync(frameSpeech)).digest('hex');

    assert.notEqual(hashSilence, hashSpeech, 'Mouth frame during silence must differ from mouth frame during speech');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


