import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CAPTION_COLORS, CAPTION_FONTS, CAPTION_LOOKS, captionChoice, captionVariant, normalizeCaptionColor, settingsFromRenderArtifact } from '../../studio/src/captionStudioModel.mjs';

test('all six caption looks round-trip background and position settings', () => {
  assert.equal(CAPTION_LOOKS.length, 6);
  for (const look of CAPTION_LOOKS) for (const position of ['upper', 'middle', 'lower']) for (const background of [true, false]) {
    assert.deepEqual(captionChoice(captionVariant({ captionStyle: look.id, captionPosition: position, captionBackground: background })),
      { style: look.id, position, background });
  }
  assert.deepEqual(captionChoice('bold_lower'), { style: 'bold', position: 'lower', background: true });
  assert.deepEqual(captionChoice('clean'), { style: 'clean', position: 'middle', background: true });
});

test('last rendered caption and upscale settings survive reopening without losing project context', () => {
  const settings = settingsFromRenderArtifact({ settings: { caption_style: 'studio_karaoke_upper_clear', caption_color: '#7c5cff', caption_font: 'montserrat', captions_enabled: true, upscale_mode: 'lanczos_4k' }, presets: [{ id: 'youtube_shorts' }] }, { projectDir: '/test', captionStyle: 'clean' });
  assert.deepEqual(settings, { projectDir: '/test', captionStyle: 'karaoke', captionPosition: 'upper', captionBackground: false, captionColor: '#7C5CFF', captionFont: 'montserrat', captionsEnabled: true, upscaleMode: 'lanczos_4k', platforms: ['youtube_shorts'], separatePlatformFiles: false });
});

test('caption brand controls use bounded fonts and normalized colors', () => {
  assert.deepEqual(CAPTION_FONTS.map(item => item.id), ['preset', 'montserrat', 'barlow_condensed', 'anton']);
  assert.equal(CAPTION_COLORS.length, 4);
  assert.equal(normalizeCaptionColor('#abcdef'), '#ABCDEF');
  assert.equal(normalizeCaptionColor('not-a-color'), 'preset');
});

test('every offered caption look has real rendered previews for both backgrounds', () => {
  const previews = JSON.parse(fs.readFileSync(new URL('../../studio/src/captionPreviews.json', import.meta.url)));
  for (const look of CAPTION_LOOKS) for (const background of ['box', 'clear']) {
    const assets = previews[look.id].backgrounds[background];
    assert.match(assets.thumbnail, /^data:image\/png;base64,/);
    assert.equal(assets.frames.length, ['karaoke', 'pop'].includes(look.id) ? 4 : 1);
    assert.ok(assets.frames.every(frame => frame.startsWith('data:image/png;base64,')));
  }
});
