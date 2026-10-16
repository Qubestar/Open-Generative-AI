import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RendererAdapter, resolveFfmpegBinary } from '../src/rendererAdapter.js';
import {
  CharacterSheet,
  decomposeScriptToCartoonScenes,
  computeAmplitudeMouthAnimation,
  CloudByokAdapter,
  createCartoonEdgTimeline,
} from '../src/cartoon.js';

test('CharacterSheet encapsulates consistent rig traits and color palettes', () => {
  const hero = new CharacterSheet({
    id: 'char_alex',
    name: 'Alex Developer',
    rigType: 'cutout_vector',
    colorPalette: { primary: '#2563eb' },
    traits: ['glasses', 'hoodie'],
  });

  const json = hero.toJSON();
  assert.equal(json.id, 'char_alex');
  assert.equal(json.colorPalette.primary, '#2563eb');
  assert.deepEqual(json.traits, ['glasses', 'hoodie']);
  assert.ok(json.expressionPresets.speaking);
});

test('decomposeScriptToCartoonScenes decomposes script and triggers speedlines on action', () => {
  const characters = new Map([
    ['hero', new CharacterSheet({ id: 'hero', name: 'Hero' })],
  ]);

  const script = [
    { text: 'Nagle potwór atakuje i bohater szybko ucieka!', speaker: 'hero' },
    { text: 'Czy uda się rozwiązać ten problem?', speaker: 'hero' },
  ];

  const scenes = decomposeScriptToCartoonScenes(script, characters);
  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].visualEffects.speedlines, true);
  assert.equal(scenes[0].characterConfig.id, 'hero');
  assert.equal(scenes[1].visualEffects.comicSpeechBubble.bubbleType, 'question_bubble');
});

test('computeAmplitudeMouthAnimation calculates amplitude-driven mouth openness', () => {
  const rmsSamples = [
    { rms: 0.0001, timeSec: 0.0 }, // Silence
    { rms: 0.15, timeSec: 0.033 },  // Speech peak
    { rms: 0.05, timeSec: 0.066 },  // Speech mid
  ];

  const animation = computeAmplitudeMouthAnimation(rmsSamples);
  assert.equal(animation.length, 3);
  assert.equal(animation[0].mouthShape, 'closed');
  assert.equal(animation[0].mouthOpenness, 0);
  assert.ok(animation[1].mouthOpenness > 0.5);
  assert.equal(animation[0].technique, 'audio_amplitude_envelope');
});

test('CloudByokAdapter enforces spend limits and returns cached results on retry', async () => {
  const adapter = new CloudByokAdapter({ maxSpendLimitUsd: 0.10 });

  const r1 = await adapter.generateShot({ requestId: 'req_001', prompt: 'hero flying', costEstimateUsd: 0.06 });
  assert.equal(r1.isCached, false);
  assert.equal(adapter.recordedSpendUsd, 0.06);

  // Retry with same requestId is cached and does not charge
  const r1_retry = await adapter.generateShot({ requestId: 'req_001', prompt: 'hero flying', costEstimateUsd: 0.06 });
  assert.equal(r1_retry.isCached, true);
  assert.equal(adapter.recordedSpendUsd, 0.06);

  // New request that would exceed 0.10 limit is rejected
  await assert.rejects(async () => {
    await adapter.generateShot({ requestId: 'req_002', prompt: 'city view', costEstimateUsd: 0.06 });
  }, /Spend limit exceeded/);
});

test('createCartoonEdgTimeline builds valid EDG with dialogue and speedlines', () => {
  const characters = new Map([
    ['hero', new CharacterSheet({ id: 'hero', name: 'Hero' })],
  ]);

  const script = [
    { text: 'Nagle potwór atakuje i bohater szybko ucieka!', speaker: 'hero' },
    { text: 'Czy uda się rozwiązać ten problem?', speaker: 'hero' },
  ];

  const scenes = decomposeScriptToCartoonScenes(script, characters);
  const edg = createCartoonEdgTimeline(scenes, { fps: 30, aspect: '16:9' });

  assert.ok(edg);
  assert.equal(edg.canvas.width, 1920);
  assert.equal(edg.canvas.height, 1080);
  assert.ok(edg.totalTimelineFrames > 0);

  const dialogueTrack = edg.tracks.find(t => t.id === 'track_dialogue');
  const effectsTrack = edg.tracks.find(t => t.id === 'track_effects');

  assert.ok(dialogueTrack && dialogueTrack.clips.length === 2);
  assert.ok(effectsTrack && effectsTrack.clips.length === 1);
  assert.equal(effectsTrack.clips[0].type, 'speedlines');
});

test('RendererAdapter renders real Cartoon scene MP4 export', async () => {
  let ffmpegPath;
  try {
    ffmpegPath = resolveFfmpegBinary();
  } catch {
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo_cartoon_render_test_'));
  const adapter = new RendererAdapter({ ffmpegPath });

  const scenes = [
    {
      sceneId: 'scene_001',
      dialogue: 'Witaj w Vidmyo Cartoon Studio!',
      speakerId: 'hero',
      durationSec: 1.0,
      visualEffects: { speedlines: true, speedlinesDurationSec: 0.8 },
    },
  ];

  const edg = createCartoonEdgTimeline(scenes, { fps: 30, aspect: '16:9' });
  const exportFile = path.join(tmpDir, 'cartoon_scene.mp4');

  const result = await adapter.renderExport(edg, exportFile, {
    renderer: 'ffmpeg',
    execute: true,
  });

  assert.equal(result.status, 'done');
  assert.ok(fs.existsSync(exportFile));
  assert.ok(fs.statSync(exportFile).size > 1000);

  const probe = adapter.probeMedia(exportFile);
  assert.ok(probe.streams && probe.streams.length >= 1);
  const videoStream = probe.streams.find(s => s.codec_type === 'video');
  assert.ok(videoStream);
  assert.equal(videoStream.width, 1920);
  assert.equal(videoStream.height, 1080);

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

