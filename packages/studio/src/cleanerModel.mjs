export const SCRIPT_CHOICES = [
  { id: 'exact', label: 'Exact script', detail: 'Match takes to the words you intended.' },
  { id: 'rough', label: 'Rough outline', detail: 'Keep the strongest fluent delivery.' },
  { id: 'freestyle', label: 'Freestyle', detail: 'Find restarts and repeated thoughts.' },
];

export const SAVE_CHOICES = [
  { id: 'downloads', label: 'Downloads' },
  { id: 'source', label: 'Beside source' },
  { id: 'custom', label: 'Choose folder' },
];

export function cleanerBriefSummary({ scriptMode, includeMp4, saveMode, providerMode, providerName }) {
  const script = SCRIPT_CHOICES.find(choice => choice.id === scriptMode)?.label || 'Choose script mode';
  const output = includeMp4 ? 'Clean MP4 + review plan' : 'Review plan only';
  const place = SAVE_CHOICES.find(choice => choice.id === saveMode)?.label || 'Choose location';
  const provider = providerName || (providerMode === 'api' ? 'Choose API' : 'Choose agent');
  return `${script} · ${output} · ${place} · ${provider}`;
}

export function cleanerSetupError(setup) {
  if (!setup.sourcePath) return 'Choose a source video.';
  if (!SCRIPT_CHOICES.some(choice => choice.id === setup.scriptMode)) return 'Choose how the video was recorded.';
  if (setup.scriptMode !== 'freestyle' && !String(setup.scriptText || '').trim()) {
    return 'Paste the script or rough outline.';
  }
  if (!SAVE_CHOICES.some(choice => choice.id === setup.saveMode)) return 'Choose where to save the project.';
  if (setup.saveMode === 'custom' && !setup.customOutputDir) return 'Choose a custom output folder.';
  if (!['agent', 'api'].includes(setup.providerMode) || !setup.providerId) return 'Choose who should make the edit decisions.';
  if (setup.providerMode === 'api' && !String(setup.model || '').trim()) return 'Enter an API model id.';
  return null;
}
// Physical edited previews use a shorter clock. Map it back to source time
// before highlighting transcript rows; a removed interval is never active.
export const sourceTimeForPlayback = (mode, seconds, ranges = []) => {
  const position = Math.max(0, Number(seconds) || 0);
  if (mode !== 'edited' || !ranges.length) return position;
  let elapsed = position;
  for (const [start, end] of ranges) {
    const length = Math.max(0, end - start);
    if (elapsed < length) return start + elapsed;
    elapsed -= length;
  }
  return ranges[ranges.length - 1][1];
};
