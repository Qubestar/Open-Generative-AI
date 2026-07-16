import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS } from '../src/providers.js';
import { IMAGE_SOURCES } from '../src/story.js';
import {
  GENERATION_SOURCES, getGenerationSource, resolveGenerationModel,
  buildGenerationParams, makeGenerationAdapter, AGNES_PLANS,
} from '../src/generation.js';

test('every generation source names a provider that exists in the catalog', () => {
  const known = new Set(PROVIDERS.map((p) => p.id));
  for (const s of GENERATION_SOURCES) {
    assert.ok(known.has(s.provider), `${s.id} names unknown provider "${s.provider}"`);
    assert.ok(s.models.image.length > 0, `${s.id} has no image models`);
    assert.ok(s.models.video.length > 0, `${s.id} has no video models`);
  }
});

test('story IMAGE_SOURCES is derived from the generation catalog (no drift possible)', () => {
  for (const s of GENERATION_SOURCES) {
    const view = IMAGE_SOURCES.find((v) => v.id === s.id);
    assert.ok(view, `story view missing ${s.id}`);
    assert.deepEqual(view.models, s.models.image, `${s.id}: story models drifted from the catalog`);
  }
});

test('model resolution: keeps a real model, drops a foreign one, and honors the i2v split', () => {
  // A fal id is meaningless to Agnes and vice versa.
  assert.equal(resolveGenerationModel('agnes', 'image', 'fal-ai/flux/dev'), 'agnes-image-2.0-flash');
  assert.equal(resolveGenerationModel('fal', 'image', 'fal-ai/flux/dev'), 'fal-ai/flux/dev');
  // Text-to-video vs animate-an-image are different fal marketplace slugs.
  assert.equal(resolveGenerationModel('fal', 'video', null), 'fal-ai/veo3');
  assert.equal(resolveGenerationModel('fal', 'video', null, { hasImage: true }), 'fal-ai/kling-video/v3/pro/image-to-video');
  // A t2v id passed WITH an image must not survive into the i2v call.
  assert.equal(
    resolveGenerationModel('fal', 'video', 'fal-ai/veo3', { hasImage: true }),
    'fal-ai/kling-video/v3/pro/image-to-video',
  );
  // Agnes reuses one video model either way.
  assert.equal(resolveGenerationModel('agnes', 'video', null, { hasImage: true }), 'agnes-video-v2.0');
  assert.equal(resolveGenerationModel('nope', 'video', null), null);
});

test('image params speak each provider dialect', () => {
  // Agnes: literal pixels + response_format INSIDE extra_body (top-level 400s).
  assert.deepEqual(buildGenerationParams('agnes', 'image', { prompt: 'a fox', aspect: '9:16' }), {
    prompt: 'a fox', size: '576x1024', extra_body: { response_format: 'url' },
  });
  // fal: named preset.
  assert.deepEqual(buildGenerationParams('fal', 'image', { prompt: 'a fox' }), {
    prompt: 'a fox', image_size: 'landscape_16_9',
  });
  assert.throws(() => buildGenerationParams('fal', 'image', { prompt: '  ' }), /prompt is empty/);
});

test('video params: duration and input image land in each provider\'s field', () => {
  const agnes = buildGenerationParams('agnes', 'video', {
    prompt: 'a fox', aspect: '9:16', durationSeconds: 5, image: 'data:image/png;base64,AAA',
  });
  assert.deepEqual(agnes, {
    prompt: 'a fox', width: 720, height: 1280, frame_rate: 24, num_frames: 120,
    image: 'data:image/png;base64,AAA',
  });

  const fal = buildGenerationParams('fal', 'video', { prompt: 'a fox', durationSeconds: 8, image: 'data:x' });
  assert.deepEqual(fal, { prompt: 'a fox', aspect_ratio: '16:9', duration: '8', image_url: 'data:x' });

  // Omitted duration = omit the field entirely (fal-ai/veo3 was live-verified without it).
  const auto = buildGenerationParams('fal', 'video', { prompt: 'a fox' });
  assert.ok(!('duration' in auto));
  const agnesAuto = buildGenerationParams('agnes', 'video', { prompt: 'a fox' });
  assert.equal(agnesAuto.num_frames, 121);
  assert.ok(!('image' in agnesAuto));
});

test('the plan table drives Agnes video polling; free stays the 60s floor', () => {
  assert.equal(AGNES_PLANS.free.videoPollMs, 60000);
  assert.ok(AGNES_PLANS.token.videoPollMs < 60000);

  const free = makeGenerationAdapter('agnes', { key: 'k', model: 'agnes-video-v2.0', kind: 'video' });
  assert.equal(free.pollMs, 60000);
  const token = makeGenerationAdapter('agnes', { key: 'k', model: 'agnes-video-v2.0', kind: 'video', agnesPlan: 'token' });
  assert.equal(token.pollMs, AGNES_PLANS.token.videoPollMs);
  // Images are synchronous — no interval regardless of plan.
  const img = makeGenerationAdapter('agnes', { key: 'k', model: 'agnes-image-2.0-flash', kind: 'image' });
  assert.equal(img.pollMs, undefined);
  // fal keeps the runner's defaults.
  const fal = makeGenerationAdapter('fal', { key: 'k', model: 'fal-ai/veo3', kind: 'video' });
  assert.equal(fal.pollMs, undefined);
  assert.throws(() => makeGenerationAdapter('nope', { key: 'k', model: 'm', kind: 'image' }), /unknown source/);
});
