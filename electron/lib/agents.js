// Local AI agent bridge for Vidmyo (Electron main process).
//
// Detects coding/agent CLIs that are already installed on the user's machine,
// reports real connection status, triggers each agent's own login flow (so
// "Codex OAuth" is the genuine `codex login` browser flow rather than a fake
// key prompt), launches them in a terminal, and bootstraps the
// Generative-Media-Skills so a connected agent can drive media generation.
//
// The renderer never touches child_process directly — it only calls the
// window.agents.* surface exposed in preload.js. Everything here is best-effort
// and returns structured results instead of throwing, so the Settings UI can
// degrade gracefully.

const { ipcMain, shell, app, clipboard } = require('electron');
const { execFile, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Launch preferences ──────────────────────────────────────────────────────
// How "Launch" opens an agent: its desktop app (default, Luke's preference)
// or a Terminal session. Stored in userData/agents-config.json.
const agentsConfigFile = () => path.join(app.getPath('userData'), 'agents-config.json');
function readAgentsConfig() {
    try { return JSON.parse(fs.readFileSync(agentsConfigFile(), 'utf8')) || {}; } catch { return {}; }
}
function writeAgentsConfig(cfg) {
    fs.writeFileSync(agentsConfigFile(), JSON.stringify(cfg, null, 2));
}

// Desktop-app candidates per agent, first installed one wins (checked in
// /Applications and ~/Applications at detect/launch time).
const APP_CANDIDATES = {
    claude_code: ['Claude Code', 'Claude'],
    codex: ['Codex', 'ChatGPT'],
    gemini: ['Antigravity', 'Gemini'],
    hermes: ['Hermes'],
    opencode: ['OpenCode'],
};

// Known non-/Applications install locations (self-built Electron agents).
const EXTRA_APP_PATHS = {
    hermes: [
        '/Volumes/My Lexar/This Mac System Redirects/hermes/hermes-agent/apps/desktop/release/mac-arm64/Hermes.app',
    ],
};

// ── Session brief ───────────────────────────────────────────────────────────
// Written into <project>/.vidmyo/session-brief.md before launching an agent,
// so a new session starts with real context instead of a cold open. The
// kickoff prompt tells the agent where the brief is and to use the vidmyo
// MCP tools — no keystroke injection, no credential touching.

function readManifest(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')); } catch { return null; }
}

function writeSessionBrief(dir, manifest) {
  const briefDir = path.join(dir, '.vidmyo');
  fs.mkdirSync(briefDir, { recursive: true });
  const m = manifest;
  const approved = m ? m.scenes.filter((s) => s.image.approved).length : 0;
  const lines = [
    `# Vidmyo — ${m?.brief?.topic || path.basename(dir)}`,
    '',
    `Project dir: ${dir}`,
    m?.brief?.hook ? `Hook: ${m.brief.hook}` : null,
    m?.brief?.angle ? `Angle: ${m.brief.angle}` : null,
    m?.brief?.sheetRow ? `Tracker row: ${m.brief.sheetRow} (video #${m.brief.videoNum})` : null,
    '',
    '## State',
    m ? `- script: ${m.script ? `${m.script.trim().split(/\s+/).length} words` : 'MISSING — write it first (channel rules: 1,400-1,900 words, hook, dopamine beats, CTA)'}` : '- no project.json in this folder yet',
    m ? `- voiceover: ${m.voiceover.artifact ? m.voiceover.source : 'not generated'}` : null,
    m ? `- scenes: ${m.scenes.length} (${approved} approved)` : null,
    m ? `- renders: ${m.renders.length}` : null,
    '',
    '## How to work',
    'Use the `vidmyo` MCP tools: story_open → story_set_script → story_run_stage {stage:"to-scenes"} →',
    'generate each scene image (Google Flow is the free default; match the prompt exactly) →',
    'story_accept_artifact (file must exist on disk, sNNN ids only) → story_approve_scene after a real',
    'visual check → story_run_stage assemble → finalize.',
  ].filter((l) => l !== null);
  const file = path.join(briefDir, 'session-brief.md');
  fs.writeFileSync(file, lines.join('\n'));
  return { file, topic: m?.brief?.topic || path.basename(dir) };
}

function kickoffPrompt(dir, topic, briefFile, { autonomous = false } = {}) {
  if (autonomous) {
    return `Vidmyo — ${topic}\n\n`
      + `Create this ENTIRE faceless doodle video end to end, autonomously, using the vidmyo MCP tools. `
      + `Do not stop to ask for approval unless something truly blocks you. Steps:\n`
      + `1. story_open "${dir}" and read ${briefFile}.\n`
      + `2. Write the full narration script per the channel rules (1,400-1,900 words, strong hook, `
      + `retention beats with named facts/numbers, CTA) and save it with story_set_script.\n`
      + `3. story_run_stage stage:"to-scenes".\n`
      + `4. For each scene: generate the doodle image with Google Flow matching the scene prompt exactly, `
      + `save it to <dir>/images/<sceneId>.png, story_accept_artifact, then story_approve_scene after a real visual check.\n`
      + `5. story_run_stage stage:"assemble", then stage:"finalize".\n`
      + `Report the final MP4 path when done.`;
  }
  return `Vidmyo — ${topic}\n\nYou are driving the Vidmyo Story pipeline for the project at ${dir}. `
    + `Read ${briefFile} for the current state, then continue the pipeline using the vidmyo MCP tools `
    + `(story_open first). Follow the channel production rules baked into the tool descriptions.`;
}

// Shared launch used by the IPC handler and by the sheet-delegate flow.
async function launchAgent(agentId, cwd, { autonomous = false } = {}) {
  const agent = KNOWN_AGENTS.find((a) => a.id === agentId);
  if (!agent) return { ok: false, error: 'unknown agent' };

  const projectDir = cwd && fs.existsSync(cwd) ? cwd : HOME;
  const manifest = readManifest(projectDir);
  const { file: briefFile, topic } = writeSessionBrief(projectDir, manifest);
  const prompt = kickoffPrompt(projectDir, topic, briefFile, { autonomous });

  const mode = readAgentsConfig().launchMode || 'desktop';
  if (mode === 'desktop') {
    if (agentId === 'claude_code' && findDesktopApp('claude_code')) {
      const url = `claude://code/new?q=${encodeURIComponent(prompt)}&folder=${encodeURIComponent(projectDir)}`;
      return new Promise((resolve) => {
        execFile('open', [url], (err) =>
          resolve(err
            ? { ok: false, error: `deep link failed: ${err.message}` }
            : { ok: true, via: 'claude-code-deeplink', app: 'Claude',
                message: autonomous
                  ? `New Claude Code session opened for "${topic}" — press Enter to let it build the whole video.`
                  : `New Claude Code session opened at "${topic}" — confirm the folder, review the prompt, send.` }));
      });
    }
    // Full disk resolution here (spotlight) so self-built apps like Hermes,
    // installed outside /Applications, still open as the desktop app.
    const found = findDesktopApp(agentId, { spotlight: true });
    if (found) {
      const ideLike = ['Antigravity', 'Antigravity IDE', 'OpenCode'].includes(found.name);
      // Open by full path so apps outside /Applications resolve.
      const args = ideLike ? ['-a', found.path, projectDir] : [found.path];
      if (!ideLike) clipboard.writeText(prompt);
      return new Promise((resolve) => {
        execFile('open', args, (err) =>
          resolve(err
            ? { ok: false, error: `could not open ${found.name}.app: ${err.message}` }
            : { ok: true, via: 'desktop', app: found.name,
                message: ideLike
                  ? `${found.name} opened at the project — the brief is in .vidmyo/session-brief.md.`
                  : `${found.name} opened. The kickoff prompt is on your clipboard — start a new session and paste (⌘V).` }));
      });
    }
  }
  const cliPath = await resolveCliPath(agent.cli);
  if (!cliPath) return { ok: false, error: 'not_installed', installCmd: agent.installCmd };
  const opened = openInTerminal(agent.cli, projectDir);
  return opened
    ? { ok: true, via: mode === 'desktop' ? 'terminal-fallback' : 'terminal',
        message: `Terminal opened at the project — tell the agent to read .vidmyo/session-brief.md.` }
    : { ok: false, error: 'could not open a terminal' };
}

// Agent used for auto-delegation. The user's saved choice wins (when still
// installed); otherwise Claude Code if present, else the first installed one.
async function preferredAgentId() {
  const all = await detectAll();
  const saved = readAgentsConfig().preferredAgent;
  if (saved && all.find((a) => a.id === saved && a.installed)) return saved;
  const claude = all.find((a) => a.id === 'claude_code' && a.installed);
  if (claude) return 'claude_code';
  const any = all.find((a) => a.installed);
  return any ? any.id : null;
}

// Spotlight lookup for an <AppName>.app anywhere on disk. Skips dev
// node_modules copies (Electron.app), prefers release/Applications builds.
function spotlightApp(fsName) {
    try {
        const out = execFileSync('mdfind', [`kMDItemFSName == '${fsName}'`], { timeout: 4000 }).toString();
        const hits = out.split('\n').filter((p) => p.endsWith('.app') && !p.includes('/node_modules/'));
        return hits.find((p) => /release|Applications/i.test(p)) || hits[0] || null;
    } catch { return null; }
}

// Resolve an agent's desktop app to { name, path } or null. `spotlight` adds
// the disk-wide fallback (used at launch time, not during fast detection).
function findDesktopApp(agentId, { spotlight = false } = {}) {
    for (const name of APP_CANDIDATES[agentId] || []) {
        for (const base of ['/Applications', path.join(HOME, 'Applications')]) {
            const p = path.join(base, `${name}.app`);
            if (fs.existsSync(p)) return { name, path: p };
        }
    }
    for (const p of EXTRA_APP_PATHS[agentId] || []) {
        if (fs.existsSync(p)) return { name: path.basename(p, '.app'), path: p };
    }
    if (spotlight) {
        for (const name of APP_CANDIDATES[agentId] || []) {
            const hit = spotlightApp(`${name}.app`);
            if (hit) return { name, path: hit };
        }
    }
    return null;
}

const HOME = os.homedir();
const USER_SHELL = process.env.SHELL || '/bin/zsh';
const IS_WIN = process.platform === 'win32';

// ── Known agents ────────────────────────────────────────────────────────────
// `id` matches the provider id in src/lib/providers.js so the Settings UI can
// line detection results up with the cards it already renders.
const KNOWN_AGENTS = [
  {
    id: 'claude_code',
    cli: 'claude',
    name: 'Claude Code',
    loginCmd: 'claude',            // first run / `claude` triggers its own auth
    installCmd: 'npm install -g @anthropic-ai/claude-code',
    authPaths: ['.claude/.credentials.json', '.claude.json', '.config/claude/.credentials.json'],
  },
  {
    id: 'codex',
    cli: 'codex',
    name: 'OpenAI Codex',
    loginCmd: 'codex login',       // real ChatGPT/OpenAI OAuth in the browser
    installCmd: 'npm install -g @openai/codex',
    authPaths: ['.codex/auth.json'],
  },
  {
    id: 'gemini',
    cli: 'gemini',
    name: 'Gemini CLI',
    loginCmd: 'gemini',            // first run triggers Google OAuth
    installCmd: 'npm install -g @google/gemini-cli',
    authPaths: ['.gemini/oauth_creds.json', '.gemini/installation_id'],
  },
  {
    id: 'hermes',
    cli: 'hermes',
    name: 'Hermes Agent',
    loginCmd: 'hermes',
    installCmd: 'npm install -g @outsourc-e/hermes-agent',
    authPaths: ['.hermes/config.json', '.hermes'],
  },
  {
    id: 'opencode',
    cli: 'opencode',
    name: 'OpenCode',
    loginCmd: 'opencode auth login',
    installCmd: 'npm install -g opencode-ai',
    authPaths: ['.local/share/opencode/auth.json', '.config/opencode/auth.json'],
  },
];

// ── Shell helpers ────────────────────────────────────────────────────────────

// Run a command inside the user's LOGIN shell so it inherits the real PATH
// (nvm, Homebrew, pnpm, ~/.local/bin …). GUI-launched Electron apps otherwise
// get a stripped PATH and would miss every CLI the user installed.
function loginShellExec(commandLine, timeout = 6000) {
  return new Promise((resolve) => {
    if (IS_WIN) {
      execFile('where', [commandLine], { timeout }, (err, stdout) => {
        resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: '' });
      });
      return;
    }
    execFile(USER_SHELL, ['-lic', commandLine], { timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

async function resolveCliPath(cli) {
  // `command -v` is POSIX and resolves shell functions/aliases too.
  const res = await loginShellExec(`command -v ${cli} 2>/dev/null`);
  if (res.ok && res.stdout) return res.stdout.split('\n')[0].trim();
  return '';
}

async function readVersion(cli) {
  const res = await loginShellExec(`${cli} --version 2>/dev/null`, 8000);
  if (!res.ok || !res.stdout) return '';
  // Grab the first version-looking token; fall back to the first line.
  const m = res.stdout.match(/\d+\.\d+(\.\d+)?/);
  return m ? m[0] : res.stdout.split('\n')[0].slice(0, 40);
}

function isAuthed(agent) {
  return (agent.authPaths || []).some((rel) => {
    try {
      return fs.existsSync(path.join(HOME, rel));
    } catch {
      return false;
    }
  });
}

// macOS/Linux: open a Terminal window running `cmd`. Returns true on success.
function openInTerminal(cmd, cwd) {
  try {
    if (process.platform === 'darwin') {
      const full = cwd ? `cd ${shellQuote(cwd)} && ${cmd}` : cmd;
      // Escape for AppleScript string literal.
      const script = `tell application "Terminal"\nactivate\ndo script "${full.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nend tell`;
      execFile('osascript', ['-e', script]);
      return true;
    }
    if (process.platform === 'linux') {
      const full = cwd ? `cd ${shellQuote(cwd)}; ${cmd}; exec ${USER_SHELL}` : `${cmd}; exec ${USER_SHELL}`;
      // Try the common terminal emulators in order.
      execFile('x-terminal-emulator', ['-e', USER_SHELL, '-lic', full]);
      return true;
    }
    if (IS_WIN) {
      const full = cwd ? `cd /d ${cwd} && ${cmd}` : cmd;
      execFile('cmd', ['/c', 'start', 'cmd', '/k', full]);
      return true;
    }
  } catch (e) {
    return false;
  }
  return false;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

async function detectAll() {
  const out = [];
  for (const agent of KNOWN_AGENTS) {
    const cliPath = await resolveCliPath(agent.cli);
    const installed = !!cliPath;
    const version = installed ? await readVersion(agent.cli) : '';
    out.push({
      id: agent.id,
      cli: agent.cli,
      name: agent.name,
      installed,
      path: cliPath,
      version,
      authed: installed ? isAuthed(agent) : false,
      installCmd: agent.installCmd,
      loginCmd: agent.loginCmd,
      desktopApp: findDesktopApp(agent.id)?.name || null,
    });
  }
  return out;
}

function register() {
  ipcMain.handle('agents:detect', async () => {
    try {
      return { ok: true, agents: await detectAll() };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e), agents: [] };
    }
  });

  ipcMain.handle('agents:authStatus', async (_evt, agentId) => {
    const agent = KNOWN_AGENTS.find((a) => a.id === agentId);
    if (!agent) return { ok: false, error: 'unknown agent' };
    const cliPath = await resolveCliPath(agent.cli);
    return { ok: true, installed: !!cliPath, authed: !!cliPath && isAuthed(agent) };
  });

  ipcMain.handle('agents:login', async (_evt, agentId) => {
    const agent = KNOWN_AGENTS.find((a) => a.id === agentId);
    if (!agent) return { ok: false, error: 'unknown agent' };
    const cliPath = await resolveCliPath(agent.cli);
    if (!cliPath) {
      return { ok: false, error: 'not_installed', installCmd: agent.installCmd };
    }
    const opened = openInTerminal(agent.loginCmd);
    return opened
      ? { ok: true, launched: agent.loginCmd }
      : { ok: false, error: 'could not open a terminal' };
  });

  ipcMain.handle('agents:launch', async (_evt, agentId, cwd) => launchAgent(agentId, cwd));

  ipcMain.handle('agents:getLaunchConfig', async () => {
    const cfg = readAgentsConfig();
    return { ok: true, launchMode: cfg.launchMode || 'desktop', preferredAgent: cfg.preferredAgent || null, resolvedAgent: await preferredAgentId() };
  });

  ipcMain.handle('agents:setPreferred', async (_evt, agentId) => {
    const cfg = readAgentsConfig();
    cfg.preferredAgent = agentId || null; // null = auto
    writeAgentsConfig(cfg);
    return { ok: true, preferredAgent: cfg.preferredAgent, resolvedAgent: await preferredAgentId() };
  });

  ipcMain.handle('agents:setLaunchConfig', async (_evt, { launchMode } = {}) => {
    if (!['desktop', 'terminal'].includes(launchMode)) return { ok: false, error: 'launchMode must be desktop or terminal' };
    const cfg = readAgentsConfig();
    cfg.launchMode = launchMode;
    writeAgentsConfig(cfg);
    return { ok: true, launchMode };
  });

  // Install the Generative-Media-Skills and seed the muapi key so a connected
  // agent can go prompt → generate → output. Runs in a visible terminal so the
  // user can watch progress and approve any npx prompts.
  ipcMain.handle('agents:setupMediaSkills', async (_evt, opts) => {
    const muapiKey = (opts && opts.muapiKey) || '';
    const dir = (opts && opts.cwd && fs.existsSync(opts.cwd)) ? opts.cwd : HOME;
    // Never put the key on the terminal command line (shell history, ps).
    // Write it to a 0600 temp file the command reads and deletes.
    let keyPrefix = '';
    if (muapiKey) {
      const keyFile = path.join(os.tmpdir(), `vidmyo-key-${process.pid}-${Date.now()}`);
      fs.writeFileSync(keyFile, muapiKey, { mode: 0o600 });
      keyPrefix = `export MUAPI_API_KEY="$(cat ${shellQuote(keyFile)})" && rm -f ${shellQuote(keyFile)} && `;
    }
    const cmd = `${keyPrefix}npx -y skills add SamurAIGPT/Generative-Media-Skills`;
    const opened = openInTerminal(cmd, dir);
    return opened
      ? { ok: true, seededKey: !!muapiKey }
      : { ok: false, error: 'could not open a terminal' };
  });

  // Register the Vidmyo MCP server into an agent's CLI config. One-click for
  // CLIs with an `mcp add` command; the rest get the command to run manually.
  ipcMain.handle('agents:installMcp', async (_evt, agentId) => {
    const serverPath = path.join(__dirname, '..', '..', 'mcp', 'server.js');
    const stdioCmd = (bin) => `${bin} mcp add --transport stdio vidmyo -- node ${shellQuote(serverPath)}`;
    const manual = (hint) => ({
      ok: false, error: 'manual',
      command: `claude mcp add --transport stdio vidmyo -- node ${shellQuote(serverPath)}`,
      hint,
      serverPath,
    });
    if (agentId === 'claude_code') {
      const res = await loginShellExec(stdioCmd('claude'), 20000);
      return res.ok
        ? { ok: true, output: res.stdout.slice(0, 300), serverPath }
        : { ok: false, error: res.stderr.slice(0, 300) || 'claude mcp add failed', serverPath };
    }
    if (agentId === 'codex') {
      const res = await loginShellExec(`codex mcp add vidmyo -- node ${shellQuote(serverPath)}`, 20000);
      return res.ok
        ? { ok: true, output: res.stdout.slice(0, 300), serverPath }
        : manual('Codex: add a stdio MCP server named "vidmyo" in its config (command: node, args: the server path).');
    }
    if (agentId === 'gemini') {
      return manual('Gemini CLI: add to ~/.gemini/settings.json → mcpServers.vidmyo = { command: "node", args: ["<server path>"] }.');
    }
    return manual('Register a stdio MCP server named "vidmyo": command node, argument = the server path.');
  });

  // Open an arbitrary docs/url externally (used by the UI for "Install" links).
  ipcMain.handle('agents:openExternal', async (_evt, url) => {
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  });
}

module.exports = { register, KNOWN_AGENTS, detectAll, launchAgent, preferredAgentId };
