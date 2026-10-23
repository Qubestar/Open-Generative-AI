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
import { spawn, spawnSync } from 'node:child_process';

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
    // The account decides which models exist: try the ChatGPT-account ids in order and
    // keep the first that answers. A workspace model in config.toml must not break this.
    args: (prompt, { model = null } = {}) => ['exec', '--skip-git-repo-check', ...(model ? ['-m', model] : []), prompt],
    env: {},
    models: ['gpt-5.1-codex', 'gpt-5-codex', 'o4-mini'],
    statusArgs: ['login', 'status'],
    statusParse: stdout => /logged in/i.test(stdout) ? true : (/not logged in|logged out/i.test(stdout) ? false : null),
    note: 'Uses the ChatGPT/Codex login already on this machine.',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    cli: 'gemini',
    args: prompt => ['-p', prompt],
    env: { GEMINI_CLI_TRUST_WORKSPACE: 'true' },
    statusParse: null,
    note: 'Headless Gemini CLI, trusted workspace set for this run only.',
  },
  {
    id: 'claude_code',
    label: 'Claude Code',
    cli: 'claude',
    args: prompt => ['-p', prompt, '--output-format', 'text'],
    env: {},
    statusArgs: ['auth', 'status'],
    statusParse: stdout => {
      try { const value = JSON.parse(stdout); return Boolean(value?.loggedIn); } catch { return null; }
    },
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


/**
 * Turn a CLI's own error into one sentence a person can act on. Vidmyo never asks for
 * configuration; it only says what the agent itself reports.
 */
export function humanizeAgentReason(id, reason) {
  const text = String(reason || '');
  if (!text) return null;
  if (/OAuth session expired|Failed to authenticate|not logged in|logged out/i.test(text)) {
    return 'Not signed in on this machine. Open the app once and sign in; Vidmyo then picks it up automatically.';
  }
  if (/not supported when using Codex with a ChatGPT account/i.test(text)) {
    return 'This ChatGPT plan has no Codex model access, so the CLI refuses every model.';
  }
  if (/IneligibleTierError|Gemini Code Assist for individuals|migrate to the Antigravity/i.test(text)) {
    return 'Google no longer supports this Gemini CLI build for personal accounts.';
  }
  if (/did not answer within/i.test(text)) {
    return 'It did not answer in time — the agent may be busy or offline.';
  }
  if (/not installed/i.test(text)) return 'Not installed on this machine.';
  if (/exceeded skills context budget/i.test(text)) return 'Its own skill folder is too large for this model.';
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

// ── The call ────────────────────────────────────────────────────────────────


/**
 * Run a CLI without ever blocking the main process. `spawnSync` here froze the whole
 * Electron UI for the length of the agent's answer — the beachball Luke saw.
 */
function runProcess(binary, args, { cwd = null, env = {}, timeoutMs = DEFAULT_TIMEOUT_MS, signal = null, label = 'agent' } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { reject(error); return; }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const cap = 32 * 1024 * 1024;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener?.('abort', onAbort);
      fn(value);
    };
    const kill = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
    const timer = setTimeout(() => { kill(); finish(reject, new Error(`${label} did not answer within ${Math.round(timeoutMs / 1000)}s.`)); }, timeoutMs);
    const onAbort = () => { kill(); finish(reject, new Error(`${label} was cancelled.`)); };
    if (signal) {
      if (signal.aborted) { kill(); finish(reject, new Error(`${label} was cancelled.`)); return; }
      signal.addEventListener?.('abort', onAbort, { once: true });
    }
    child.stdout?.on('data', chunk => { stdout = (stdout + chunk).slice(-cap); });
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-cap); });
    child.on('error', error => { finish(reject, error); });
    child.on('close', code => { finish(resolve, { code, stdout, stderr }); });
  });
}

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
  model = null,
} = {}) {
  const adapter = editorAgentAdapter(agentId);
  const binary = resolveAgentBinary(adapter.cli);
  if (!binary) throw new Error(`${adapter.label} is not installed on this machine.`);
  const dir = workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-brain-'));
  fs.mkdirSync(dir, { recursive: true });

  if (typeof run === 'function') {
    const output = await run({ adapter, binary, prompt, workDir: dir, timeoutMs, signal, model });
    return { text: cleanAgentOutput(output), adapter, workDir: dir };
  }

  const args = adapter.args(prompt, { model });
  const env = { ...process.env, ...adapter.env, NO_COLOR: '1', TERM: 'dumb' };
  const child = await runProcess(binary, args, { cwd: dir, env, timeoutMs, signal, label: adapter.label });
  const output = `${child.stdout || ''}${child.stderr ? `\n${child.stderr}` : ''}`;
  if (child.code !== 0 && !extractJsonBlock(output)) {
    // Keep the head of the message: CLIs put the reason (e.g. IneligibleTierError)
    // before the stack trace, and the humaniser needs to see it.
    throw new Error(`${adapter.label} exited with ${child.code}: ${cleanAgentOutput(output).trim().slice(0, 600)}`);
  }
  return { text: cleanAgentOutput(output), adapter, workDir: dir };
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

// ── Connection status ───────────────────────────────────────────────────────
// "Connected" must mean proven, not assumed: a cheap status command first, then one
// real one-line turn. The answer is cached so opening the tab is instant.
//
// Vidmyo never asks the user to paste a key or authorise anything in this tab: an
// agent that works is one this machine is already signed in to.

const PROBE_TTL_MS = 10 * 60 * 1000;
const STATUS_TIMEOUT_MS = 20 * 1000;
const PING_TIMEOUT_MS = 120 * 1000;
const PROBE_TIMEOUT_MS = 30 * 1000;
const probeCache = new Map();

// The expected value must NOT appear in the prompt: some CLIs echo the prompt, and a
// probe that matches its own question would call a broken agent "connected".
export const BRAIN_PING_PROMPT = 'Compute 6 + 7. Reply with exactly {"sum": <the number>} and nothing else.';
export const BRAIN_PING_EXPECTED = 13;

export function clearEditorAgentProbeCache() {
  probeCache.clear();
}

function statusOutput(binary, args, env = {}) {
  const child = spawnSync(binary, args, {
    encoding: 'utf8', timeout: STATUS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, ...env, NO_COLOR: '1', TERM: 'dumb' },
  });
  return `${child.stdout || ''}\n${child.stderr || ''}`;
}

/** Cheap, offline check: is this CLI installed, and does it say it is signed in? */
export function editorAgentStatus(id, { binary = null, exec = statusOutput } = {}) {
  const adapter = editorAgentAdapter(id);
  const cliPath = binary || resolveAgentBinary(adapter.cli);
  if (!cliPath) {
    return { id, installed: false, signed_in: null, ready: false, reason: 'not installed on this machine', checked_at: new Date().toISOString() };
  }
  if (!adapter.statusArgs) {
    return { id, installed: true, signed_in: null, ready: null, reason: null, checked_at: new Date().toISOString() };
  }
  try {
    const output = exec(cliPath, adapter.statusArgs, adapter.env || {});
    const signedIn = adapter.statusParse ? adapter.statusParse(output) : null;
    return {
      id,
      installed: true,
      signed_in: signedIn,
      ready: signedIn === false ? false : null,
      reason: signedIn === false ? 'not signed in on this machine' : null,
      checked_at: new Date().toISOString(),
    };
  } catch (error) {
    return { id, installed: true, signed_in: null, ready: null, reason: `status check failed: ${String(error.message || error).slice(0, 120)}`, checked_at: new Date().toISOString() };
  }
}

/**
 * One real turn: the only honest way to claim an agent is connected. When an adapter
 * declares candidate models (Codex), each is tried until one answers, because a stale
 * model in the user's config.toml must not look like "not connected".
 */
export async function probeEditorAgent(id, { run = null, timeoutMs = PROBE_TIMEOUT_MS, force = false } = {}) {
  const cached = probeCache.get(id);
  if (!force && cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.value;

  const adapter = editorAgentAdapter(id);
  const binary = resolveAgentBinary(adapter.cli);
  let value;
  if (!binary) {
    value = { id, label: adapter.label, installed: false, ready: false, reason: 'not installed on this machine', human_reason: 'Not installed on this machine.', model: null };
  } else {
    const models = Array.isArray(adapter.models) && adapter.models.length ? [null, ...adapter.models] : [null];
    let lastReason = null;
    let answered = null;
    for (const model of models) {
      try {
        const { text } = await askEditorAgent({
          agentId: id, prompt: BRAIN_PING_PROMPT, timeoutMs, run, model,
        });
        const parsed = extractJsonBlock(text);
        if (parsed && Number(parsed.sum) === BRAIN_PING_EXPECTED) { answered = model || 'default'; break; }
        // A CLI that exits 0 but prints an API error (Codex does this) must not look
        // connected: keep the tail of what it actually said.
        lastReason = parsed
          ? `the agent answered, but not as asked: ${JSON.stringify(parsed).slice(0, 220)}`
          : `the agent answered without JSON: ${String(text || '').trim().slice(-200) || '(empty output)'}`;
      } catch (error) {
        lastReason = String(error.message || error);
      }
    }
    value = answered
      ? { id, label: adapter.label, installed: true, ready: true, reason: null, human_reason: null, model: answered }
      : {
        id,
        label: adapter.label,
        installed: true,
        ready: false,
        reason: String(lastReason || 'no answer').slice(0, 300),
        human_reason: humanizeAgentReason(id, lastReason || 'no answer'),
        model: null,
      };
  }
  probeCache.set(id, { at: Date.now(), value });
  return value;
}

/** Probe several agents with a small concurrency cap (each one spawns a CLI). */
export async function probeEditorAgents({ ids = null, concurrency = 2, run = null, force = false } = {}) {
  const wanted = ids || EDITOR_AGENT_ADAPTERS.map(adapter => adapter.id);
  const results = [];
  const queue = [];
  // An agent whose own CLI says "not signed in" cannot answer: say so without
  // spawning it (one less process competing with the user's apps).
  for (const id of wanted) {
    const status = editorAgentStatus(id);
    if (!status.installed) { results.push({ id, installed: false, ready: false, reason: 'not installed on this machine', human_reason: 'Not installed on this machine.' }); continue; }
    if (status.signed_in === false) { results.push({ id, installed: true, ready: false, reason: 'not signed in on this machine', human_reason: humanizeAgentReason(id, 'not logged in') }); continue; }
    queue.push(id);
  }
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
    while (queue.length) {
      const id = queue.shift();
      results.push(await probeEditorAgent(id, { run, force }));
    }
  });
  await Promise.all(workers);
  return results.sort((a, b) => wanted.indexOf(a.id) - wanted.indexOf(b.id));
}
