export function characterAnimationMode(value = 'static') {
  if (!['static', 'animated'].includes(value)) throw new Error('Choose animated or non-animated characters.');
  return value;
}

export function validateCharacters(value, { required = false } = {}) {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.length > 3 || (required && !value.length)) {
    throw new Error('An animated Stickman scene needs 1–3 characters.');
  }
  const ids = new Set();
  let speakers = 0;
  return value.map(character => {
    if (!character || typeof character !== 'object' || !/^[a-z][a-z0-9_-]{0,39}$/.test(character.id) || ids.has(character.id)) {
      throw new Error('Characters need unique stable IDs.');
    }
    ids.add(character.id);
    const result = { id: character.id };
    for (const [key, options] of Object.entries({
      action: ['idle', 'talk', 'wave', 'point', 'walk'],
      expression: ['neutral', 'happy', 'surprised', 'concerned'],
      facing: ['left', 'right'],
      shirt: ['blue', 'red', 'yellow', 'green', 'gray'],
      skin: ['paper', 'light', 'medium', 'dark'],
    })) {
      if (!options.includes(character[key])) throw new Error(`Invalid character ${key}.`);
      result[key] = character[key];
    }
    for (const [key, min, max] of [['x', .15, .85], ['endX', .15, .85], ['y', .65, .9], ['scale', .25, .55]]) {
      const number = character[key];
      if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max) throw new Error(`Invalid character ${key}.`);
      result[key] = number;
    }
    if (result.action === 'talk' && ++speakers > 1) throw new Error('Use at most one talking character per scene.');
    return result;
  });
}

// Input is mono f32le at 8 kHz, produced once by FFmpeg from the final voiceover.
// A coarse amplitude envelope is enough for simple mouth shapes, not phoneme lip sync.
export function speechEnvelopeFromPcm(bytes, totalFrames, fps = 30, sampleRate = 8000) {
  if (!Number.isInteger(totalFrames) || totalFrames < 1 || totalFrames > 108000) throw new Error('Invalid speech envelope duration.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = Math.floor(bytes.byteLength / 4);
  const rms = Array.from({length:totalFrames}, (_, frame) => {
    const start = Math.floor(frame * sampleRate / fps);
    const end = Math.min(samples, Math.floor((frame + 1) * sampleRate / fps));
    let sum = 0;
    for (let i = start; i < end; i++) {
      const value = view.getFloat32(i * 4, true);
      if (Number.isFinite(value)) sum += value * value;
    }
    return end > start ? Math.sqrt(sum / (end - start)) : 0;
  });
  const sorted = rms.filter(value => value > .006).sort((a,b) => a-b);
  const peak = Math.max(.03, sorted[Math.floor(sorted.length * .9)] || .03);
  return rms.map(value => value < .006 ? 0 : Math.round(Math.min(1, value / peak) * 100) / 100);
}
