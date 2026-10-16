// Local-first Channel Workspaces. The renderer can operate only on roots and
// workspaces the user selected through a native dialog or reopened from recents.
const { app, dialog, ipcMain, shell, safeStorage } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { resolveRuntimePaths } = require('./runtimePaths');
const { createYouTubeChannelAnalysis } = require('./youtubeChannelAnalysis');
const { createChannelPlanner } = require('./channelPlanner');
const { getSecret } = require('./secrets');
const { createGoogleOAuth } = require('./googleOAuth');
const { createChannelSheets } = require('./channelSheets');
const { getService: getEntitlementService } = require('./entitlementRuntime');
const { createYouTubeAnalytics, REQUIRED_READONLY_SCOPES } = require('./youtubeAnalytics');

const MAX_RECENTS = 100;
const MAX_JSON_BYTES = 5 * 1024 * 1024;

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function createChannelsBridge(deps = {}) {
  const application = deps.app || app;
  const dialogs = deps.dialog || dialog;
  const ipc = deps.ipcMain || ipcMain;
  const systemShell = deps.shell || shell;
  const runtime = deps.runtime || resolveRuntimePaths({
    isPackaged: application.isPackaged,
    resourcesPath: process.resourcesPath,
    ...(deps.repoRoot ? { repoRoot: deps.repoRoot } : {}),
  });
  const loadCore = deps.core || (() => import(pathToFileURL(path.join(runtime.coreDir, 'index.js')).href));
  const recentFile = path.join(application.getPath('userData'), 'channel-workspaces.json');
  const authorizedRoots = new Set();
  const authorizedWorkspaces = new Set();
  const locks = new Map();
  const deviceId = deps.deviceId || `desktop_${crypto.createHash('sha256').update(application.getPath('userData')).digest('hex').slice(0, 20)}`;
  const youtube = deps.youtube || createYouTubeChannelAnalysis({ app: application, runtime, core: loadCore });
  const planner = deps.planner || createChannelPlanner({ core: loadCore });
  const fetchImpl = deps.fetch || globalThis.fetch;
  const secret = deps.getSecret || getSecret;
  let sheets = deps.sheets || null;
  let analyticsGoogle = deps.analyticsGoogle || null;
  let analytics = deps.analytics || null;
  let registered = false;

  function canonicalExistingDir(value, label = 'folder') {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error(`${label} is invalid.`);
    const resolved = fs.realpathSync(value);
    if (!fs.statSync(resolved).isDirectory()) throw new Error(`${label} must be a folder.`);
    return resolved;
  }

  function readRecents() {
    try {
      if (!fs.existsSync(recentFile) || fs.statSync(recentFile).size > MAX_JSON_BYTES) return [];
      const entries = JSON.parse(fs.readFileSync(recentFile, 'utf8'));
      return Array.isArray(entries) ? entries.filter(item => item && typeof item.dir === 'string').slice(0, MAX_RECENTS) : [];
    } catch { return []; }
  }

  function remember(dir, manifest) {
    const resolved = path.resolve(dir);
    const entries = readRecents().filter(item => path.resolve(item.dir) !== resolved);
    entries.unshift({ dir: resolved, name: manifest.name, channelId: manifest.id, updatedAt: manifest.updatedAt });
    atomicJson(recentFile, entries.slice(0, MAX_RECENTS));
    authorizedWorkspaces.add(resolved);
  }

  async function authorizeRecent(dir) {
    const resolved = canonicalExistingDir(dir, 'Channel workspace');
    const allowed = readRecents().some(item => path.resolve(item.dir) === resolved);
    if (!allowed) throw new Error('Open this channel workspace first.');
    authorizedWorkspaces.add(resolved);
    return resolved;
  }

  async function checkedWorkspace(dir) {
    const resolved = canonicalExistingDir(dir, 'Channel workspace');
    if (!authorizedWorkspaces.has(resolved)) await authorizeRecent(resolved);
    const core = await loadCore();
    const workspace = core.ChannelWorkspace.load(resolved);
    if (workspace.dir !== resolved) throw new Error('Channel workspace path is invalid.');
    return workspace;
  }

  function response(workspace) {
    const manifest = workspace.snapshot();
    remember(workspace.dir, manifest);
    return { ok: true, dir: workspace.dir, manifest };
  }

  function serialized(dir, operation) {
    const key = path.resolve(String(dir || '.'));
    const previous = locks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    locks.set(key, current);
    return current.finally(() => { if (locks.get(key) === current) locks.delete(key); });
  }

  function claimIdentity(options = {}) {
    return {
      userId: 'local-user',
      deviceId,
      leaseMs: Number.isFinite(options.leaseMs) ? Math.max(60_000, Math.min(options.leaseMs, 24 * 60 * 60 * 1000)) : 30 * 60 * 1000,
    };
  }

  async function teamClaimIfConfigured(workspace, videoId, options = {}) {
    const service = deps.entitlement || getEntitlementService();
    if (!service) return null;
    const manifest = workspace.snapshot();
    const video = workspace.getVideo(videoId);
    const leaseMs = claimIdentity(options).leaseMs;
    const result = await service.claimTeamWork({
      itemId: `${manifest.id}:${video.id}`.slice(0, 128),
      expectedRevision: Number(video.sheet?.revision || 0),
      leaseMs,
      idempotencyKey: `claim:${crypto.randomUUID()}`,
    });
    if (!result?.ok) throw new Error(result?.code === 'claim_conflict' ? 'Another team member already reserved this video.' : 'The team reservation service is unavailable. Try again shortly.');
    return result.claim;
  }

  function briefFor(manifest, video) {
    const defaults = manifest.defaults || {};
    return {
      kind: video.kind || defaults.kind || 'story',
      style: video.style || defaults.style || (video.kind === 'animation' ? 'editorial-collage' : 'doodle'),
      topic: video.title,
      details: [video.hook, video.angle].filter(Boolean).join('\n\n'),
      language: manifest.strategy?.language || 'English',
      aspect: defaults.aspect || '16:9',
      durationSec: defaults.durationSec || 300,
      sourceChannel: { channelId: manifest.id, videoId: video.id },
    };
  }

  async function analyzeResearch(input = {}) {
    const mode = ['existing', 'examples', 'niche'].includes(input.mode) ? input.mode : 'niche';
    const targets = mode === 'existing'
      ? [input.profileUrl]
      : mode === 'examples' ? (Array.isArray(input.exampleUrls) ? input.exampleUrls.slice(0, 3) : []) : [];
    if (!targets.length) return { profile: {}, evidence: [], opportunities: [], sourceUrls: [], channels: [] };
    const channels = [];
    for (const target of targets) channels.push(await youtube.analyze(target));
    const opportunities = channels.flatMap(result => (result.analysis?.opportunities || []).slice(0, 10).map(item => ({ ...item, channelId: result.profile.channelId })));
    const evidence = opportunities.slice(0, 12).flatMap(item => (item.evidence || []).map(signal => ({ ...signal, title: item.title, score: item.score })));
    return { profile: channels[0]?.profile || {}, evidence, opportunities, sourceUrls: targets, channels };
  }

  function referenceSummary(result) {
    const top = (result.analysis?.opportunities || []).slice(0, 10);
    return {
      name: result.profile?.title || 'Reference channel',
      recurringTopics: top.slice(0, 5).map(item => item.title),
      titlePatterns: top.slice(0, 5).map(item => item.title),
      hookTypes: [],
      formats: [],
      standoutTopics: top.slice(0, 8).map(item => item.title),
    };
  }

  function openRouterDirector(model) {
    const apiKey = secret('openrouter');
    if (!apiKey) throw new Error('Add your OpenRouter key in Settings before using an API planner.');
    if (typeof model !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(model)) throw new Error('Enter the API model as provider/model-id.');
    return async request => {
      const response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: request.prompt }], response_format: { type: 'json_object' } }),
      });
      let data = null;
      try { data = await response.json(); } catch { /* handled below */ }
      if (!response.ok) throw new Error('The API planner request failed.');
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('The API planner returned an invalid response.');
      return content;
    };
  }

  function sheetService() {
    if (!sheets) {
      const google = deps.google || createGoogleOAuth({ app: application, dialog: dialogs, safeStorage: deps.safeStorage || safeStorage, shell: deps.shell || shell });
      sheets = createChannelSheets({ google, core: loadCore });
    }
    return sheets;
  }

  function analyticsServices() {
    if (!analyticsGoogle) analyticsGoogle = createGoogleOAuth({
      app: application, dialog: dialogs, safeStorage: deps.safeStorage || safeStorage, shell: deps.shell || shell,
      storeFile: path.join(application.getPath('userData'), 'youtube-analytics-oauth.json'),
      scopes: ['openid', 'email', ...REQUIRED_READONLY_SCOPES],
    });
    if (!analytics) analytics = createYouTubeAnalytics({ tokenProvider: { getAccessToken: () => analyticsGoogle.accessToken() }, core: loadCore });
    return { google: analyticsGoogle, analytics };
  }

  function register() {
    if (registered) return false;
    registered = true;
    const handle = (name, fn) => ipc.handle(`channels:${name}`, async (_event, ...args) => {
      try { return await fn(...args); }
      catch (error) { return { ok: false, error: String(error?.message || error) }; }
    });

    handle('pick-root', async () => {
      const choice = await dialogs.showOpenDialog({ title: 'Where should Vidmyo save this channel?', properties: ['openDirectory', 'createDirectory'] });
      if (choice.canceled || !choice.filePaths?.[0]) return { ok: false, canceled: true };
      const root = canonicalExistingDir(choice.filePaths[0], 'Channel root');
      authorizedRoots.add(root);
      return { ok: true, dir: root };
    });
    handle('create', async ({ root, channel } = {}) => {
      const resolvedRoot = canonicalExistingDir(root, 'Channel root');
      if (!authorizedRoots.has(resolvedRoot)) throw new Error('Choose the channel folder first.');
      const core = await loadCore();
      const store = new core.ChannelStore(path.join(resolvedRoot, '.vidmyo', 'channels'));
      return response(store.create(channel || {}));
    });
    handle('recent', async () => ({ ok: true, channels: readRecents().filter(item => {
      try { return fs.existsSync(path.join(item.dir, 'channel.json')); } catch { return false; }
    }) }));
    handle('get', async dir => response(await checkedWorkspace(dir)));
    handle('update', async (dir, patch) => serialized(dir, async () => { const workspace = await checkedWorkspace(dir); workspace.update(patch); return response(workspace); }));
    handle('add-video', async (dir, input) => serialized(dir, async () => { const workspace = await checkedWorkspace(dir); workspace.addVideo(input); return response(workspace); }));
    handle('update-video', async (dir, videoId, patch) => serialized(dir, async () => { const workspace = await checkedWorkspace(dir); workspace.updateVideo(videoId, patch); return response(workspace); }));
    handle('archive-video', async (dir, videoId) => serialized(dir, async () => { const workspace = await checkedWorkspace(dir); workspace.archiveVideo(videoId); return response(workspace); }));
    handle('claim-video', async (dir, videoId, options) => serialized(dir, async () => { const workspace = await checkedWorkspace(dir); await teamClaimIfConfigured(workspace, videoId, options); workspace.claimVideo(videoId, claimIdentity(options)); return response(workspace); }));
    handle('claim-next', async (dir, options) => serialized(dir, async () => {
      const workspace = await checkedWorkspace(dir);
      const next = workspace.nextReady();
      if (!next) throw new Error('There are no Ready videos in this channel.');
      await teamClaimIfConfigured(workspace, next.id, options);
      workspace.claimVideo(next.id, claimIdentity(options));
      return { ...response(workspace), videoId: next.id };
    }));
    handle('release-claim', async (dir, videoId) => serialized(dir, async () => { const workspace = await checkedWorkspace(dir); workspace.releaseClaim(videoId, claimIdentity()); return response(workspace); }));
    handle('prepare-brief', async (dir, videoId) => { const workspace = await checkedWorkspace(dir); const manifest = workspace.snapshot(); return { ok: true, workspaceDir: workspace.dir, channelId: manifest.id, videoId, section: workspace.getVideo(videoId).kind || manifest.defaults.kind, brief: briefFor(manifest, workspace.getVideo(videoId)) }; });
    handle('open-in-creative', async (dir, videoId) => { const workspace = await checkedWorkspace(dir); const manifest = workspace.snapshot(); const video = workspace.getVideo(videoId); return { ok: true, workspaceDir: workspace.dir, channelId: manifest.id, videoId, section: video.kind || manifest.defaults.kind, brief: briefFor(manifest, video) }; });
    handle('link-production', async (dir, videoId, projectId) => serialized(dir, async () => { const workspace = await checkedWorkspace(dir); workspace.linkProduction(videoId, projectId); return response(workspace); }));
    handle('analyze-youtube', async input => ({ ok: true, analysis: await analyzeResearch(input) }));
    handle('plan', async (dir, input = {}) => serialized(dir, async () => {
      const workspace = await checkedWorkspace(dir);
      const manifest = workspace.snapshot();
      const referenceUrls = Array.isArray(input.referenceUrls) ? input.referenceUrls.slice(0, 3) : [];
      const referenceResults = [];
      for (const url of referenceUrls) referenceResults.push(await youtube.analyze(url));
      const research = manifest.research || {};
      const subject = String(input.niche || research.niche || input.goals || research.goals || manifest.strategy.positioning || manifest.name).trim();
      const pillars = Array.isArray(manifest.strategy.pillars) && manifest.strategy.pillars.length
        ? manifest.strategy.pillars
        : subject.split(/[,;|]/).map(value => value.trim()).filter(Boolean).slice(0, 6);
      const plannerRequest = {
        count: Number(input.count) === 20 ? 20 : 10,
        strategy: {
          language: manifest.strategy.language || 'English',
          audience: manifest.strategy.audience || 'Viewers interested in this channel topic',
          positioning: manifest.strategy.positioning || input.goals || research.goals || `Useful videos about ${manifest.name}`,
          pillars: pillars.length ? pillars : [manifest.name],
          cadence: manifest.strategy.cadence || null,
          subjectsToAvoid: [],
        },
        defaults: { kind: manifest.defaults.kind || 'story', style: manifest.defaults.style || 'doodle-v1' },
        referenceChannels: referenceResults.map(referenceSummary),
      };
      const plannerOptions = input.provider === 'api'
        ? { director: openRouterDirector(input.model) }
        : (input.agentId ? { agentId: input.agentId } : {});
      const result = await planner.plan(plannerRequest, plannerOptions);
      return { ok: true, items: result.ideas, source: result.source, warnings: result.warnings };
    }));
    handle('add-planned', async (dir, items) => serialized(dir, async () => {
      if (!Array.isArray(items) || !items.length || items.length > 20) throw new Error('Choose between 1 and 20 planned ideas.');
      const workspace = await checkedWorkspace(dir);
      for (const item of items) workspace.addVideo({
        title: item.title, hook: item.hook, angle: item.angle, pillar: item.pillar,
        kind: item.kind, style: item.style, priority: item.priority, status: 'ready',
      });
      return response(workspace);
    }));
    handle('tracker-create', async (dir, options) => serialized(dir, async () => {
      const workspace = await checkedWorkspace(dir);
      const result = await sheetService().create(workspace, options || {});
      return { ...result, ...(result.ok ? { dir: workspace.dir, manifest: workspace.snapshot() } : {}) };
    }));
    handle('tracker-pull', async dir => serialized(dir, async () => {
      const workspace = await checkedWorkspace(dir);
      const result = await sheetService().pull(workspace);
      return { ...result, dir: workspace.dir, manifest: workspace.snapshot() };
    }));
    handle('tracker-push', async dir => serialized(dir, async () => {
      const workspace = await checkedWorkspace(dir);
      const result = await sheetService().push(workspace);
      return { ...result, dir: workspace.dir, manifest: workspace.snapshot() };
    }));
    handle('analytics-account', async () => ({ ok: true, ...(await analyticsServices().google.account()) }));
    handle('analytics-setup', async () => analyticsServices().google.setup());
    handle('analytics-connect', async () => analyticsServices().google.connect());
    handle('analytics-report', async input => ({ ok: true, report: await analyticsServices().analytics.analyze(input || {}) }));
    handle('reveal', async dir => { const workspace = await checkedWorkspace(dir); await systemShell.openPath(workspace.dir); return { ok: true }; });
    return true;
  }

  function stop() { locks.clear(); }
  return { register, stop };
}

let singleton;
function register() { singleton = createChannelsBridge(); return singleton.register(); }
function stop() { singleton?.stop(); }

module.exports = { createChannelsBridge, register, stop };
