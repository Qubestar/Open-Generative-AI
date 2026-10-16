import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CREATIVE_HISTORY_STORAGE_KEY,
  loadGenerationHistory,
  saveGenerationSettings,
} from '../../studio/src/creativeHistory.mjs';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    value: (key) => values.get(key),
  };
}

test('creative history persists only allowlisted image settings', () => {
  const storage = memoryStorage();
  saveGenerationSettings(storage, 'image', 'job_1', {
    prompt: 'fox', model: 'fal-ai/flux/dev', endpoint: 'fal-ai/flux/dev', customModel: '',
    aspect: 'square', provider: 'fal.ai', modelLabel: 'Flux', apiKey: 'must-not-persist',
  });
  const raw = storage.value(CREATIVE_HISTORY_STORAGE_KEY);
  assert.ok(!raw.includes('must-not-persist'));
  assert.deepEqual(loadGenerationHistory(storage, 'image').job_1, {
    prompt: 'fox', model: 'fal-ai/flux/dev', endpoint: 'fal-ai/flux/dev', customModel: '',
    aspect: 'square', provider: 'fal.ai', modelLabel: 'Flux',
  });
});

test('video history omits source bytes and path while retaining image requirement', () => {
  const storage = memoryStorage();
  saveGenerationSettings(storage, 'video', 'job_2', {
    animate: true, sourceImage: { path: '/private/source.png', dataUrl: 'data:image/png;base64,SECRET' },
    prompt: 'move', model: 'custom', customModel: 'fal/custom', aspect: '9:16', duration: '8',
  });
  const raw = storage.value(CREATIVE_HISTORY_STORAGE_KEY);
  assert.ok(!raw.includes('SECRET'));
  assert.ok(!raw.includes('/private/source.png'));
  assert.deepEqual(loadGenerationHistory(storage, 'video').job_2, {
    animate: true, prompt: 'move', model: 'custom', customModel: 'fal/custom',
    aspect: '9:16', duration: '8', requiresSourceImage: true,
  });
});

test('history is capped, deduplicated, kind-isolated, and tolerates corrupt storage', () => {
  const storage = memoryStorage();
  saveGenerationSettings(storage, 'image', 'image_job', { prompt: 'image' }, 2);
  saveGenerationSettings(storage, 'video', 'video_1', { prompt: 'one' }, 2);
  saveGenerationSettings(storage, 'video', 'video_2', { prompt: 'two' }, 2);
  saveGenerationSettings(storage, 'video', 'video_1', { prompt: 'updated' }, 2);
  saveGenerationSettings(storage, 'video', 'video_3', { prompt: 'three' }, 2);
  assert.deepEqual(Object.keys(loadGenerationHistory(storage, 'video')), ['video_3', 'video_1']);
  assert.equal(loadGenerationHistory(storage, 'video').video_1.prompt, 'updated');
  assert.equal(loadGenerationHistory(storage, 'image').image_job.prompt, 'image');

  const corrupt = memoryStorage({ [CREATIVE_HISTORY_STORAGE_KEY]: '{nope' });
  assert.deepEqual(loadGenerationHistory(corrupt, 'image'), {});
});

test('malformed records and null settings are normalized without poisoning later saves', () => {
  const storage = memoryStorage({
    [CREATIVE_HISTORY_STORAGE_KEY]: JSON.stringify({
      version: 1,
      image: [null, { jobId: 'job_null', settings: null }, { nope: true }],
      video: [],
    }),
  });
  assert.deepEqual(loadGenerationHistory(storage, 'image').job_null, {
    prompt: '', model: '', endpoint: '', customModel: '', aspect: 'square', provider: '', modelLabel: '',
  });
  assert.doesNotThrow(() => saveGenerationSettings(storage, 'image', 'job_new', { prompt: 'safe' }));
  assert.deepEqual(Object.keys(loadGenerationHistory(storage, 'image')), ['job_new', 'job_null']);
});
