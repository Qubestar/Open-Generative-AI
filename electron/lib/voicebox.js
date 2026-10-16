// Voicebox 0.5 local narration API. Only loopback endpoints are accepted.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_ENDPOINT = 'http://127.0.0.1:17493';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'canceled', 'not_found']);
const LANGUAGE_CODES = new Map([
  ['chinese', 'zh'], ['english', 'en'], ['japanese', 'ja'], ['korean', 'ko'],
  ['german', 'de'], ['french', 'fr'], ['russian', 'ru'], ['portuguese', 'pt'],
  ['spanish', 'es'], ['italian', 'it'], ['hebrew', 'he'], ['arabic', 'ar'],
  ['danish', 'da'], ['greek', 'el'], ['finnish', 'fi'], ['hindi', 'hi'],
  ['malay', 'ms'], ['dutch', 'nl'], ['norwegian', 'no'], ['polish', 'pl'],
  ['swedish', 'sv'], ['swahili', 'sw'], ['turkish', 'tr'],
]);
const SUPPORTED_LANGUAGES = new Set(LANGUAGE_CODES.values());

function endpointUrl(value = DEFAULT_ENDPOINT) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Voicebox endpoint is invalid.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('Voicebox must use a local loopback HTTP endpoint.');
  }
  return url;
}

function requestSignal(signal, timeoutMs) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}

async function responseMessage(response) {
  try {
    const data = await response.json();
    const detail = Array.isArray(data?.detail)
      ? data.detail.map(item => item?.msg).filter(Boolean).join('; ')
      : data?.detail;
    return String(detail || data?.error || '').slice(0, 500);
  } catch { return ''; }
}

function voiceboxLanguage(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  const direct = normalized.split('-')[0];
  if (SUPPORTED_LANGUAGES.has(direct)) return direct;
  const named = LANGUAGE_CODES.get(normalized);
  if (named) return named;
  throw new Error(`Voicebox does not support the narration language “${String(value || '').trim() || 'unknown'}”.`);
}

function normalizeProfiles(value) {
  if (!Array.isArray(value)) throw new Error('Voicebox returned an invalid profile list.');
  return value.flatMap(profile => {
    const id = String(profile?.id || '');
    const name = String(profile?.name || '').trim().slice(0, 160);
    return ID_RE.test(id) && name ? [{ id, name }] : [];
  });
}

async function voiceboxStatus({ endpoint = DEFAULT_ENDPOINT, fetchImpl = fetch, signal } = {}) {
  const base = endpointUrl(endpoint);
  try {
    const response = await fetchImpl(new URL('/profiles', base), { redirect: 'manual', signal: requestSignal(signal, 3000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const voices = normalizeProfiles(await response.json());
    if (!voices.length) return { ok: true, available: false, voices, error: 'Voicebox is running, but it has no voice profiles. Create or import a profile in Voicebox, then check again.' };
    return { ok: true, available: true, voices };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: true, available: false, voices: [], error: `Voicebox is unavailable. Open the Voicebox app and try again (${error.message}).` };
  }
}

function splitNarration(text, limit = 600) {
  const chunks = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const candidate = rest.slice(0, limit + 1);
    let cut = Math.max(candidate.lastIndexOf('\n\n'), candidate.lastIndexOf('. ') + 1, candidate.lastIndexOf('! ') + 1, candidate.lastIndexOf('? ') + 1);
    if (cut < Math.floor(limit / 3)) cut = candidate.lastIndexOf(' ', limit);
    if (cut < 1) cut = limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function parseStatus(text) {
  const entries = String(text).split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(Boolean);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(entries[index]); } catch { /* Ignore heartbeat/non-JSON SSE data. */ }
  }
  throw new Error('Voicebox returned an invalid generation status.');
}

async function generationStatus(response) {
  if (!response.body?.getReader) return parseStatus(await response.text());
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let latest = null;
  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = pending.split(/\r?\n/);
    pending = done ? '' : lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      try {
        const value = JSON.parse(line.slice(5).trim());
        latest = value;
        if (TERMINAL_STATUSES.has(value?.status)) {
          try { await reader.cancel(); } catch {}
          return value;
        }
      } catch { /* Ignore heartbeat/non-JSON SSE data. */ }
    }
    if (done) break;
  }
  if (latest) return latest;
  throw new Error('Voicebox returned an invalid generation status.');
}

async function cancelGeneration(fetchImpl, base, generationId) {
  try {
    await fetchImpl(new URL(`/generate/${encodeURIComponent(generationId)}/cancel`, base), {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(3000),
    });
  } catch { /* Cancellation is best-effort because the local server may be closing. */ }
}

async function createVoiceboxNarration({
  text, outWav, voiceId, language = 'en', endpoint = DEFAULT_ENDPOINT,
  approved = false, run, signal, fetchImpl = fetch, ffmpegPath = 'ffmpeg',
}) {
  if (!approved) throw new Error('Approve local Voicebox narration before generating a voiceover. Use only a voice you own or have permission to use.');
  if (typeof text !== 'string' || !text.trim() || text.length > 30000) throw new Error('Narration must contain between 1 and 30,000 characters.');
  if (!ID_RE.test(String(voiceId || ''))) throw new Error('Choose a valid Voicebox voice profile.');
  if (!path.isAbsolute(outWav) || typeof run !== 'function') throw new Error('Narration output and converter are required.');
  const base = endpointUrl(endpoint);
  const languageCode = voiceboxLanguage(language);
  signal?.throwIfAborted();
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ text, voiceId, language: languageCode })).digest('hex');
  const cacheDir = path.join(path.dirname(outWav), '.vidmyo', 'voicebox', fingerprint);
  fs.mkdirSync(cacheDir, { recursive: true });
  const chunks = splitNarration(text);
  const wavs = [];
  for (let index = 0; index < chunks.length; index += 1) {
    signal?.throwIfAborted();
    const chunkFile = path.join(cacheDir, `${String(index).padStart(3, '0')}.wav`);
    wavs.push(chunkFile);
    if (fs.existsSync(chunkFile) && fs.statSync(chunkFile).size >= 44) continue;
    let response;
    try {
      response = await fetchImpl(new URL('/generate', base), {
        method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' }, signal: requestSignal(signal, 30000),
        body: JSON.stringify({ profile_id: voiceId, text: chunks[index], language: languageCode, normalize: true }),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(`Voicebox is unavailable. Open the Voicebox app and try again (${error.message}).`);
    }
    if (!response.ok) { const detail = await responseMessage(response); throw new Error(`Voicebox could not start narration (HTTP ${response.status}${detail ? `: ${detail}` : ''}).`); }
    const started = await response.json();
    if (!ID_RE.test(String(started?.id || ''))) throw new Error('Voicebox returned an invalid generation ID.');
    const generationId = started.id;
    try {
      signal?.throwIfAborted();
      const statusResponse = await fetchImpl(new URL(`/generate/${encodeURIComponent(generationId)}/status`, base), {
        redirect: 'manual', signal: requestSignal(signal, 15 * 60 * 1000),
      });
      if (!statusResponse.ok) throw new Error(`Voicebox status check failed (HTTP ${statusResponse.status}).`);
      const status = await generationStatus(statusResponse);
      if (status.status !== 'completed') {
        const detail = status.error ? `: ${String(status.error).slice(0, 500)}` : '.';
        throw new Error(`Voicebox narration ${status.status === 'not_found' ? 'could not be found' : status.status}${detail}`);
      }
      signal?.throwIfAborted();
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') await cancelGeneration(fetchImpl, base, generationId);
      if (error?.name === 'TimeoutError') throw new Error('Voicebox narration timed out after 15 minutes.');
      throw error;
    }
    const audio = await fetchImpl(new URL(`/audio/${encodeURIComponent(generationId)}`, base), { redirect: 'manual', signal: requestSignal(signal, 180000) });
    if (!audio.ok) throw new Error(`Voicebox audio download failed (HTTP ${audio.status}).`);
    const bytes = Buffer.from(await audio.arrayBuffer());
    if (bytes.length < 44 || bytes.length > 256 * 1024 * 1024 || bytes.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Voicebox returned an invalid or oversized WAV file.');
    const temp = `${chunkFile}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(temp, bytes, { mode: 0o600 }); fs.renameSync(temp, chunkFile);
  }
  signal?.throwIfAborted();
  const tempWav = `${outWav}.${crypto.randomBytes(4).toString('hex')}.wav`;
  try {
    if (wavs.length === 1) fs.copyFileSync(wavs[0], tempWav);
    else {
      const inputs = wavs.flatMap(file => ['-i', file]);
      const filter = `${wavs.map((_, index) => `[${index}:a]`).join('')}concat=n=${wavs.length}:v=0:a=1[a]`;
      await run(ffmpegPath, ['-v', 'error', '-y', ...inputs, '-filter_complex', filter, '-map', '[a]', '-ar', '24000', '-ac', '1', tempWav]);
    }
    signal?.throwIfAborted();
    if (!fs.existsSync(tempWav) || fs.statSync(tempWav).size < 44) throw new Error('Voicebox conversion produced no usable WAV.');
    fs.renameSync(tempWav, outWav);
  } finally { try { fs.unlinkSync(tempWav); } catch {} }
  return { source: 'voicebox', artifact: outWav, voiceId, fingerprint };
}

module.exports = { DEFAULT_ENDPOINT, endpointUrl, voiceboxLanguage, normalizeProfiles, splitNarration, parseStatus, generationStatus, voiceboxStatus, createVoiceboxNarration };
