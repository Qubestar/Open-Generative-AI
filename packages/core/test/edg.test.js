import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EDG_SCHEMA_VERSION,
  createEmptyEdg,
  validateEdg,
  sanitizeAiEdgSuggestion,
  legacyStoryToEdg,
  storyToEdg,
  repurposeToEdg,
  cleanerToEdg,
  createAudioMixEdg,
  EdgValidationError,
} from '../src/edg.js';
import { Project } from '../src/project.js';
import { RepurposeProject } from '../src/repurpose.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

test('createEmptyEdg generates valid baseline EDG', () => {
  const edg = createEmptyEdg({ title: 'Test Video', aspect: '9:16' });
  assert.equal(edg.schemaVersion, EDG_SCHEMA_VERSION);
  assert.equal(edg.canvas.aspect, '9:16');
  assert.equal(edg.canvas.width, 1080);
  assert.equal(edg.canvas.height, 1920);

  const validation = validateEdg(edg);
  assert.ok(validation.valid);
  assert.equal(validation.trackCount, 5);
});

test('validateEdg detects overlapping clips on same track', () => {
  const edg = createEmptyEdg();
  const track = edg.tracks[0];
  track.clips.push(
    { id: 'clip_1', timelineStartFrame: 0, timelineEndFrame: 90 },
    { id: 'clip_2', timelineStartFrame: 60, timelineEndFrame: 150 }, // overlaps clip_1
  );

  assert.throws(() => validateEdg(edg), (err) => {
    assert.ok(err instanceof EdgValidationError);
    assert.match(err.message, /Overlapping clips detected/);
    return true;
  });
});

test('validateEdg rejects invalid schema versions or missing assets', () => {
  const edg = createEmptyEdg();
  edg.schemaVersion = '99.0.0';
  assert.throws(() => validateEdg(edg), /Unsupported schemaVersion/);

  const edg2 = createEmptyEdg();
  edg2.tracks[0].clips.push({
    id: 'clip_orphan',
    assetId: 'non_existent_asset',
    timelineStartFrame: 0,
    timelineEndFrame: 30,
  });
  assert.throws(() => validateEdg(edg2), /references non-existent asset/);
});

test('sanitizeAiEdgSuggestion blocks malicious payload injection', () => {
  const edg = createEmptyEdg();

  // Executable script tag injection
  assert.throws(() => {
    sanitizeAiEdgSuggestion({
      operation: 'insert_clip',
      trackId: 'video-primary',
      payload: '<script>alert(1)</script>',
    }, edg);
  }, /prohibited executable content/i);

  // Eval / process access attempt
  assert.throws(() => {
    sanitizeAiEdgSuggestion({
      operation: 'insert_clip',
      trackId: 'video-primary',
      code: 'process.exit(1)',
    }, edg);
  }, /prohibited executable content/i);

  // Unknown arbitrary operation
  assert.throws(() => {
    sanitizeAiEdgSuggestion({
      operation: 'execute_shell_command',
      trackId: 'video-primary',
    }, edg);
  }, /Prohibited or unknown AI operation/);

  // Valid structured AI proposal passes cleanly
  const validSuggestion = sanitizeAiEdgSuggestion({
    operation: 'insert_clip',
    trackId: 'video-primary',
    clip: { id: 'suggested_1', timelineStartFrame: 0, timelineEndFrame: 60 },
  }, edg);
  assert.equal(validSuggestion.operation, 'insert_clip');
});

test('legacyStoryToEdg migrates Story manifest to valid EDG', () => {
  const mockStory = {
    id: 'proj_test_story',
    aspect: '16:9',
    brief: { topic: 'AI Revolution' },
    style: 'doodle-v1',
    voiceover: { artifact: '/tmp/test_vo.wav' },
    scenes: [
      { id: 's001', artifact: '/tmp/s001.png', narrationSpan: { durationSec: 3.5 } },
      { id: 's002', artifact: '/tmp/s002.png', narrationSpan: { durationSec: 4.0 } },
    ],
  };

  const edg = legacyStoryToEdg(mockStory);
  const validation = validateEdg(edg);
  assert.ok(validation.valid);
  assert.equal(validation.assetCount, 3); // 2 scenes + 1 voiceover
  assert.equal(validation.totalTimelineFrames, 225); // (3.5 + 4.0) * 30 = 225 frames
});

test('storyToEdg embeds SHA-256 asset hashes and rich provenance across tracks', () => {
  const mockStory = {
    id: 'proj_rich_story_123',
    aspect: '16:9',
    brief: { topic: 'Quantum Computing Explained' },
    style: 'doodle-v1',
    voiceover: {
      source: 'kokoro',
      artifact: '/tmp/test_quantum_vo.wav',
      voice: 'am_onyx',
      wordTimings: [
        { word: 'Quantum', startSec: 0.0, endSec: 0.6 },
        { word: 'computers', startSec: 0.6, endSec: 1.2 },
        { word: 'compute', startSec: 1.2, endSec: 1.8 },
      ],
    },
    scenes: [
      {
        id: 's001',
        prompt: 'A doodle of a glowing qubit sphere',
        beat: 'Introduction to qubits',
        imageSource: 'flow',
        imageModel: 'nano-banana-2',
        artifact: '/tmp/qubit_s001.png',
        narrationSpan: { durationSec: 3.0, startSec: 0.0, text: 'Quantum computers compute' },
        approved: true,
      },
    ],
  };

  const edg = storyToEdg(mockStory);
  const validation = validateEdg(edg);
  assert.ok(validation.valid);

  // Asset hashes & provenance
  const voAsset = edg.assets['asset_voiceover_main'];
  assert.ok(voAsset);
  assert.equal(typeof voAsset.hash, 'string');
  assert.ok(voAsset.hash.length >= 16);
  assert.equal(voAsset.provenance.provider, 'kokoro');
  assert.equal(voAsset.provenance.voice, 'am_onyx');

  const sceneAsset = edg.assets['asset_s001'];
  assert.ok(sceneAsset);
  assert.equal(sceneAsset.provenance.prompt, 'A doodle of a glowing qubit sphere');
  assert.equal(sceneAsset.provenance.imageSource, 'flow');
  assert.equal(sceneAsset.provenance.approved, true);

  // Tracks & word-level captions
  const captionTrack = edg.tracks.find(t => t.id === 'captions-main');
  assert.ok(captionTrack.clips.length >= 3);
  assert.equal(captionTrack.clips[0].text, 'Quantum');
  assert.equal(captionTrack.clips[1].text, 'computers');
});

test('repurposeToEdg embeds source video hash, candidate score provenance, and reframe coordinates', () => {
  const mockRepurpose = {
    id: 'repurpose_test_999',
    content_type: 'podcast',
    engine_version: '1.2.0',
    target_platforms: ['youtube_shorts', 'tiktok'],
    source: {
      type: 'local_file',
      uri: '/tmp/podcast_interview.mp4',
      fingerprint: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
    candidates: [
      {
        id: 'clip_001',
        start_time: 12.0,
        end_time: 25.0,
        score: 0.94,
        hook_score: 0.91,
        rationale: 'High energy revelation at start of clip',
        decision: 'approved',
        reframe: { x: 0.45, y: 0.50, scale: 1.15 },
        words: [
          { word: 'Never', start_time: 12.0, end_time: 12.4, confidence: 0.98 },
          { word: 'give', start_time: 12.4, end_time: 12.8, confidence: 0.99 },
          { word: 'up', start_time: 12.8, end_time: 13.2, confidence: 0.97 },
        ],
      },
    ],
  };

  const edg = repurposeToEdg(mockRepurpose, { candidateId: 'clip_001' });
  const validation = validateEdg(edg);
  assert.ok(validation.valid);
  assert.equal(edg.canvas.aspect, '9:16');
  assert.equal(edg.canvas.width, 1080);
  assert.equal(edg.canvas.height, 1920);

  // Source asset
  const sourceAsset = edg.assets['asset_repurpose_source'];
  assert.ok(sourceAsset);
  assert.equal(sourceAsset.hash, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sourceAsset.provenance.contentType, 'podcast');

  // Video track clip reframe and score metadata
  const videoTrack = edg.tracks.find(t => t.id === 'video-primary');
  assert.equal(videoTrack.clips.length, 1);
  const clip = videoTrack.clips[0];
  assert.equal(clip.transform.scale, 1.15);
  assert.equal(clip.metadata.score, 0.94);

  // Captions track
  const captionTrack = edg.tracks.find(t => t.id === 'captions-main');
  assert.equal(captionTrack.clips.length, 3);
  assert.equal(captionTrack.clips[0].text, 'Never');
});

test('createAudioMixEdg creates validated audio timeline with sidechain ducking curve', () => {
  const edg = createAudioMixEdg({
    title: 'Podcast Master Mix',
    voiceAsset: { id: 'voice_main', path: '/tmp/host_speech.wav' },
    musicAsset: { id: 'bg_music', path: '/tmp/ambient_lofi.mp3' },
    duckingCurve: [
      { timeSec: 2.0, volumeDb: -18 },
      { timeSec: 10.0, volumeDb: 0 },
    ],
    totalDurationSec: 60.0,
  });

  const validation = validateEdg(edg);
  assert.ok(validation.valid);
  assert.equal(edg.timebase.sampleRate, 48000);
  assert.equal(edg.metadata.isAudioOnlyMix, true);
  assert.equal(edg.metadata.hasSidechainDucking, true);

  const musicTrack = edg.tracks.find(t => t.id === 'audio-music');
  assert.equal(musicTrack.clips.length, 1);
  assert.equal(musicTrack.clips[0].duckingKeyframes.length, 2);
});

test('Project and RepurposeProject expose toEdg() methods directly', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-edg-methods-'));
  try {
    // 1. Story Project
    const storyDir = path.join(tmpDir, 'story_proj');
    const project = Project.create(storyDir, {
      brief: { topic: 'Microscopic Life' },
      style: 'doodle-v1',
      aspect: '16:9',
    });
    project.addScene({ beat: 'Paramecium swimming', prompt: 'Doodle of paramecium under microscope' });
    const storyEdg = project.toEdg();
    assert.ok(validateEdg(storyEdg).valid);
    assert.equal(storyEdg.title, 'Microscopic Life');

    // 2. Repurpose Project
    const repurposeDir = path.join(tmpDir, 'repurpose_proj');
    const repurpose = RepurposeProject.create(repurposeDir, {
      source: { type: 'local_file', uri: '/tmp/test_interview.mp4' },
      contentType: 'interview',
      targetPlatforms: ['youtube_shorts'],
    });
    const repurposeEdg = repurpose.toEdg();
    assert.ok(validateEdg(repurposeEdg).valid);
    assert.equal(repurposeEdg.canvas.aspect, '9:16');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


