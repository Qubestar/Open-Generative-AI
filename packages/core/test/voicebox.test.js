import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { endpointUrl, voiceboxLanguage, voiceboxStatus, createVoiceboxNarration, splitNarration } = createRequire(import.meta.url)('../../../electron/lib/voicebox.js');
const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(40)]);

test('Voicebox accepts only loopback HTTP endpoints', () => {
  assert.equal(endpointUrl().origin, 'http://127.0.0.1:17493');
  assert.throws(() => endpointUrl('https://127.0.0.1:17493'), /loopback/);
  assert.throws(() => endpointUrl('http://example.com:17493'), /loopback/);
  assert.throws(() => endpointUrl('http://127.0.0.1:17493/prefix'), /loopback/);
  assert.equal(voiceboxLanguage('Polish'), 'pl');
  assert.equal(voiceboxLanguage('en-US'), 'en');
  assert.throws(() => voiceboxLanguage('Klingon'), /does not support/);
});

test('Voicebox status discovers and sanitizes local profiles', async () => {
  const status = await voiceboxStatus({ fetchImpl: async (url, options) => {
    assert.equal(new URL(url).pathname, '/profiles');
    assert.equal(options.redirect, 'manual');
    return { ok: true, json: async () => [{ id: 'voice-1', name: ' Narrator ' }, { id: '../bad', name: 'Bad' }] };
  } });
  assert.deepEqual(status, { ok: true, available: true, voices: [{ id: 'voice-1', name: 'Narrator' }] });
  const missing = await voiceboxStatus({ fetchImpl: async () => { throw new Error('connect refused'); } });
  assert.equal(missing.available, false); assert.match(missing.error, /Open the Voicebox app/);
  const empty = await voiceboxStatus({ fetchImpl: async () => ({ ok: true, json: async () => [] }) });
  assert.equal(empty.available, false); assert.match(empty.error, /no voice profiles/i);
});

test('Voicebox generation streams SSE, saves a WAV, and keys cache by voice', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-voicebox-'));
  const calls = []; let sequence = 0;
  const statusStream = () => {
    const chunks = ['data: {"status":"running"}\n\n', 'data: {"status":"completed"}\n\n'].map(value => new TextEncoder().encode(value));
    return { ok: true, body: { getReader: () => ({ read: async () => chunks.length ? { done: false, value: chunks.shift() } : { done: true }, cancel: async () => {} }) } };
  };
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname; calls.push(pathname);
    assert.equal(options.redirect, 'manual');
    if (pathname === '/generate') { sequence += 1; const body = JSON.parse(options.body); assert.equal(body.profile_id, 'voice-a'); assert.equal(body.language, 'pl'); return { ok: true, json: async () => ({ id: `job-${sequence}` }) }; }
    if (pathname.endsWith('/status')) return statusStream();
    return { ok: true, arrayBuffer: async () => wav };
  };
  try {
    const out = path.join(dir, 'voice.wav');
    const first = await createVoiceboxNarration({ text: 'Hello world.', outWav: out, voiceId: 'voice-a', language: 'Polish', approved: true, run: async () => {}, fetchImpl });
    assert.equal(first.source, 'voicebox'); assert(fs.existsSync(out));
    await createVoiceboxNarration({ text: 'Hello world.', outWav: out, voiceId: 'voice-a', language: 'Polish', approved: true, run: async () => {}, fetchImpl });
    assert.equal(calls.filter(value => value === '/generate').length, 1);
    await createVoiceboxNarration({ text: 'Hello world.', outWav: out, voiceId: 'voice-b', approved: true, run: async () => {}, fetchImpl: async (url, options = {}) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/generate') { assert.equal(JSON.parse(options.body).profile_id, 'voice-b'); return { ok: true, json: async () => ({ id: 'job-b' }) }; }
      if (pathname.endsWith('/status')) return statusStream();
      return { ok: true, arrayBuffer: async () => wav };
    } });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Voicebox cancellation stops an active server generation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-voicebox-cancel-'));
  const controller = new AbortController();
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname; calls.push([pathname, options.method || 'GET']);
    if (pathname === '/generate') return { ok: true, json: async () => ({ id: 'job-active' }) };
    if (pathname.endsWith('/cancel')) return { ok: true };
    if (pathname.endsWith('/status')) {
      setImmediate(() => controller.abort(new DOMException('Stopped by user', 'AbortError')));
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    }
    throw new Error(`Unexpected request ${pathname}`);
  };
  try {
    await assert.rejects(createVoiceboxNarration({
      text: 'Hello', outWav: path.join(dir, 'voice.wav'), voiceId: 'voice-a', approved: true,
      run: async () => {}, fetchImpl, signal: controller.signal,
    }), /Stopped by user|abort/i);
    assert.deepEqual(calls.at(-1), ['/generate/job-active/cancel', 'POST']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Voicebox generation requires consent and honors cancellation before requests', async () => {
  let calls = 0; const controller = new AbortController(); controller.abort();
  const input = { text: 'Hello', outWav: '/tmp/voice.wav', voiceId: 'voice-a', run: async () => {}, fetchImpl: async () => { calls += 1; } };
  await assert.rejects(createVoiceboxNarration(input), /Approve local Voicebox/);
  await assert.rejects(createVoiceboxNarration({ ...input, approved: true, signal: controller.signal }), /abort/i);
  assert.equal(calls, 0);
  assert(splitNarration('Sentence. '.repeat(100)).every(chunk => chunk.length <= 600));
});
