// Story stage executors — glue between the Project manifest (state), the
// story module (pure logic), and the DoodlePipeline (execution). Each stage
// validates its preconditions, runs, updates the manifest, and returns the
// new stageStatus so callers (UI/CLI/MCP) always see the same progress.
//
// File conventions inside a project dir (assemble.py's native layout):
//   script.txt · voiceover.wav · beats.json · images/sNNN.png · output.mp4

import fs from 'node:fs';
import path from 'node:path';
import { getStyle, validateScript, importBeats, scaffoldPrompts, stageStatus } from './story.js';

// `ttsOverride(scriptFile, outWav)` lets the caller swap the voice engine
// (e.g. ElevenLabs in the desktop bridge); default is the pipeline's local
// Kokoro. `source` is recorded on the manifest for provenance.
export async function stageVoiceover(project, pipeline, { force = false, source = 'kokoro', ttsOverride = null } = {}) {
  const m = project.manifest;
  if (!m.script) throw new Error('voiceover stage: manifest.script is empty — write the script first');
  const style = getStyle(m.style);
  const check = validateScript(m.script, style);
  if (!check.ok && !force) {
    throw new Error(`voiceover stage blocked: ${check.hint} (pass force:true to override)`);
  }
  const scriptFile = path.join(project.dir, 'script.txt');
  const outWav = path.join(project.dir, 'voiceover.wav');
  fs.writeFileSync(scriptFile, m.script);
  if (ttsOverride) {
    await ttsOverride(scriptFile, outWav);
    if (!fs.existsSync(outWav)) throw new Error(`voiceover (${source}) produced no file`);
  } else {
    await pipeline.tts(scriptFile, outWav, { voice: style.voice });
  }
  m.voiceover = { ...m.voiceover, source, artifact: outWav };
  project.save();
  return stageStatus(project);
}

export async function stageBeats(project, pipeline) {
  const wav = project.manifest.voiceover.artifact;
  if (!wav || !fs.existsSync(wav)) throw new Error('beats stage: no voiceover.wav yet — run the voiceover stage first');
  const outJson = path.join(project.dir, 'beats.json');
  const beatsDoc = await pipeline.detectBeats(wav, outJson);
  importBeats(project, beatsDoc);        // one scene per beat, sNNN drift-checked
  scaffoldPrompts(project);              // fill empty prompts from beat text
  return stageStatus(project);
}

// Assembly requires every scene image accepted AND approved (the human/VLM
// gate), unless the caller explicitly allows white placeholder frames.
export async function stageAssemble(project, pipeline, { allowMissing = false } = {}) {
  const status = stageStatus(project);
  if (!status.beats) throw new Error('assemble stage: no scenes yet — run the beats stage first');
  if (!status.images && !allowMissing) {
    const pending = project.pendingScenes().map(s => s.id).join(', ');
    throw new Error(`assemble stage blocked: scenes not approved yet (${pending}). Pass allowMissing:true for a white-frame preview render.`);
  }
  const { path: out, warning } = await pipeline.assemble(project.dir);
  project.manifest.renders.push({
    path: out,
    finalized: false,
    preview: !status.images,
    warning,
    at: new Date().toISOString(),
  });
  project.save();
  return stageStatus(project);
}

export async function stageFinalize(project, pipeline, { outName = null, no4k = false } = {}) {
  const render = [...project.manifest.renders].reverse().find(r => !r.finalized && !r.preview);
  if (!render) throw new Error('finalize stage: no non-preview render to finalize — run assemble first');
  const out = path.join(project.dir, outName || 'final.mp4');
  await pipeline.finalize(render.path, out, { no4k });
  render.finalized = true;
  render.finalPath = out;
  project.save();
  return stageStatus(project);
}
