// Loopback resumable-upload mock of the YouTube Data API v3 for OFFLINE tests.
//
// Speaks the real resumable protocol so createYouTubeResumableTransport can be
// exercised end-to-end without any network access:
//   - POST  /upload/youtube/v3/videos...  -> 200 + Location (initiate)
//   - PUT   /upload_chunk/:id
//       Content-Range: bytes X-Y/Z  -> accumulate; 308 + Range while partial,
//                                       200 {id} when complete
//       Content-Range: bytes */Z     -> status query; 308 + Range or 200 {id}
//
// Test controls (mutate `control` between calls):
//   - rejectTokens: Set of Bearer tokens that always get 401 (token-refresh tests)
//   - quotaOnNextChunk: next data-chunk PUT returns 403 quotaExceeded
//   - stallNextChunk: next data-chunk PUT never responds until releaseStalled()
//                     or client abort (cancel / in-flight abort tests)
//
// Never binds outside 127.0.0.1. No real YouTube call is ever made.

import http from 'node:http';
import crypto from 'node:crypto';

export function createLoopbackResumableMockServer() {
  const sessions = new Map(); // uploadId -> { metadata, bytesReceived, totalBytes, done, videoId }
  const uploadedVideos = [];
  const stalled = [];
  const stats = {
    initiates: 0,
    unauthorized: 0,
    contentRanges: [], // data-chunk Content-Range headers in arrival order
    statusQueries: 0,
    stalledPending: 0,
    abortedWhileStalled: 0,
  };
  const control = {
    rejectTokens: new Set(),
    quotaOnNextChunk: false,
    stallNextChunk: false,
  };

  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization;
    const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token || control.rejectTokens.has(token)) {
      stats.unauthorized += 1;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unauthorized', code: 401 } }));
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    // ── Initiate ────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname.includes('/upload/youtube/v3/videos')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let metadata = {};
        try { metadata = JSON.parse(body); } catch { /* keep empty */ }
        const uploadId = `mock_${crypto.randomBytes(6).toString('hex')}`;
        sessions.set(uploadId, { metadata, bytesReceived: 0, totalBytes: 0, done: false, videoId: null });
        stats.initiates += 1;
        // NOTE: no redirect semantics — absolute Location like the real API.
        res.writeHead(200, {
          'Location': `http://${req.headers.host}/upload_chunk/${uploadId}`,
          'content-type': 'application/json',
        });
        res.end(JSON.stringify({ uploadId }));
      });
      return;
    }

    // ── Chunk PUT + status query ────────────────────────────────────────────
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
      req.on('data', (c) => { chunks.push(c); });
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
            // CRITICAL: no Location header — fetch must NOT treat 308 as a redirect.
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
        session.bytesReceived = end + 1; // sequential client
        session.totalBytes = total;

        if (session.bytesReceived >= total) {
          session.done = true;
          session.videoId = `yt_http_${crypto.randomBytes(5).toString('hex')}`;
          uploadedVideos.push({
            videoId: session.videoId,
            metadata: session.metadata,
            size: session.bytesReceived,
          });
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
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      return { port, baseUrl: `http://127.0.0.1:${port}` };
    },
    releaseStalled() {
      while (stalled.length > 0) {
        const { res } = stalled.pop();
        try {
          res.writeHead(500).end();
        } catch { /* client gone */ }
        stats.stalledPending = Math.max(0, stats.stalledPending - 1);
      }
    },
    async stop() {
      this.releaseStalled();
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
    getUploadedVideos() {
      return uploadedVideos.slice();
    },
  };
}
