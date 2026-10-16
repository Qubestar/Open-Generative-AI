// Phase 2 Item 5 — Managed model packages (Kokoro/ASR).
//
// Everything runs against a LOCAL loopback HTTP fixture server with small
// files — no large real model downloads, no invented checksums/versions.
// Real upstream entries stay `manifest-pending` and are refused at install.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {
  ModelPackageManager,
  validatePackageManifest,
  BUILTIN_MODEL_CATALOG,
  MANIFEST_PENDING,
} from '../index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// Loopback fixture server with HTTP Range support (206 + Content-Range),
// optional mid-body disconnects for resume tests, and request logging.
function createFixtureServer(payload, { dropAfterBytesOnce = 0 } = {}) {
  const state = { dropAfterBytes: dropAfterBytesOnce, requests: [] };
  const server = http.createServer((req, res) => {
    const range = req.headers.range || null;
    state.requests.push({ method: req.method, url: req.url, range });

    let start = 0;
    let status = 200;
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(payload.length),
      'Accept-Ranges': 'bytes',
    };

    if (range) {
      const m = /^bytes=(\d+)-$/.exec(range);
      if (!m) {
        res.writeHead(400).end();
        return;
      }
      start = Number(m[1]);
      if (start >= payload.length) {
        res.writeHead(416, { 'Content-Range': `bytes */${payload.length}` });
        res.end();
        return;
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${payload.length - 1}/${payload.length}`;
      headers['Content-Length'] = String(payload.length - start);
    }

    const body = payload.subarray(start);

    if (state.dropAfterBytes > 0) {
      // Send a prefix, then destroy the socket mid-body — simulates an
      // interrupted download so the next request must resume with Range.
      const cut = Math.min(state.dropAfterBytes, body.length);
      state.dropAfterBytes = 0;
      res.writeHead(status, headers);
      res.write(body.subarray(0, cut));
      setTimeout(() => {
        try { res.socket.destroy(); } catch { /* already gone */ }
      }, 15);
      return;
    }

    res.writeHead(status, headers);
    res.end(body);
  });

  return {
    state,
    async start() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const { port } = server.address();
      return { port, baseUrl: `http://127.0.0.1:${port}` };
    },
    async stop() {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

async function withFixture(payload, opts, fn) {
  const server = createFixtureServer(payload, opts);
  const { baseUrl } = await server.start();
  try {
    return await fn(baseUrl, server);
  } finally {
    await server.stop();
  }
}

function makeManifest(baseUrl, payload, overrides = {}) {
  return {
    name: 'test-model',
    version: '1.0.0',
    sha256: sha256(payload),
    license: 'Apache-2.0',
    sourceUrl: `${baseUrl}/test-model.bin`,
    fileName: 'test-model.bin',
    status: 'ready',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------
test('validatePackageManifest accepts a complete entry and rejects each missing field with an exact reason', () => {
  const payload = Buffer.from('x');
  const good = {
    name: 'test-model',
    version: '1.0.0',
    sha256: sha256(payload),
    license: 'Apache-2.0',
    sourceUrl: 'https://example.com/test-model.bin',
    status: 'ready',
  };
  assert.deepEqual(validatePackageManifest(good), { ok: true, pending: false, reasons: [] });

  const noVersion = validatePackageManifest({ ...good, version: null });
  assert.equal(noVersion.ok, false);
  assert.ok(noVersion.reasons.some((r) => /version is required/.test(r)));

  const noSha = validatePackageManifest({ ...good, sha256: 'deadbeef' });
  assert.equal(noSha.ok, false);
  assert.ok(noSha.reasons.some((r) => /64-char hex/.test(r)));

  const noLicense = validatePackageManifest({ ...good, license: '' });
  assert.equal(noLicense.ok, false);
  assert.ok(noLicense.reasons.some((r) => /license is required/.test(r)));

  const noUrl = validatePackageManifest({ ...good, sourceUrl: 'not-a-url' });
  assert.equal(noUrl.ok, false);
  assert.ok(noUrl.reasons.some((r) => /sourceUrl must be an http/.test(r)));

  // manifest-pending placeholder is structurally valid (but not installable)
  const pending = validatePackageManifest({ name: 'kokoro-tts', status: MANIFEST_PENDING });
  assert.deepEqual(pending, { ok: true, pending: true, reasons: [] });
});

test('builtin Kokoro/ASR catalog entries are manifest-pending with no invented checksums', () => {
  const names = BUILTIN_MODEL_CATALOG.map((m) => m.name);
  assert.ok(names.includes('kokoro-tts'));
  assert.ok(names.includes('whisper-asr'));
  for (const entry of BUILTIN_MODEL_CATALOG) {
    assert.equal(entry.status, MANIFEST_PENDING);
    assert.equal(entry.sha256, null, `${entry.name}: sha256 must NOT be invented`);
    assert.equal(entry.version, null, `${entry.name}: version must NOT be invented`);
    assert.equal(entry.sourceUrl, null, `${entry.name}: sourceUrl must NOT be invented`);
    assert.equal(entry.license, null, `${entry.name}: licence must NOT be claimed without verification`);
    const v = validatePackageManifest(entry);
    assert.equal(v.pending, true);
  }
});

// ---------------------------------------------------------------------------
// Install / verify / uninstall against the local fixture
// ---------------------------------------------------------------------------
test('install downloads, SHA-256 verifies, writes a receipt; verify and uninstall work', async () => {
  const payload = crypto.randomBytes(48 * 1024); // 48 KiB — small fixture
  await withFixture(payload, {}, async (baseUrl, server) => {
    const packagesDir = tempDir('vidmyo-models-ok-');
    const mgr = new ModelPackageManager({ packagesDir });
    const manifest = makeManifest(baseUrl, payload);

    const result = await mgr.install(manifest);
    assert.equal(result.alreadyInstalled, false);
    assert.equal(result.sha256, sha256(payload));
    assert.equal(result.bytes, payload.length);
    assert.ok(fs.existsSync(result.path));
    assert.equal(path.extname(result.path), '.bin');
    // No .part left behind
    assert.equal(fs.existsSync(`${result.path}.part`), false);

    // Receipt contents: name, version, sha256, licence, source URL
    const receipt = JSON.parse(fs.readFileSync(path.join(packagesDir, 'test-model', 'receipt.json'), 'utf8'));
    assert.equal(receipt.name, 'test-model');
    assert.equal(receipt.version, '1.0.0');
    assert.equal(receipt.sha256, sha256(payload));
    assert.equal(receipt.license, 'Apache-2.0');
    assert.equal(receipt.sourceUrl, `${baseUrl}/test-model.bin`);

    // verify(): fresh hash against receipt
    const v = mgr.verify('test-model');
    assert.equal(v.ok, true);
    assert.equal(v.actualSha256, sha256(payload));

    // Tamper detection: corrupt the installed file -> verify fails
    fs.appendFileSync(result.path, Buffer.from([0x00]));
    const v2 = mgr.verify('test-model');
    assert.equal(v2.ok, false);
    assert.match(v2.reason, /checksum mismatch/);

    // Idempotent re-install after corruption re-downloads and restores
    server.state.requests.length = 0;
    const reinstall = await mgr.install(manifest);
    assert.equal(reinstall.sha256, sha256(payload));
    assert.equal(mgr.verify('test-model').ok, true);

    // status()
    const st = mgr.status('test-model');
    assert.equal(st.installed, true);
    assert.equal(st.verified, true);
    assert.equal(st.installable, true);
    assert.equal(st.pending, false);

    // uninstall removes the directory
    const un = mgr.uninstall('test-model');
    assert.equal(un.removed, true);
    assert.equal(fs.existsSync(path.join(packagesDir, 'test-model')), false);
    assert.equal(mgr.status('test-model').installed, false);
    assert.equal(mgr.uninstall('test-model').removed, false, 'second uninstall is a no-op');

    fs.rmSync(packagesDir, { recursive: true, force: true });
  });
});

test('install resumes an interrupted download via HTTP Range and still passes checksum', async () => {
  const payload = crypto.randomBytes(32 * 1024); // 32 KiB
  // Drop the socket after the first 8 KiB of the FIRST response.
  await withFixture(payload, { dropAfterBytesOnce: 8 * 1024 }, async (baseUrl, server) => {
    const packagesDir = tempDir('vidmyo-models-resume-');
    const mgr = new ModelPackageManager({ packagesDir });
    const manifest = makeManifest(baseUrl, payload, { name: 'resume-model', fileName: 'resume-model.bin' });

    // Attempt 1: network dies mid-body — part-file must survive.
    await assert.rejects(mgr.install(manifest), /socket hang up|terminated|ECONNRESET|unexpected/i);
    const partPath = path.join(packagesDir, 'resume-model', 'resume-model.bin.part');
    assert.ok(fs.existsSync(partPath), 'partial .part file must be preserved for resume');
    const partialSize = fs.statSync(partPath).size;
    assert.ok(partialSize > 0 && partialSize < payload.length,
      `partial size ${partialSize} should be within (0, ${payload.length})`);

    // Attempt 2: resumes with Range: bytes=N-
    const result = await mgr.install(manifest);
    assert.equal(result.alreadyInstalled, false);
    assert.equal(result.sha256, sha256(payload), 'resumed download must pass SHA-256 verification');
    assert.equal(result.resumedFromBytes, partialSize, 'resume must start exactly where the part-file ended');
    assert.equal(fs.existsSync(partPath), false, '.part renamed to final file');

    const rangeRequests = server.state.requests.filter((r) => r.range);
    assert.ok(rangeRequests.length >= 1, 'second request must carry a Range header');
    assert.equal(rangeRequests[0].range, `bytes=${partialSize}-`);

    assert.equal(mgr.verify('resume-model').ok, true);
    fs.rmSync(packagesDir, { recursive: true, force: true });
  });
});

test('install rejects a checksum mismatch and removes the poisoned part-file', async () => {
  const payload = crypto.randomBytes(4096);
  await withFixture(payload, {}, async (baseUrl) => {
    const packagesDir = tempDir('vidmyo-models-badsha-');
    const mgr = new ModelPackageManager({ packagesDir });
    const manifest = makeManifest(baseUrl, payload, {
      name: 'badsha-model',
      fileName: 'badsha-model.bin',
      sha256: 'a'.repeat(64), // deliberately wrong digest
    });

    await assert.rejects(mgr.install(manifest), /Checksum mismatch/);

    const dir = path.join(packagesDir, 'badsha-model');
    assert.equal(fs.existsSync(path.join(dir, 'badsha-model.bin')), false, 'no final file after mismatch');
    assert.equal(fs.existsSync(path.join(dir, 'badsha-model.bin.part')), false,
      'poisoned part-file must be deleted, never renamed into place');
    assert.equal(fs.existsSync(path.join(dir, 'receipt.json')), false, 'no receipt after mismatch');
    assert.equal(mgr.status('badsha-model').installed, false);

    fs.rmSync(packagesDir, { recursive: true, force: true });
  });
});

test('install refuses manifest-pending entries without any network call', async () => {
  const packagesDir = tempDir('vidmyo-models-pending-');
  let fetchCalls = 0;
  const mgr = new ModelPackageManager({
    packagesDir,
    fetchImpl: async () => { fetchCalls += 1; throw new Error('network must not be used'); },
  });

  for (const entry of BUILTIN_MODEL_CATALOG) {
    await assert.rejects(
      mgr.install(entry.name),
      /manifest-pending/,
      `${entry.name} must refuse install while pending`,
    );
    await assert.rejects(mgr.install(entry), /manifest-pending/);
  }
  assert.equal(fetchCalls, 0, 'no fetch may happen for pending entries');
  assert.equal(mgr.status('kokoro-tts').installable, false);
  assert.equal(mgr.status('kokoro-tts').pending, true);
  assert.equal(mgr.status('whisper-asr').installable, false);

  fs.rmSync(packagesDir, { recursive: true, force: true });
});

test('install validates manifest fields before touching the network', async () => {
  const packagesDir = tempDir('vidmyo-models-invalid-');
  let fetchCalls = 0;
  const mgr = new ModelPackageManager({
    packagesDir,
    fetchImpl: async () => { fetchCalls += 1; throw new Error('network must not be used'); },
  });

  await assert.rejects(
    mgr.install({ name: 'x', version: null, sha256: null, license: null, sourceUrl: null }),
    /Invalid package manifest/,
  );
  await assert.rejects(mgr.install('does-not-exist'), /Unknown model package/);
  assert.equal(fetchCalls, 0);

  fs.rmSync(packagesDir, { recursive: true, force: true });
});

test('already-installed package is returned idempotently without re-downloading', async () => {
  const payload = crypto.randomBytes(8192);
  await withFixture(payload, {}, async (baseUrl, server) => {
    const packagesDir = tempDir('vidmyo-models-idem-');
    const mgr = new ModelPackageManager({ packagesDir });
    const manifest = makeManifest(baseUrl, payload, { name: 'idem-model', fileName: 'idem-model.bin' });

    await mgr.install(manifest);
    const requestsAfterFirst = server.state.requests.length;

    const second = await mgr.install(manifest);
    assert.equal(second.alreadyInstalled, true);
    assert.equal(second.sha256, sha256(payload));
    assert.equal(server.state.requests.length, requestsAfterFirst, 'no second HTTP request');

    fs.rmSync(packagesDir, { recursive: true, force: true });
  });
});

test('HTTP error status fails the install without leaving a final file', async () => {
  const payload = crypto.randomBytes(1024);
  await withFixture(payload, {}, async (baseUrl) => {
    const packagesDir = tempDir('vidmyo-models-404-');
    const mgr = new ModelPackageManager({ packagesDir });
    const manifest = makeManifest(baseUrl, payload, {
      name: 'gone-model',
      fileName: 'gone-model.bin',
      sourceUrl: `${baseUrl}/missing.bin`,
    });
    // Point the install at a dedicated server that always 404s:
    const fourOhFour = http.createServer((req, res) => { res.writeHead(404).end('nope'); });
    await new Promise((r) => fourOhFour.listen(0, '127.0.0.1', r));
    const notFoundUrl = `http://127.0.0.1:${fourOhFour.address().port}/missing.bin`;
    try {
      const mgr404 = new ModelPackageManager({ packagesDir });
      await assert.rejects(
        mgr404.install({ ...manifest, sourceUrl: notFoundUrl }),
        /HTTP 404/,
      );
      assert.equal(fs.existsSync(path.join(packagesDir, 'gone-model', 'gone-model.bin')), false);
      assert.equal(fs.existsSync(path.join(packagesDir, 'gone-model', 'receipt.json')), false);
    } finally {
      if (typeof fourOhFour.closeAllConnections === 'function') fourOhFour.closeAllConnections();
      await new Promise((r) => fourOhFour.close(r));
      fs.rmSync(packagesDir, { recursive: true, force: true });
    }
  });
  await sleep(1);
});
