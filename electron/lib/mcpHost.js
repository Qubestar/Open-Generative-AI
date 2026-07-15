// Hosts the Vidmyo MCP over loopback HTTP from inside the Electron main process.
//
// Why this exists: the stdio server (mcp/server.js) runs as a plain node process
// spawned by the agent's CLI, so it can't read Electron's safeStorage keychain —
// which means an agent could never generate a scene image with Luke's stored fal/
// Agnes key. Running the same tool surface HERE fixes that: getSecret() works, and
// the key never leaves the main process. The agent asks for a generation; it never
// sees the credential.
//
// Trade-off, accepted deliberately: this MCP only answers while Vidmyo is open.
// The stdio server stays for the app-closed case.
//
// Security posture (it's an HTTP server, so it needs to earn that):
//   - binds 127.0.0.1 only — never reachable off-machine
//   - every request needs a bearer token, compared in constant time
//   - the token is persisted 0600 so the agent's registration survives a restart
//   - the token authorizes CALLING tools, not READING keys: no tool returns a
//     provider key, so a leaked token can spend credits but can't exfiltrate them

const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { app } = require('electron');
const { getSecret } = require('./secrets');

// 7861 is Video Delta's engine — take the next one and keep it STABLE across
// restarts, because agents register a fixed URL.
const PREFERRED_PORT = 7862;
const HOST = '127.0.0.1';

let state = null;   // { httpServer, mcp, port, token, url }

const hostConfigFile = () => path.join(app.getPath('userData'), 'mcp-host.json');
function readHostConfig() {
  try { return JSON.parse(fs.readFileSync(hostConfigFile(), 'utf8')) || {}; } catch { return {}; }
}
function writeHostConfig(cfg) {
  fs.writeFileSync(hostConfigFile(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

// Settings → Story owns this (storyBridge writes it); read fresh per call so a
// change takes effect without restarting the server.
function readStoryConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'story-config.json'), 'utf8')) || {};
  } catch { return {}; }
}

function tokenMatches(header, token) {
  const given = /^Bearer\s+(.+)$/i.exec(String(header || ''))?.[1] || '';
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  // timingSafeEqual throws on length mismatch — check it separately, but still
  // compare the bytes so we don't leak position via early return.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function listen(httpServer, port) {
  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, HOST, () => {
      httpServer.removeListener('error', reject);
      resolve(httpServer.address().port);
    });
  });
}

async function start() {
  if (state) return { ok: true, url: state.url, token: state.token, port: state.port };
  try {
    const repo = path.join(__dirname, '..', '..');
    const entry = path.join(repo, 'mcp', 'lib', 'httpServer.js');
    const { createHttpMcp } = await import(pathToFileURL(entry).href);

    const cfg = readHostConfig();
    const token = cfg.token || crypto.randomBytes(32).toString('hex');

    const mcp = await createHttpMcp({
      // The whole point: keys come from the OS keychain, in-process.
      secrets: (providerId) => getSecret(providerId),
      imageConfig: () => {
        const s = readStoryConfig();
        return { imageSource: s.imageSource, imageModel: s.imageModel };
      },
      keyHint: 'Vidmyo → Settings → Providers',
    });

    const httpServer = http.createServer((req, res) => {
      if (!tokenMatches(req.headers.authorization, token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      mcp.handleRequest(req, res).catch((err) => {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err.message || err) }));
      });
    });

    let port;
    try {
      port = await listen(httpServer, cfg.port || PREFERRED_PORT);
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      // Something else holds the port. Take any free one rather than not starting —
      // but the URL changes, so a previously-registered agent must reconnect.
      port = await listen(httpServer, 0);
    }

    const url = `http://${HOST}:${port}/mcp`;
    writeHostConfig({ token, port });
    state = { httpServer, mcp, port, token, url };
    return { ok: true, url, token, port };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

async function stop() {
  if (!state) return;
  const { httpServer, mcp } = state;
  state = null;
  await new Promise((resolve) => httpServer.close(resolve));
  await mcp.close().catch(() => {});
}

// Where the agent should point, for the Agents-tab connect button.
function info() {
  if (!state) return { ok: false, running: false };
  return { ok: true, running: true, url: state.url, token: state.token, port: state.port };
}

module.exports = { start, stop, info, PREFERRED_PORT };
