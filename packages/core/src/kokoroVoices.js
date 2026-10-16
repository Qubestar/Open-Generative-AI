// English voices supported by the bundled Kokoro narration pipeline.
export const DEFAULT_KOKORO_VOICE = 'am_onyx';
export const KOKORO_VOICES = [
  ['am_onyx', 'Onyx · American · Male'],
  ['am_michael', 'Michael · American · Male'],
  ['am_adam', 'Adam · American · Male'],
  ['am_liam', 'Liam · American · Male'],
  ['af_heart', 'Heart · American · Female'],
  ['af_bella', 'Bella · American · Female'],
  ['af_nicole', 'Nicole · American · Female'],
  ['af_sarah', 'Sarah · American · Female'],
  ['bm_george', 'George · British · Male'],
  ['bm_fable', 'Fable · British · Male'],
  ['bm_lewis', 'Lewis · British · Male'],
].map(([id, name]) => ({ id, name, lang: id[0] }));

export function kokoroVoice(value = DEFAULT_KOKORO_VOICE) {
  const voice = KOKORO_VOICES.find(item => item.id === value);
  if (!voice) throw new Error('Choose a supported Kokoro voice.');
  return voice;
}
