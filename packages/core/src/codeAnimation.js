// A separate renderer: existing image pipelines never enter this module.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { animationStyle } from './animationCatalog.js';
import { creativeFingerprint } from './animation.js';

export const CODE_FRAME_CONTRACT = `Return JSON {"html":"<!doctype html>..."}. Create a complete, original, self-contained HTML film using Canvas 2D, inline SVG, CSS or raw WebGL. No external URLs, scripts, fonts, imports, fetch, audio, timers or requestAnimationFrame. Implement async window.renderFrame(timeSeconds), which draws the entire frame deterministically at any time, including out-of-order seeks. Use the exact supplied width, height, duration and narration beats. All positions/motion must be functions of time, with stable seeded randomness. Illustrate the subject with real actions and visual storytelling; avoid generic title cards. Keep type readable within safe margins. The host supplies voiceover separately. Assets must be inline data URIs or drawn in code. The browser is offline, in an opaque-origin sandbox. Do not navigate or open windows.`;

export function validateCodeAnimation(value) {
  if (!value || typeof value.html !== 'string' || value.html.length < 100 || Buffer.byteLength(value.html) > 2 * 1024 * 1024) throw new Error('Code animation requires 100 bytes to 2 MB of self-contained HTML.');
  if (!/renderFrame/.test(value.html)) throw new Error('Code animation must implement window.renderFrame(timeSeconds).');
  return { version: 1, html: value.html };
}

function atomic(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function codeAnimationTask(brief, { durationSec, beats = [], script = '' }) {
  const style = animationStyle(brief.style);
  if (style.engine !== 'code') throw new Error('Choose a code animation style.');
  const guide = fs.readFileSync(fileURLToPath(new URL(`../assets/animation-guides/${style.id}.md`, import.meta.url)), 'utf8').slice(0, 35000);
  const [width, height] = brief.aspect === '9:16' ? [1080, 1920] : [1920, 1080];
  return { contract: CODE_FRAME_CONTRACT, style: { number: style.number, name: style.name, guide }, topic: brief.topic, details: brief.details, language: brief.language, width, height, durationSec, script, beats };
}

export async function produceCodeAnimation({ project, durationSec, beats = [], direct, run, setState, signal, renderer = null }) {
  const { manifest, dir } = project;
  const task = codeAnimationTask(manifest.brief, { durationSec, beats, script: manifest.script });
  const fingerprint = creativeFingerprint(task);
  const codeFile = path.join(dir, 'artifacts', 'code-animation.json');
  let code;
  if (manifest.production.codeFingerprint === fingerprint && fs.existsSync(codeFile)) code = validateCodeAnimation(JSON.parse(fs.readFileSync(codeFile, 'utf8')));
  else {
    setState('planning', 'Writing animation code to the voiceover timing');
    code = validateCodeAnimation(await direct(task));
    signal?.throwIfAborted();
    fs.mkdirSync(path.dirname(codeFile), { recursive: true });
    atomic(codeFile, code);
    manifest.production.codeFingerprint = fingerprint;
    project.save();
  }
  signal?.throwIfAborted();
  setState('rendering', 'Rendering code animation locally');
  const output = path.join(dir, 'code-animation.mp4');
  const settings = { renderToken: crypto.randomUUID(), width: task.width, height: task.height, durationSec, fps: 30, codeFile, output,
    voice: manifest.voiceover?.artifact ? path.resolve(dir, manifest.voiceover.artifact) : null };
  if (settings.voice && !fs.realpathSync(settings.voice).startsWith(fs.realpathSync(dir) + path.sep)) throw new Error('Narration must stay inside the animation project.');
  const request = path.join(dir, 'artifacts', 'code-render.json');
  const evidenceFile = path.join(dir, 'artifacts', 'code-render-evidence.json');
  fs.rmSync(evidenceFile, { force: true });
  atomic(request, settings);
  if (renderer) await renderer(settings);
  else await run(process.execPath, [fileURLToPath(new URL('../pipelines/code-animation/render.mjs', import.meta.url)), request]);
  signal?.throwIfAborted();
  if (!fs.existsSync(output) || fs.statSync(output).size < 100) throw new Error('Code renderer produced no usable MP4.');
  if (!fs.existsSync(evidenceFile)) throw new Error('Code renderer produced no verification evidence.');
  const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
  if (!evidence.ok || evidence.exitCode !== 0 || evidence.renderToken !== settings.renderToken || Math.abs(evidence.durationSec - durationSec) > 0.2 || (settings.voice && !evidence.audio)) throw new Error('Code animation output did not match the requested timing/audio.');
  manifest.production.output = 'code-animation.mp4';
  manifest.production.renderFingerprint = fingerprint;
  manifest.production.planFingerprint = fingerprint;
  manifest.production.assetsDone = true;
  manifest.renders.push({ path: 'code-animation.mp4', finalPath: 'code-animation.mp4', finalized: true, width: task.width, height: task.height, fps: settings.fps, frames: Math.ceil(durationSec * settings.fps), at: new Date().toISOString() });
  setState('done', 'Your narrated animation is ready');
  return { output, evidence };
}
