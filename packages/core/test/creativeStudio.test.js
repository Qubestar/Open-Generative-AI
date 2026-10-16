import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  creativeBriefDefaults,
  creativeSectionNumbers,
  mergeCreativeBrief,
} from '../../studio/src/creativeStudioModel.mjs';

test('creative intake step numbers remain contiguous when maps skip image creation', () => {
  assert.deepEqual(creativeSectionNumbers('animation', 'editorial-collage'), {
    style: 1, brief: 2, format: 3, director: 4, imageCreation: 5, reviewStops: 6,
  });
  assert.deepEqual(creativeSectionNumbers('animation', 'documentary-map'), {
    style: 1, brief: 2, format: 3, director: 4, imageCreation: null, reviewStops: 5,
  });
  assert.deepEqual(creativeSectionNumbers('story', 'doodle-v1'), {
    style: null, brief: 1, format: 2, director: 3, imageCreation: 4, reviewStops: 5,
  });
});

test('reopening restores persisted creative choices and source row metadata', () => {
  const restored = mergeCreativeBrief('animation', {
    kind: 'animation', style: 'paper-stop-motion', topic: 'Paper city', details: 'Build upward',
    aspect: '9:16', durationSec: 480, language: 'Polish', voiceProvider: 'elevenlabs',
    provider: { id: 'openrouter', model: 'anthropic/claude-sonnet-4' }, narration: false,
    reviewScript: true, reviewVoiceover: true, imageSource: 'agnes', imageModel: 'agnes-image-2.1-flash',
    sourceSheet: { sheetId: 'sheet-1', tab: 'Queue', row: '14', title: 'Paper city' },
  });

  assert.equal(restored.durationSec, 480);
  assert.equal(restored.aspect, '9:16');
  assert.deepEqual(restored.provider, { id: 'openrouter', model: 'anthropic/claude-sonnet-4' });
  assert.deepEqual(restored.sourceSheet, { sheetId: 'sheet-1', tab: 'Queue', row: '14', title: 'Paper city' });
  assert.equal(restored.reviewScript, true);
  assert.equal(restored.reviewVoiceover, false, 'voice review cannot remain selected when narration is off');
});

test('Story defaults to the local Google Flow hand-off while animations use an automatic source', () => {
  const story = creativeBriefDefaults('story');
  const animation = creativeBriefDefaults('animation');
  assert.equal(story.imageSource, 'flow');
  assert.equal(story.imageModel, '');
  assert.ok(animation.imageSource);
  assert.ok(animation.imageModel);
  assert.equal(story.style, 'doodle-v1');
});

test('creative briefs preserve a selected Voicebox profile across reopen', () => {
  const restored = mergeCreativeBrief('story', {
    voiceProvider: 'voicebox',
    voiceboxVoiceId: 'voice-polish-1',
    narration: true,
  });
  assert.equal(restored.voiceProvider, 'voicebox');
  assert.equal(restored.voiceboxVoiceId, 'voice-polish-1');
});


test('Kokoro defaults and selected voice survive reopening a Story brief', () => {
  assert.equal(creativeBriefDefaults('story').kokoroVoiceId, 'am_onyx');
  assert.equal(mergeCreativeBrief('story', {}).kokoroVoiceId, 'am_onyx');
  assert.equal(mergeCreativeBrief('story', { kokoroVoiceId: 'af_heart' }).kokoroVoiceId, 'af_heart');
});
