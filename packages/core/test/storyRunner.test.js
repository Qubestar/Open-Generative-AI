import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Project } from '../src/project.js';
import { stageVoiceover, stageBeats, stageAssemble, stageFinalize } from '../src/storyRunner.js';

const tmpProject = () =>
  Project.create(fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-sr-')), { style: 'doodle-v1' });

const LONG_SCRIPT = Array(1500).fill('word').join(' ');

// Stub pipeline that writes the files a real run would produce.
function stubPipeline() {
  return {
    calls: [],
    async tts(scriptFile, outWav) {
      this.calls.push(['tts', scriptFile, outWav]);
      fs.writeFileSync(outWav, 'WAV');
      return outWav;
    },
    async detectBeats(wav, outJson) {
      this.calls.push(['detectBeats', wav]);
      const doc = {
        audio: wav,
        beats: [
          { idx: 1, id: 's001', start: 0, end: 3, text: 'first beat', image_prompt: '' },
          { idx: 2, id: 's002', start: 3.4, end: 6, text: 'second beat', image_prompt: '' },
        ],
      };
      fs.writeFileSync(outJson, JSON.stringify(doc));
      return doc;
    },
    async assemble(videoDir) {
      this.calls.push(['assemble', videoDir]);
      const out = path.join(videoDir, 'output.mp4');
      fs.writeFileSync(out, 'MP4');
      return { path: out, warning: null };
    },
    async finalize(inMp4, outMp4) {
      this.calls.push(['finalize', inMp4, outMp4]);
      fs.writeFileSync(outMp4, 'MP4-4K');
      return outMp4;
    },
  };
}

async function projectThroughBeats() {
  const p = tmpProject();
  const pipe = stubPipeline();
  p.manifest.script = LONG_SCRIPT;
  p.save();
  await stageVoiceover(p, pipe);
  await stageBeats(p, pipe);
  return { p, pipe };
}

test('voiceover stage writes script.txt, runs tts, records the artifact', async () => {
  const p = tmpProject();
  const pipe = stubPipeline();
  p.manifest.script = LONG_SCRIPT;
  p.save();

  const status = await stageVoiceover(p, pipe);
  assert.equal(status.voiceover, true);
  assert.equal(p.manifest.voiceover.source, 'kokoro');
  assert.ok(fs.existsSync(path.join(p.dir, 'script.txt')));
  assert.equal(status.nextStage, 'beats');
});

test('voiceover stage enforces the script length gate (force overrides)', async () => {
  const p = tmpProject();
  const pipe = stubPipeline();
  p.manifest.script = 'way too short';
  p.save();

  await assert.rejects(stageVoiceover(p, pipe), /under the 1400-word floor/);
  const status = await stageVoiceover(p, pipe, { force: true });
  assert.equal(status.voiceover, true);
});

test('beats stage imports scenes and scaffolds prompts', async () => {
  const { p } = await projectThroughBeats();
  assert.equal(p.manifest.scenes.length, 2);
  assert.ok(p.getScene('s001').prompt.startsWith('Hand-drawn 2D doodle'));
  assert.deepEqual(p.getScene('s002').narrationSpan, [3.4, 6]);
});

test('assemble blocks on unapproved scenes; allowMissing renders a preview', async () => {
  const { p, pipe } = await projectThroughBeats();

  await assert.rejects(stageAssemble(p, pipe), /scenes not approved yet \(s001, s002\)/);

  const status = await stageAssemble(p, pipe, { allowMissing: true });
  assert.equal(status.assemble, true);
  assert.equal(p.manifest.renders[0].preview, true);
});

test('full path: approve images → assemble → finalize', async () => {
  const { p, pipe } = await projectThroughBeats();
  fs.mkdirSync(path.join(p.dir, 'images'), { recursive: true });
  for (const s of p.manifest.scenes) {
    const img = path.join(p.dir, 'images', `${s.id}.png`);
    fs.writeFileSync(img, 'png');
    p.acceptSceneArtifact(s.id, img, { approved: true });
  }

  let status = await stageAssemble(p, pipe);
  assert.equal(p.manifest.renders[0].preview, false);
  assert.equal(status.nextStage, 'finalize');

  status = await stageFinalize(p, pipe);
  assert.equal(status.finalize, true);
  assert.equal(status.nextStage, null);
  assert.ok(fs.existsSync(p.manifest.renders[0].finalPath));
});

test('finalize refuses when only preview renders exist', async () => {
  const { p, pipe } = await projectThroughBeats();
  await stageAssemble(p, pipe, { allowMissing: true });
  await assert.rejects(stageFinalize(p, pipe), /no non-preview render/);
});
