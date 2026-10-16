// Stream only explicitly granted Cleaner sources; never buffer a whole recording.
const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

function createCleanerMedia() {
  const files = new Map();
  let server;
  let opening;
  let cancelOpening;
  async function grant(file) {
    const resolved = fs.realpathSync(file);
    if (!fs.statSync(resolved).isFile()) throw new Error('Source video is missing');
    if (!opening) {
      server = http.createServer((req, res) => {
        const source = files.get(req.url);
        if (!source || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404).end(); return; }
        let size;
        try { size = fs.statSync(source).size; } catch { res.writeHead(404).end(); return; }
        let start = 0, end = size - 1;
        if (req.headers.range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
          if (!match[1]) start = Math.max(0, size - Number(match[2]));
          else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
        }
        if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
        const mime = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.jpg': 'image/jpeg', '.png': 'image/png', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska' }[path.extname(source).toLowerCase()] || 'video/mp4';
        res.writeHead(req.headers.range ? 206 : 200, {
          'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
          'Cache-Control': 'no-store',
          ...(req.headers.range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
        });
        if (req.method === 'HEAD') { res.end(); return; }
        const stream = fs.createReadStream(source, { start, end });
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
        stream.pipe(res);
      });
      opening = new Promise((resolve, reject) => {
        const current = server;
        cancelOpening = reject;
        current.once('error', error => {
          if (server === current) { server = null; opening = null; cancelOpening = null; }
          reject(error);
        });
        current.listen(0, '127.0.0.1', () => {
          if (server !== current) { current.close(); reject(new Error('Preview service closed. Reload the preview.')); return; }
          cancelOpening = null;
          resolve();
        });
      });
      server.unref();
    }
    const current = server;
    await opening;
    const address = current?.address();
    if (server !== current || !address || typeof address === 'string') {
      throw new Error('Preview service restarted. Reload the preview.');
    }
    let token = [...files].find(([, value]) => value === resolved)?.[0];
    if (!token) { token = `/${crypto.randomBytes(32).toString('hex')}`; files.set(token, resolved); }
    return `http://127.0.0.1:${address.port}${token}`;
  }
  return { grant, close() {
    const current = server;
    server = null;
    opening = null;
    cancelOpening?.(new Error('Preview service closed. Reload the preview.'));
    cancelOpening = null;
    files.clear();
    current?.closeAllConnections();
    if (current?.listening) current.close();
    // If listen is pending, its callback above closes this retired server.
  } };
}

module.exports = { createCleanerMedia };
