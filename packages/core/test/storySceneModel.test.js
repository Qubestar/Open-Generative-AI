import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSelectedScene, sceneDuration, sceneState } from '../../studio/src/storySceneModel.mjs';

test('Story selection follows stable scene IDs across refresh/reorder and handles removed scenes', () => {
  const first = { id:'s001' }, fourth = { id:'s004' };
  assert.equal(resolveSelectedScene([fourth,first], 's001'), first);
  assert.equal(resolveSelectedScene([fourth], 's001'), fourth);
  assert.equal(resolveSelectedScene([], 's004'), null);
});
test('Story duration uses verified narration spans, not invented timing', () => {
  assert.equal(sceneDuration({ narrationSpan:[10,14.5] }), 4.5);
  for (const narrationSpan of [null, [4], [8,2], ['1',3], [NaN,5]]) assert.equal(sceneDuration({ narrationSpan }), null);
});
test('Story approval status never approves an absent artifact', () => {
  assert.equal(sceneState({image:{approved:true}}), 'Needs image');
  assert.equal(sceneState({image:{artifact:'/mock.png',approved:false}}), 'Review image');
  assert.equal(sceneState({image:{artifact:'/mock.png',approved:true}}), 'Approved');
});
