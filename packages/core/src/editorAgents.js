// Editor "brain" — the optional semantic layer.
//
// V1 renders with zero AI: probe → prepare → transcribe (local Whisper) → assets →
// deterministic planner → HyperFrames → mix → finish. The planner, however, can only
// rotate the material it finds; it cannot know that "the harbour" should show the
// harbour. That choice is what a language model is good at, so the Editor exposes a
// brain:
//
//   brain.mode = 'none'   → deterministic V1 (default, no agent, no network)
//   brain.mode = 'local'  → one of the agent CLIs the user already has installed and
//                           logged in on this machine
//
// There is deliberately no API-key path: the Editor never touches the Direct API keys
// configured for image/video generation. The agent runs as the user's own CLI, in a
// scratch folder, with a prompt built from the transcript and the footage inventory.
//
// Everything here is pure Node ESM and injectable, so tests never spawn an agent.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// ── Adapters ────────────────────────────────────────────────────────────────
// Each entry is one CLI in its one-shot (non-interactive) form. `args(prompt)` must
// print the model's answer on stdout and exit. Nothing here reads or writes the
// user's credentials: the CLIs authenticate themselves.

export const EDITOR_AGENT_ADAPTERS = [
  {
    id: 'opencode',
    label: 'OpenCode',
    cli: 'opencode',
    args: prompt => ['run', prompt],
    env: {},
    note: 'Uses the model OpenCode is configured with (e.g. opencode-go/deepseek).',
  },
  {
    id: 'hermes',
    label: 'Hermes',
    cli: 'hermes',
    args: prompt => ['chat', '-q', prompt, '-Q', '--format', 'text'],
    env: {},
    note: 'Runs one Hermes chat turn and prints only the answer.',
  },
  {
    id: 'codex',
    label: 'Codex',
    cli: 'codex',
    args: prompt => ['exec', '--skip-git-repo-check', prompt],
    env: {},
    note: 'Requires a Codex login whose configured model your account supports.',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    cli: 'gemini',
    args: prompt => ['-p', prompt],
    env: { GEMINI_CLI_TRUST_WORKSPACE: 'true' },
    note: 'Headless Gemini CLI, trusted workspace set for this run only.',
  },
  {
    id: 'claude_code',
    label: 'Claude Code',
    cli: 'claude',
    args: prompt => ['-p', prompt, '--output-format', 'text'],
    env: {},
    note: 'Uses the Claude Code subscription already signed in on this machine.',
  },
];

const ADAPTER_BY_ID = new Map(EDITOR_AGENT_ADAPTERS.map(adapter => [adapter.id, adapter]));
const MAX_PROMPT_BEATS = 120;
const MAX_BRIEF_ASSETS = 200;
const DEFAULT_TIMEOUT_MS = 180 * 1000;

export function editorAgentAdapter(id) {
  const normalized = String(id || '').trim().toLowerCase();
  const found = ADAPTER_BY_ID.get(normalized);
  if (!found) throw new Error(`Unknown editor agent: ${id}`);
  return found;
}

/** Resolve a CLI through the user's login shell so nvm/local installs are visible. */
export function resolveAgentBinary(cli, { shell = true } = {}) {
  try {
    const command = shell ? ['-lc', `command -v ${cli}`] : ['-c', `command -v ${cli}`];
    const result = spawnSync('/bin/sh', command, { encoding: 'utf8', timeout: 8000 });
    const line = String(result.stdout || '').trim().split('\n').filter(Boolean).pop();
    return line && fs.existsSync(line) ? line : null;
  } catch { return null; }
}

/** Which brains this machine can actually offer right now. */
export function detectEditorAgents({ resolve = resolveAgentBinary, adapters = EDITOR_AGENT_ADAPTERS } = {}) {
  return adapters.map(adapter => {
    const binary = resolve(adapter.cli);
    return {
      id: adapter.id,
      label: adapter.label,
      cli: adapter.cli,
      path: binary,
      available: Boolean(binary),
      note: adapter.note,
    };
  });
}

// ── Prompt ──────────────────────────────────────────────────────────────────

/**
 * The brief is deliberately small and closed: the model may only choose among the
 * files that exist and the words that were said. Everything else stays deterministic.
 */
export function buildBrainBrief({ plan = {}, assets = {}, options = {}, style = {} } = {}) {
  const inventory = [
    ...(Array.isArray(assets.clips) ? assets.clips : []).map(item => ({ kind: 'clip', name: path.basename(item.path || item.asset || ''), asset: item.asset })),
    ...(Array.isArray(assets.stills) ? assets.stills : []).map(item => ({ kind: 'still', name: path.basename(item.path || item.asset || ''), asset: item.asset })),
  ].filter(entry => entry.asset).slice(0, MAX_BRIEF_ASSETS);

  const beats = (Array.isArray(plan.beats) ? plan.beats : []).slice(0, MAX_PROMPT_BEATS).map((beat, index) => ({
    beat: index,
    t: [Number(beat.t0) || 0, Number(beat.t1) || 0],
    device: beat.device,
    line: (beat.caption || []).map(entry => entry[0]).join(' '),
    asset: beat.asset ? path.basename(beat.asset) : null,
  }));

  const system = [
    'You are the picture editor for a fast documentary-style edit.',
    'You get the beats of an already-timed edit (the timing is fixed and not yours to change)',
    'and the inventory of footage the user owns. For each beat you decide which real file',
    'best illustrates the words being said at that moment. Prefer a clip over a still when',
    'the line describes an action, and a still when it names a thing, a place or a number.',
    'You may also turn a material beat into the speaker ("face") and you may mark one',
    'stressed word per beat for the big keyword.',
    '',
    'Answer with ONE minified JSON object and nothing else, exactly this shape:',
    '{"picks":[{"beat":0,"asset":"<file name from the inventory>"}],',
    ' "face":[0,7],"keywords":[{"beat":3,"text":"HARBOUR","kind":"key|title|shock"}]}',
    '',
    'Rules:',
    '- "beat" is the index from the list below.',
    '- Give a pick for EVERY beat whose device is not "face": those beats need a picture, and your',
    '  choice replaces the one shown as "now:". An empty picks list is only correct when the',
    '  inventory is empty. Face beats need no pick.',
    '- "asset" must be a file name that appears in the inventory, verbatim.',
    '- Never invent footage: the file name must be copied exactly from the inventory.',
    '- Spread the inventory: do not send the same file to two neighbouring beats when you have a choice.',
    '- At most one keyword per beat, uppercase, one or two words, only words that were said.',
    '- "face" only for beats whose device is currently a picture, never two in a row.',
    `- Style: about ${Math.round(Number(style.cut_median_s || 0.79) * 100) / 100}s per picture, speaker share ~${Math.round((Number(options.face_share ?? style.face_share ?? 0.3)) * 100)}%.`,
  ].join('\n');

  const body = [
    `BEATS (${beats.length}):`,
    ...beats.map(beat => `${beat.beat}\t${beat.t[0].toFixed(2)}-${beat.t[1].toFixed(2)}\t${beat.device}\t${beat.line || '(no words)'}\tnow: ${beat.asset || '-'}`),
    '',
    `INVENTORY (${inventory.length}):`,
    ...inventory.map(item => `${item.kind}\t${item.name}`),
  ].join('\n');

  return { system, body, prompt: `${system}\n\n${body}`, inventory, beats };
}

// ── Response ────────────────────────────────────────────────────────────────

/** Pull the first JSON object out of whatever banner text the CLI printed. */
export function extractJsonBlock(text) {
  const source = String(text || '');
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  const candidate = source.slice(start, end + 1);
  try { return JSON.parse(candidate); } catch { /* fall through to a balanced scan */ }
  let depth = 0;
  let begin = -1;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') { if (depth === 0) begin = index; depth += 1; }
    else if (char === '}') {
      depth -= 1;
      if (depth === 0 && begin !== -1) {
        try { return JSON.parse(source.slice(begin, index + 1)); } catch { begin = -1; }
      }
    }
  }
  return null;
}

/**
 * Validate the agent's answer against what actually exists. Anything that does not
 * check out is dropped with a reason, so a creative-but-wrong model can never put a
 * missing file into the render.
 */
export function parseBrainPicks(raw, { plan = {}, assets = {} } = {}) {
  const parsed = typeof raw === 'string' ? extractJsonBlock(raw) : raw;
  const beats = Array.isArray(plan.beats) ? plan.beats : [];
  const inventory = new Set([
    ...(Array.isArray(assets.clips) ? assets.clips : []).map(item => path.basename(item.asset || item.path || '')),
    ...(Array.isArray(assets.stills) ? assets.stills : []).map(item => path.basename(item.asset || item.path || '')),
  ].filter(Boolean));
  const assetByBase = new Map();
  for (const group of ['clips', 'stills']) {
    for (const item of Array.isArray(assets[group]) ? assets[group] : []) {
      const base = path.basename(item.asset || item.path || '');
      if (base) assetByBase.set(base, item.asset);
    }
  }

  const rejected = [];
  const picks = [];
  const face = [];
  const keywords = [];
  if (!parsed || typeof parsed !== 'object') {
    return { picks, face, keywords, rejected: [{ reason: 'the agent did not answer with JSON' }], answered: false };
  }

  for (const entry of Array.isArray(parsed.picks) ? parsed.picks : []) {
    const index = Number(entry?.beat);
    const name = path.basename(String(entry?.asset || ''));
    if (!Number.isInteger(index) || index < 0 || index >= beats.length) { rejected.push({ entry, reason: 'beat out of range' }); continue; }
    if (!name || !inventory.has(name)) { rejected.push({ entry, reason: 'asset is not in the footage folder' }); continue; }
    if (beats[index].device === 'face') { rejected.push({ entry, reason: 'that beat is the speaker' }); continue; }
    picks.push({ beat: index, asset: assetByBase.get(name), name });
  }

  const seenFace = new Set();
  for (const value of Array.isArray(parsed.face) ? parsed.face : []) {
    const index = Number(value);
    if (!Number.isInteger(index) || index < 0 || index >= beats.length) { rejected.push({ entry: value, reason: 'face beat out of range' }); continue; }
    if (beats[index].device === 'face') continue;
    if (seenFace.has(index)) continue;
    seenFace.add(index);
    face.push(index);
  }
  face.sort((a, b) => a - b);
  for (let index = 0; index < face.length; index += 1) {
    const current = face[index];
    const previous = face[index - 1];
    if (previous !== undefined && Math.abs(previous - current) === 1) {
      rejected.push({ entry: current, reason: 'two face beats in a row' });
      face.splice(index, 1);
      index -= 1;
    }
  }

  for (const entry of Array.isArray(parsed.keywords) ? parsed.keywords : []) {
    const index = Number(entry?.beat);
    const text = String(entry?.text || '').trim().toUpperCase();
    const kind = ['key', 'title', 'shock'].includes(String(entry?.kind || '')) ? String(entry.kind) : 'key';
    if (!Number.isInteger(index) || index < 0 || index >= beats.length) { rejected.push({ entry, reason: 'keyword beat out of range' }); continue; }
    if (!text || text.length > 40 || text.split(/\s+/).length > 2) { rejected.push({ entry, reason: 'keyword must be one or two words' }); continue; }
    const said = (beats[index].caption || []).map(item => String(item[0] || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''));
    const wanted = text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (said.length && !said.includes(wanted)) { rejected.push({ entry, reason: 'that word was not said in the beat' }); continue; }
    keywords.push({ beat: index, text, kind });
  }

  return { picks, face, keywords, rejected, answered: true };
}

/** Apply a validated answer to the plan. Returns what actually changed. */
export function applyBrainPicks(plan, { picks = [], face = [], keywords = [] } = {}) {
  const beats = Array.isArray(plan?.beats) ? plan.beats : [];
  const applied = { assets: 0, face: 0, keywords: 0 };
  for (const pick of picks) {
    const beat = beats[pick.beat];
    if (!beat || !pick.asset) continue;
    const isClip = /\.(mp4|mov|mkv|webm|m4v)$/i.test(String(pick.asset));
    if (isClip) {
      beat.device = 'broll';
      beat.media_start = Number(beat.media_start) || 0;
      beat.rate = Number(beat.rate) || 0.06;
    } else if (['broll', 'seq', 'strobe', 'wall3d', 'pop_collage'].includes(beat.device)) {
      beat.device = 'still';
    }
    beat.asset = pick.asset;
    delete beat.assets;
    applied.assets += 1;
  }
  for (const index of face) {
    const beat = beats[index];
    if (!beat || beat.device === 'face') continue;
    beat.device = 'face';
    delete beat.asset;
    delete beat.assets;
    applied.face += 1;
  }
  for (const keyword of keywords) {
    const beat = beats[keyword.beat];
    if (!beat) continue;
    const said = (beat.caption || []).find(item => String(item[0] || '').toUpperCase().replace(/[^\p{L}\p{N}]/gu, '') === keyword.text.replace(/[^\p{L}\p{N}]/gu, ''));
    beat.keyword = { text: keyword.text, kind: keyword.kind, at: Number(said?.[1] ?? beat.t0) + 0.12 };
    applied.keywords += 1;
  }
  return applied;
}

// ── The call ────────────────────────────────────────────────────────────────

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

export function cleanAgentOutput(text) {
  return String(text || '').replace(ANSI, '').replace(/\r/g, '');
}

/**
 * Run one headless agent turn. `run` is injected in tests; the default spawns the CLI
 * through the login shell (so the user's PATH applies) with the prompt as an argument.
 */
export async function askEditorAgent({
  agentId,
  prompt,
  workDir = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal = null,
  run = null,
} = {}) {
  const adapter = editorAgentAdapter(agentId);
  const binary = resolveAgentBinary(adapter.cli);
  if (!binary) throw new Error(`${adapter.label} is not installed on this machine.`);
  const dir = workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-brain-'));
  fs.mkdirSync(dir, { recursive: true });

  if (typeof run === 'function') {
    const output = await run({ adapter, binary, prompt, workDir: dir, timeoutMs, signal });
    return { text: cleanAgentOutput(output), adapter, workDir: dir };
  }

  const args = adapter.args(prompt);
  const env = { ...process.env, ...adapter.env, NO_COLOR: '1', TERM: 'dumb' };
  const text = await new Promise((resolve, reject) => {
    const child = spawnSync(binary, args, {
      cwd: dir, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
    });
    if (child.error) {
      if (child.error.code === 'ETIMEDOUT') { reject(new Error(`${adapter.label} did not answer within ${Math.round(timeoutMs / 1000)}s.`)); return; }
      reject(child.error);
      return;
    }
    const output = `${child.stdout || ''}${child.stderr ? `\n${child.stderr}` : ''}`;
    if (child.status !== 0 && !extractJsonBlock(output)) {
      reject(new Error(`${adapter.label} exited with ${child.status}: ${cleanAgentOutput(output).trim().slice(-300)}`));
      return;
    }
    resolve(output);
  });
  return { text: cleanAgentOutput(text), adapter, workDir: dir };
}

/** One call that goes from "the plan exists" to "the plan reflects the agent's choices". */
export async function runBrainPass({ agentId, plan, assets, options = {}, style = {}, workDir = null, run = null, timeoutMs = DEFAULT_TIMEOUT_MS, signal = null } = {}) {
  const brief = buildBrainBrief({ plan, assets, options, style });
  const started = Date.now();
  const { text, adapter, workDir: usedDir } = await askEditorAgent({ agentId, prompt: brief.prompt, workDir, run, timeoutMs, signal });
  const picks = parseBrainPicks(text, { plan, assets });
  const applied = picks.answered ? applyBrainPicks(plan, picks) : { assets: 0, face: 0, keywords: 0 };
  return {
    agent: adapter.id,
    label: adapter.label,
    work_dir: usedDir,
    duration_ms: Date.now() - started,
    answered: picks.answered,
    applied,
    rejected: picks.rejected.slice(0, 20),
    preview: text.trim().slice(0, 1200),
  };
}
