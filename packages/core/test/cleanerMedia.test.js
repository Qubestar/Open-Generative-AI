import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { createCleanerMedia } = createRequire(import.meta.url)('../../../electron/lib/cleanerMedia.js');

test('Cleaner preview service can reopen after shutdown and revoke old grants', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cleaner-reopen-'));
  const file = path.join(folder, 'clip.mp4'); fs.writeFileSync(file, 'preview');
  const media = createCleanerMedia();
  try {
    const old = await media.grant(file);
    media.close(); media.close();
    const [first, second] = await Promise.all([media.grant(file), media.grant(file)]);
    assert.equal(first, second);
    assert.notEqual(new URL(first).pathname, new URL(old).pathname);
    assert.equal(await (await fetch(first)).text(), 'preview');
  } finally { media.close(); fs.rmSync(folder, { recursive:true, force:true }); }
});

test('closing during preview startup fails cleanly and allows a later retry', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cleaner-startup-'));
  const file = path.join(folder, 'clip.mp4'); fs.writeFileSync(file, 'preview');
  const media = createCleanerMedia();
  try {
    const pending = media.grant(file);
    media.close();
    await assert.rejects(pending, /Preview service closed/);
    const next = await media.grant(file);
    assert.equal(await (await fetch(next)).text(), 'preview');
  } finally { media.close(); fs.rmSync(folder, { recursive:true, force:true }); }
});

test('Cleaner streaming supports seeks and rejects ungranted paths and invalid ranges', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cleaner-stream-'));
  const file = path.join(folder, 'clip.mp4');
  fs.writeFileSync(file, '0123456789');
  const media = createCleanerMedia();
  try {
    const url = await media.grant(file);
    const response = await fetch(url, { headers: { Range: 'bytes=3-6' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 3-6/10');
    assert.equal(await response.text(), '3456');
    assert.equal(await (await fetch(url, { headers: { Range: 'bytes=-2' } })).text(), '89');
    assert.equal((await fetch(url, { headers: { Range: 'bytes=40-50' } })).status, 416);
    assert.equal((await fetch(new URL('/etc/passwd', url))).status, 404);
    assert.equal((await fetch(url, { method: 'POST' })).status, 404);
  } finally { media.close(); fs.rmSync(folder, { recursive: true, force: true }); }
});

test('Narration previews declare audio content types and support range playback', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-audio-'));
  const media = createCleanerMedia();
  try {
    for (const [extension, mime] of [['wav', 'audio/wav'], ['mp3', 'audio/mpeg'], ['m4a', 'audio/mp4']]) {
      const file = path.join(folder, `voice.${extension}`);
      fs.writeFileSync(file, '0123456789');
      const url = await media.grant(file);
      const response = await fetch(url, { headers: { Range: 'bytes=0-3' } });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-type'), mime);
      assert.equal(await response.text(), '0123');
    }
  } finally { media.close(); fs.rmSync(folder, { recursive: true, force: true }); }
});
