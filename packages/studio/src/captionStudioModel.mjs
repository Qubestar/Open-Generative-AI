export const CAPTION_LOOKS = [
  { id: 'clean', name: 'Clean', description: 'Quiet, readable phrases', tag: 'EVERYDAY' },
  { id: 'bold', name: 'Impact', description: 'Bold yellow, all caps', tag: 'HIGH ENERGY' },
  { id: 'outline', name: 'Outline', description: 'White type, dark edges', tag: 'CLASSIC' },
  { id: 'karaoke', name: 'Word highlight', description: 'Yellow follows each word', tag: 'WORD TIMED' },
  { id: 'pop', name: 'One word', description: 'One spoken word at a time', tag: 'WORD TIMED' },
  { id: 'editorial', name: 'Editorial', description: 'Smaller, warm ivory type', tag: 'UNDERSTATED' },
];

export const CAPTION_FONTS = [
  { id: 'preset', name: 'Style default', family: 'inherit' },
  { id: 'montserrat', name: 'Montserrat ExtraBold', family: 'Vidmyo Montserrat' },
  { id: 'barlow_condensed', name: 'Barlow Condensed', family: 'Vidmyo Barlow Condensed' },
  { id: 'anton', name: 'Anton', family: 'Vidmyo Anton' },
];

export const CAPTION_COLORS = [
  { id: 'preset', name: 'Style default', color: null },
  { id: '#7C5CFF', name: 'Electric purple', color: '#7C5CFF' },
  { id: '#FFD400', name: 'Classic yellow', color: '#FFD400' },
  { id: '#FFFFFF', name: 'Clean white', color: '#FFFFFF' },
];

export function normalizeCaptionColor(value) {
  if (value === 'preset' || value == null) return 'preset';
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : 'preset';
}

export function captionChoice(value) {
  const studio = /^studio_(clean|bold|outline|karaoke|pop|editorial)_(upper|middle|lower)_(box|clear)$/.exec(value || '');
  if (studio) return { style: studio[1], position: studio[2], background: studio[3] === 'box' };
  const legacy = /^(clean|bold)(?:_(upper|middle|lower))?$/.exec(value || '');
  return { style: legacy?.[1] || 'clean', position: legacy?.[2] || 'middle', background: true };
}

export const captionVariant = ({ captionStyle, captionPosition, captionBackground = true }) =>
  `studio_${captionStyle}_${captionPosition}_${captionBackground ? 'box' : 'clear'}`;

export function settingsFromRenderArtifact(artifact, fallback) {
  if (!artifact?.settings) return fallback;
  const captions = captionChoice(artifact.settings.caption_style);
  const platforms = artifact.presets?.map(preset => preset.id) || fallback.platforms;
  return { ...fallback, captionStyle: captions.style, captionPosition: captions.position,
    captionBackground: captions.background, captionsEnabled: artifact.settings.captions_enabled,
    captionColor: normalizeCaptionColor(artifact.settings.caption_color),
    captionFont: CAPTION_FONTS.some(font => font.id === artifact.settings.caption_font) ? artifact.settings.caption_font : 'preset',
    upscaleMode: artifact.settings.upscale_mode || 'off', platforms,
    separatePlatformFiles: platforms.length > 1 };
}
