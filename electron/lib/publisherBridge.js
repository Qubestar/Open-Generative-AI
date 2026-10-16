// YouTube Auto-Publisher Desktop Bridge for Vidmyo V2.6
// Connects YouTube Data API v3 resumable upload adapter to Electron main-process
// Google OAuth token vault (safeStorage) and provides local mock server verification.

const { ipcMain, app, dialog, shell, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { createGoogleOAuth } = require('./googleOAuth');
const { resolveRuntimePaths } = require('./runtimePaths');

let corePromise = null;
function defaultCore() {
  if (!corePromise) {
    const runtime = resolveRuntimePaths({ isPackaged: app?.isPackaged, resourcesPath: process.resourcesPath });
    const entry = path.join(runtime.coreDir, 'index.js');
    corePromise = import(pathToFileURL(entry).href);
  }
  return corePromise;
}

function createLocalMockYouTubeServer() {
  const sessions = new Map(); // uploadId -> { metadata, bytesReceived, totalBytes, done, videoId }
  let uploadedVideos = [];
  const stats = {
    initiates: 0,
    contentRanges: [],
    statusQueries: 0,
    stalledPending: 0,
    abortedWhileStalled: 0,
  };
  const control = {
    quotaOnNextChunk: false,
    stallNextChunk: false,
  };
  const stalled = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Auth verification: ensure Bearer token is provided
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unauthorized: Missing or invalid OAuth Bearer token' } }));
      return;
    }

    // Step 1: Initiate resumable upload
    if (req.method === 'POST' && url.pathname.includes('/upload/youtube/v3/videos')) {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const uploadId = `mock_session_${crypto.randomBytes(6).toString('hex')}`;
        let metadata = {};
        try { metadata = JSON.parse(body); } catch { /* ignore */ }
        sessions.set(uploadId, { metadata, bytesReceived: 0, totalBytes: 0, done: false, videoId: null });
        stats.initiates += 1;

        const uploadUrl = `http://${req.headers.host}/upload_chunk/${uploadId}`;
        res.writeHead(200, {
          'Location': uploadUrl,
          'content-type': 'application/json',
        });
        res.end(JSON.stringify({ uploadUrl, uploadId }));
      });
      return;
    }

    // Step 2: Upload chunk + status query (Content-Range aware, 308 protocol)
    if (req.method === 'PUT' && url.pathname.startsWith('/upload_chunk/')) {
      const uploadId = url.pathname.replace('/upload_chunk/', '');
      const session = sessions.get(uploadId);
      if (!session) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }

      const contentRange = req.headers['content-range'] || '';
      const chunks = [];
      req.on('data', chunk => { chunks.push(chunk); });
      req.on('end', () => {
        // Status query: bytes */Z with empty body
        const statusMatch = /^bytes \*\/(\d+)$/.exec(contentRange);
        if (statusMatch) {
          stats.statusQueries += 1;
          if (session.done) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ id: session.videoId, kind: 'youtube#video' }));
          } else {
            const headers = { 'content-type': 'text/plain' };
            if (session.bytesReceived > 0) headers.Range = `bytes=0-${session.bytesReceived - 1}`;
            // No Location header: fetch must not treat 308 as a redirect.
            res.writeHead(308, headers);
            res.end();
          }
          return;
        }

        // Data chunk: bytes X-Y/Z
        const dataMatch = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
        if (!dataMatch) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `Malformed Content-Range: ${contentRange}` }));
          return;
        }

        if (control.quotaOnNextChunk) {
          control.quotaOnNextChunk = false;
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            error: { errors: [{ reason: 'quotaExceeded', message: 'quotaExceeded' }], message: 'quotaExceeded' },
          }));
          return;
        }

        if (control.stallNextChunk) {
          control.stallNextChunk = false;
          stats.stalledPending += 1;
          stalled.push({ req, res });
          res.on('close', () => {
            if (!res.writableEnded) {
              stats.abortedWhileStalled += 1;
              stats.stalledPending = Math.max(0, stats.stalledPending - 1);
            }
          });
          return;
        }

        const start = Number(dataMatch[1]);
        const end = Number(dataMatch[2]);
        const total = Number(dataMatch[3]);
        const payload = Buffer.concat(chunks);
        if (payload.length !== end - start + 1) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `Payload length ${payload.length} does not match Content-Range` }));
          return;
        }

        stats.contentRanges.push(contentRange);
        session.bytesReceived = end + 1;
        session.totalBytes = total;

        if (session.bytesReceived >= total) {
          session.done = true;
          session.videoId = `yt_mock_${crypto.randomBytes(5).toString('hex')}`;
          uploadedVideos.push({ videoId: session.videoId, metadata: session.metadata, size: session.bytesReceived });

          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            id: session.videoId,
            kind: 'youtube#video',
            status: { uploadStatus: 'uploaded' },
            snippet: session.metadata.snippet || {},
          }));
        } else {
          res.writeHead(308, {
            'content-type': 'text/plain',
            Range: `bytes=0-${session.bytesReceived - 1}`,
          });
          res.end();
        }
      });
      return;
    }

    res.writeHead(404).end();
  });

  return {
    server,
    stats,
    control,
    start() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const port = server.address().port;
          resolve({ port, baseUrl: `http://127.0.0.1:${port}` });
        });
      });
    },
    releaseStalled() {
      while (stalled.length > 0) {
        const { res } = stalled.pop();
        try { res.writeHead(500).end(); } catch { /* client gone */ }
        stats.stalledPending = Math.max(0, stats.stalledPending - 1);
      }
    },
    stop() {
      this.releaseStalled();
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      return new Promise(resolve => server.close(resolve));
    },
    getUploadedVideos() {
      return uploadedVideos;
    },
  };
}

function createPublisherBridge(deps = {}) {
  const application = deps.app || app;
  const dialogs = deps.dialog || dialog;
  const ipc = deps.ipcMain || ipcMain;
  const systemShell = deps.shell || shell;
  const storage = deps.safeStorage || safeStorage;
  const getCore = deps.core || defaultCore;

  const googleOAuth = deps.googleOAuth || (application && storage ? createGoogleOAuth({
    app: application,
    dialog: dialogs,
    safeStorage: storage,
    shell: systemShell,
  }) : null);

  let recordStore = null;
  // publishRecordId -> YouTubePublisherAdapter for in-flight uploads, so
  // publisher:cancel can abort the active HTTP request (not just the record).
  const activeAdapters = new Map();

  async function getRecordStore(core) {
    if (!recordStore) {
      // Durable on-disk queue: survives an app restart (Phase 2 item 4).
      // Default location follows the Electron convention used by the other
      // bridges (story-config/google-oauth live in userData). Tests inject
      // deps.queuePath (explicit null = in-memory); without an `app` (plain
      // Node test runner) the store stays in-memory.
      // PublishRecordStore.load() runs startup reconciliation at this point:
      // a record left in `uploading` by a crash/kill mid-upload is recovered
      // to a resumable `queued` state (session URL + byte progress kept) and
      // resumes through queryUploadStatus instead of being stuck.
      // Resolution order (Phase 3 item 1): explicit dep queuePath ->
      // deps.userDataDir -> app.getPath('userData') -> null (in-memory).
      let queuePath = deps.queuePath;
      if (queuePath === undefined) {
        try {
          if (deps.userDataDir) {
            queuePath = path.join(path.resolve(deps.userDataDir), 'publisher-queue.json');
          } else {
            queuePath = application && typeof application.getPath === 'function'
              ? path.join(application.getPath('userData'), 'publisher-queue.json')
              : null;
          }
        } catch {
          queuePath = null;
        }
      }
      recordStore = new core.PublishRecordStore(queuePath);
    }
    return recordStore;
  }

  // Token provider backed by the main-process safeStorage vault.
  // refreshAccessToken forces a vault refresh (used by the transport on 401).
  // The static test token is ONLY a last-resort fallback for the offline mock
  // path when no vault entry exists — never used by any production transport.
  function createVaultTokenProviders() {
    return {
      getAccessToken: async () => {
        if (googleOAuth) {
          try {
            const token = await googleOAuth.accessToken();
            if (token) return token;
          } catch { /* fall through to mock token */ }
        }
        return 'mock_oauth_vault_token_v26';
      },
      refreshAccessToken: async () => {
        if (googleOAuth) {
          try {
            if (typeof googleOAuth.refresh === 'function') await googleOAuth.refresh();
            const token = await googleOAuth.accessToken();
            if (token) return token;
          } catch { /* fall through to mock token */ }
        }
        return 'mock_oauth_vault_token_v26';
      },
    };
  }

  function register() {
    // 1. Get status of a publication by ID or channelId + videoFileHash
    ipc.handle('publisher:get-status', async (_event, publishId) => {
      try {
        const core = await getCore();
        const store = await getRecordStore(core);
        const record = store.get(publishId);
        return { ok: true, record };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 2. Submit publication job with idempotency and duplicate checking
    ipc.handle('publisher:create-session', async (_event, { channelId, videoPath, metadata = {} }) => {
      try {
        const core = await getCore();
        const store = await getRecordStore(core);

        if (!fs.existsSync(videoPath)) throw new Error(`Video file not found: ${videoPath}`);
        // Stream sha256 to avoid reading multi-gigabyte video into memory
        const videoFileHash = await new Promise((resolve, reject) => {
          const hash = crypto.createHash('sha256');
          const stream = fs.createReadStream(videoPath);
          stream.on('data', chunk => hash.update(chunk));
          stream.on('end', () => resolve(hash.digest('hex')));
          stream.on('error', reject);
        });

        // Check OAuth token availability from safeStorage
        let hasAuth = false;
        let token = null;
        if (googleOAuth) {
          try {
            token = await googleOAuth.accessToken();
            hasAuth = Boolean(token);
          } catch {
            hasAuth = false;
          }
        }

        const record = store.create({
          channelId,
          videoPath,
          videoFileHash,
          metadata,
        });

        return {
          ok: true,
          record,
          authReady: hasAuth,
        };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 3. Test execution against local mock server (NO REAL PUBLISHING)
    ipc.handle('publisher:test-mock-upload', async (_event, { publishId, mockBaseUrl }) => {
      try {
        const core = await getCore();
        const store = await getRecordStore(core);
        const record = store.get(publishId);
        if (!record) throw new Error('Record not found');

        // Privacy boundary enforcement: strictly prohibit uploading local files to external domains
        if (!mockBaseUrl || typeof mockBaseUrl !== 'string') {
          throw new Error('mockBaseUrl is required for test mock upload');
        }
        const parsed = new URL(mockBaseUrl);
        const hostname = parsed.hostname.toLowerCase();
        if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
          throw new Error(`Privacy boundary violation: mockBaseUrl must be a local loopback address (127.0.0.1 or localhost), got ${hostname}`);
        }

        const fileBuffer = fs.readFileSync(record.videoPath);

        // Real resumable transport (Content-Range / 308) against the loopback
        // mock server. Token access + refresh go through the main-process
        // vault via injected providers. baseUrl is the loopback mock — no
        // production Google host is ever contacted on this path.
        const tokenProviders = createVaultTokenProviders();
        const transport = core.createYouTubeResumableTransport({
          ...tokenProviders,
          baseUrl: mockBaseUrl,
        });

        const adapter = new core.YouTubePublisherAdapter({
          store,
          transport,
        });
        activeAdapters.set(publishId, adapter);
        try {
          const updated = await adapter.executeUploadSession(publishId, fileBuffer);
          return {
            ok: true,
            record: updated,
            cancelled: updated.state === core.PUBLISH_STATES.CANCELLED,
          };
        } finally {
          activeAdapters.delete(publishId);
        }
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 4. List all jobs in publisher queue
    ipc.handle('publisher:list-queue', async (_event, filter = {}) => {
      try {
        const core = await getCore();
        const store = await getRecordStore(core);
        const queue = store.listQueue(filter);
        return { ok: true, queue };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 5. Poll processing status (no transport: status polling only)
    ipc.handle('publisher:poll', async (_event, publishId) => {
      try {
        const core = await getCore();
        const store = await getRecordStore(core);
        const adapter = new core.YouTubePublisherAdapter({ store });
        const record = await adapter.pollProcessingStatus(publishId);
        return { ok: true, record };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 6. Cancel queued/uploading publication — aborts the in-flight HTTP
    // request when an upload is running, then transitions the record to
    // terminal 'cancelled'.
    ipc.handle('publisher:cancel', async (_event, publishId) => {
      try {
        const core = await getCore();
        const store = await getRecordStore(core);
        const adapter = activeAdapters.get(publishId);
        const cancelled = adapter
          ? adapter.cancelUpload(publishId)
          : store.cancel(publishId);
        return { ok: true, cancelled, record: store.get(publishId) };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 7. Retry errored publication
    ipc.handle('publisher:retry', async (_event, publishId) => {
      try {
        const core = await getCore();
        const store = await getRecordStore(core);
        const record = store.retry(publishId);
        return { ok: true, record };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    return true;
  }

  return { register, createLocalMockYouTubeServer };
}

let defaultPublisherBridge = null;
function register() {
  if (!defaultPublisherBridge) defaultPublisherBridge = createPublisherBridge();
  return defaultPublisherBridge.register();
}

module.exports = { createPublisherBridge, createLocalMockYouTubeServer, register };
