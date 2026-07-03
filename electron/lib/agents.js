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

const { ipcMain, shell } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

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

  ipcMain.handle('agents:launch', async (_evt, agentId, cwd) => {
    const agent = KNOWN_AGENTS.find((a) => a.id === agentId);
    if (!agent) return { ok: false, error: 'unknown agent' };
    const cliPath = await resolveCliPath(agent.cli);
    if (!cliPath) return { ok: false, error: 'not_installed', installCmd: agent.installCmd };
    const opened = openInTerminal(agent.cli, cwd && fs.existsSync(cwd) ? cwd : HOME);
    return opened ? { ok: true } : { ok: false, error: 'could not open a terminal' };
  });

  // Install the Generative-Media-Skills and seed the muapi key so a connected
  // agent can go prompt → generate → output. Runs in a visible terminal so the
  // user can watch progress and approve any npx prompts.
  ipcMain.handle('agents:setupMediaSkills', async (_evt, opts) => {
    const muapiKey = (opts && opts.muapiKey) || '';
    const dir = (opts && opts.cwd && fs.existsSync(opts.cwd)) ? opts.cwd : HOME;
    const keyPrefix = muapiKey ? `export MUAPI_API_KEY=${shellQuote(muapiKey)}; ` : '';
    const cmd = `${keyPrefix}npx -y skills add SamurAIGPT/Generative-Media-Skills`;
    const opened = openInTerminal(cmd, dir);
    return opened
      ? { ok: true, seededKey: !!muapiKey }
      : { ok: false, error: 'could not open a terminal' };
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

module.exports = { register, KNOWN_AGENTS, detectAll };
