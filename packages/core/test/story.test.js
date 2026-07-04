import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Project } from '../src/project.js';
import {
  DOODLE_STYLE, getStyle, buildImagePrompt, validateScript,
  importBeats, scaffoldPrompts, stageStatus,
} from '../src/story.js';

const tmpProject = () =>
  Project.create(fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-story-')), { style: 'doodle-v1' });

// Matches the real detect_beats.py output shape (ids are sNNN from the pipeline).
const beatsDoc = {
  audio: '/videos/01-test/voiceover.wav',
  beats: [
    { idx: 1, id: 's001', start: 0.0, end: 4.1, dur: 4.1, text: 'You wake up at 2am.', image_prompt: '' },
    { idx: 2, id: 's002', start: 4.6, end: 9.2, dur: 4.6, text: 'Your brain thinks it is protecting you.', image_prompt: '' },
    { idx: 3, id: 's003', start: 9.8, end: 14.0, dur: 4.2, text: 'A named study explains why.', image_prompt: 'custom prompt kept' },
  ],
};

test('getStyle resolves doodle-v1 and rejects unknown styles', () => {
  assert.equal(getStyle('doodle-v1').voice, 'am_onyx');
  assert.throws(() => getStyle('claymation-v9'), /Unknown story style/);
});

test('buildImagePrompt = anchor + scene + lock, verbatim style strings', () => {
  const p = buildImagePrompt('a stick figure sitting up in bed, alarmed dot eyes, dark blue background');
  assert.ok(p.startsWith(DOODLE_STYLE.promptAnchor));
  assert.ok(p.endsWith(DOODLE_STYLE.promptLock));
  assert.ok(p.includes('stick figure sitting up in bed'));
  assert.throws(() => buildImagePrompt('   '), /scene description is empty/);
});

test('validateScript enforces the 1,400-word floor', () => {
  const short = validateScript('too short to ship');
  assert.equal(short.ok, false);
  assert.match(short.hint, /under the 1400-word floor/);
  const long = validateScript(Array(1500).fill('word').join(' '));
  assert.equal(long.ok, true);
  assert.equal(long.hint, null);
});

test('importBeats maps beats 1:1 onto sNNN scenes with narration spans', () => {
  const p = tmpProject();
  const scenes = importBeats(p, beatsDoc);
  assert.equal(scenes.length, 3);
  assert.deepEqual(p.getScene('s002').narrationSpan, [4.6, 9.2]);
  assert.equal(p.getScene('s001').beat, 'You wake up at 2am.');
  assert.equal(p.getScene('s003').prompt, 'custom prompt kept');
  assert.equal(p.manifest.voiceover.artifact, beatsDoc.audio);
  // Durable: survives reload.
  assert.deepEqual(Project.load(p.dir).getScene('s002').narrationSpan, [4.6, 9.2]);
});

test('importBeats refuses non-empty projects and drifted ids', () => {
  const p = tmpProject();
  importBeats(p, beatsDoc);
  assert.throws(() => importBeats(p, beatsDoc), /already has scenes/);

  const drifted = tmpProject();
  assert.throws(
    () => importBeats(drifted, { beats: [{ id: 's005', start: 0, end: 1, text: 'x' }] }),
    /id drift/,
  );
});

test('scaffoldPrompts fills only empty prompts from beat text', () => {
  const p = tmpProject();
  importBeats(p, beatsDoc);
  const filled = scaffoldPrompts(p);
  assert.deepEqual(filled, ['s001', 's002']); // s003 kept its custom prompt
  assert.ok(p.getScene('s001').prompt.startsWith(DOODLE_STYLE.promptAnchor));
  assert.equal(p.getScene('s003').prompt, 'custom prompt kept');
});

test('stageStatus walks the pipeline in order', () => {
  const p = tmpProject();
  assert.equal(stageStatus(p).nextStage, 'script');

  p.manifest.script = 'the full narration text';
  p.save();
  assert.equal(stageStatus(p).nextStage, 'voiceover');

  importBeats(p, beatsDoc); // sets voiceover artifact + scenes
  assert.equal(stageStatus(p).nextStage, 'prompts');

  scaffoldPrompts(p);
  assert.equal(stageStatus(p).nextStage, 'images');

  for (const s of p.manifest.scenes) {
    const img = path.join(p.dir, `${s.id}.png`);
    fs.writeFileSync(img, 'png');
    p.acceptSceneArtifact(s.id, img, { approved: true });
  }
  assert.equal(stageStatus(p).nextStage, 'assemble');

  p.manifest.renders.push({ path: path.join(p.dir, 'output.mp4'), finalized: false });
  p.save();
  assert.equal(stageStatus(p).nextStage, 'finalize');

  p.manifest.renders[0].finalized = true;
  p.save();
  assert.equal(stageStatus(p).nextStage, null);
});
