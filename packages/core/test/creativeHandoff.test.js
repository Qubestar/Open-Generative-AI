import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageReadResultToHandoff, videoStateFromImageHandoff } from '../../studio/src/creativeHandoff.mjs';

test('generated artifact bytes become an in-memory Video source without invoking generation', () => {
  let generateCalls = 0;
  const api = { generate: () => { generateCalls += 1; } };
  const handoff = imageReadResultToHandoff(
    { artifact: '/artifacts/image.png', prompt: 'a fox' },
    { ok: true, mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) },
  );
  const state = videoStateFromImageHandoff(handoff, 'fal/image-to-video');
  assert.deepEqual(state, {
    animate: true,
    sourceImage: { path: '/artifacts/image.png', dataUrl: 'data:image/png;base64,AQID' },
    prompt: 'a fox',
    model: 'fal/image-to-video',
    customModel: '',
    sourceImageJobId: '', collection: '',
  });
  assert.equal(generateCalls, 0);
  assert.equal(Object.hasOwn(handoff, 'api'), false);
  void api;
});

test('generated image job identity and collection survive handoff without inventing upload lineage', () => {
  const handoff=imageReadResultToHandoff({artifact:'/a.png',jobId:'image_1',collection:'Launch'}, {ok:true,mime:'image/png',bytes:[1]});
  const state=videoStateFromImageHandoff(handoff,'model');
  assert.equal(state.sourceImageJobId,'image_1');
  assert.equal(state.collection,'Launch');
});

test('handoff rejects failed reads, non-images, and missing sources', () => {
  assert.throws(() => imageReadResultToHandoff({ artifact: '/a.png' }, { ok: false, error: 'denied' }), /denied/);
  assert.throws(() => imageReadResultToHandoff({ artifact: '/a.mp4' }, { ok: true, mime: 'video/mp4', bytes: [1] }), /prepare/);
  assert.equal(videoStateFromImageHandoff(null, 'model'), null);
  assert.equal(videoStateFromImageHandoff({ sourceImage: { path: '/a', dataUrl: 'blob:x' } }, 'model'), null);
});
