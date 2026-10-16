import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectBestTakes,
  classifyAudioGaps,
  calculatePunchInZooms,
  computeSidechainDucking,
  PADDING_PRESETS_MS,
} from '../src/autoEditor.js';

test('selectBestTakes selects highest scoring repeated take', () => {
  const takes = [
    { text: 'Hello everyone today we look at AI', fluencyScore: 0.6, isCompleteSentence: false, stumbleCount: 1, vocalConfidence: 0.5 },
    { text: 'Hello everyone, today we look at AI.', fluencyScore: 0.95, isCompleteSentence: true, stumbleCount: 0, vocalConfidence: 0.9 },
    { text: 'Hello everyone today we... look at AI', fluencyScore: 0.7, isCompleteSentence: true, stumbleCount: 1, vocalConfidence: 0.7 },
  ];

  const result = selectBestTakes(takes);
  assert.equal(result.length, 1);
  assert.ok(result[0].isBestTake);
  assert.equal(result[0].fluencyScore, 0.95);
  assert.equal(result[0].alternateTakes.length, 2);
});

test('classifyAudioGaps distinguishes dead silence and breaths from filler words', () => {
  const vadSegments = [
    { startSec: 1.0, endSec: 1.5, isBreath: false },
    { startSec: 3.0, endSec: 3.2, isBreath: true },
  ];
  const asrTokens = [
    { word: 'welcome', startSec: 0.5, endSec: 0.9 },
    { word: 'ummm', startSec: 1.6, endSec: 1.9 },
    { word: 'today', startSec: 2.0, endSec: 2.4 },
  ];

  const cuts = classifyAudioGaps({ vadSegments, asrTokens });
  assert.equal(cuts.length, 3);

  const deadSilence = cuts.find(c => c.type === 'dead_silence');
  assert.ok(deadSilence);
  assert.equal(deadSilence.action, 'cut');

  const breath = cuts.find(c => c.type === 'breath');
  assert.ok(breath);
  assert.equal(breath.paddingMs, PADDING_PRESETS_MS.SPEECH_BREATH_SPEECH.default);

  const filler = cuts.find(c => c.type === 'filler_word');
  assert.ok(filler);
  assert.equal(filler.action, 'remove_token');
});

test('calculatePunchInZooms triggers on semantic events and guards against stagnation', () => {
  const clips = [
    { startSec: 0, endSec: 3, isTopicTransition: true },
    { startSec: 3, endSec: 7 },
    { startSec: 7, endSec: 12 }, // Exceeds stagnation threshold from start
  ];

  const zooms = calculatePunchInZooms(clips);
  assert.equal(zooms.length, 3);
  assert.equal(zooms[0].triggeredBy, 'topic');
  assert.ok(zooms[0].zoomLevel > 1.0);
  assert.equal(zooms[2].triggeredBy, 'stagnation_safeguard');
});

test('computeSidechainDucking generates attack and release envelope keyframes', () => {
  const voice = [{ startSec: 2.0, endSec: 5.0 }];
  const ducking = computeSidechainDucking(voice, 10.0);
  assert.equal(ducking.length, 4);
  assert.equal(ducking[0].volumeDb, 0);
  assert.equal(ducking[1].volumeDb, -18);
  assert.equal(ducking[2].volumeDb, -18);
  assert.equal(ducking[3].volumeDb, 0);
});
