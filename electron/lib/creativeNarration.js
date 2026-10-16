// Multilingual voiceover using the existing ElevenLabs account. The host owns consent.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_VOICE = 'pNInz6obpgDQGcFmaJgB';
const DEFAULT_MODEL = 'eleven_multilingual_v2';

function splitNarration(text, limit = 9000) {
  const chunks = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const candidate = rest.slice(0, limit);
    let cut = Math.max(candidate.lastIndexOf('\n'), candidate.lastIndexOf('. ') + 1);
    if (cut < limit / 2) cut = candidate.lastIndexOf(' ');
    if (cut < 1) cut = limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function createElevenLabsNarration({
  text, outWav, key, voiceId = DEFAULT_VOICE, modelId = DEFAULT_MODEL,
  approved = false, run, signal, fetchImpl = fetch,
}) {
  if (!approved) throw new Error('Approve ElevenLabs narration before generating a voiceover.');
  if (!key) throw new Error('Add your ElevenLabs key in Settings, or choose local English narration.');
  if (typeof text !== 'string' || !text.trim() || text.length > 30000) throw new Error('Narration must contain between 1 and 30,000 characters.');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(voiceId) || !/^[A-Za-z0-9_-]{1,100}$/.test(modelId)) throw new Error('Invalid ElevenLabs voice or model.');
  if (!path.isAbsolute(outWav) || typeof run !== 'function') throw new Error('Narration output and converter are required.');
  signal?.throwIfAborted();
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ text, voiceId, modelId })).digest('hex');
  const cacheDir = path.join(path.dirname(outWav), '.vidmyo', 'narration');
  fs.mkdirSync(cacheDir, { recursive: true });
  // Multilingual v2 allows 10,000 chars/request; keep sentence boundaries below that.
  // https://elevenlabs.io/docs/overview/models
  const chunks = splitNarration(text, modelId === DEFAULT_MODEL ? 9000 : 4000);
  const compressedFiles = [];
  for (let index = 0; index < chunks.length; index += 1) {
    signal?.throwIfAborted();
    const compressed = path.join(cacheDir, `${fingerprint}-${index}.mp3`);
    compressedFiles.push(compressed);
    // Keep each successful response when another chunk or local conversion fails.
    if (fs.existsSync(compressed) && fs.statSync(compressed).size >= 10) continue;
    const response = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: chunks[index], model_id: modelId }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000),
    });
    if (!response.ok) throw new Error(`ElevenLabs could not create the narration (HTTP ${response.status}). Check your key, voice access and available credits.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 10 || bytes.length > 64 * 1024 * 1024) throw new Error('ElevenLabs returned an empty or oversized audio file.');
    const temp = `${compressed}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(temp, bytes, { mode: 0o600 });
    fs.renameSync(temp, compressed);
  }
  signal?.throwIfAborted();
  const tempWav = `${outWav}.${crypto.randomBytes(4).toString('hex')}.wav`;
  try {
    const inputs = compressedFiles.flatMap(file => ['-i', file]);
    const join = compressedFiles.length > 1 ? ['-filter_complex', `${compressedFiles.map((_, i) => `[${i}:a]`).join('')}concat=n=${compressedFiles.length}:v=0:a=1[a]`, '-map', '[a]'] : [];
    await run('ffmpeg', ['-v', 'error', '-y', ...inputs, ...join, '-ar', '24000', '-ac', '1', tempWav]);
    signal?.throwIfAborted();
    if (!fs.existsSync(tempWav) || fs.statSync(tempWav).size < 44) throw new Error('Voiceover conversion produced no usable WAV.');
    fs.renameSync(tempWav, outWav);
  } finally {
    try { fs.unlinkSync(tempWav); } catch { /* Converter failed before creating output. */ }
  }
  return { source: 'elevenlabs', artifact: outWav, modelId, voiceId, fingerprint };
}

module.exports = { createElevenLabsNarration, splitNarration, DEFAULT_VOICE, DEFAULT_MODEL };
