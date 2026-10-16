import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFlowQueue, flowProjectId } from '../src/flowQueue.js';

test('creates the schema v1 queue accepted by Curio Flow Queue', () => {
  const queue = createFlowQueue({
    projectId: 'proj_123_ABC',
    aspect: '9:16',
    scenes: [
      { id: 's001', prompt: 'A hand-drawn doodle scientist holding a telescope.' },
      { id: 's002', prompt: 'A hand-drawn doodle city beneath stars.' },
    ],
  });
  assert.deepEqual(queue, {
    schemaVersion: 1,
    projectId: 'vidmyo-proj-123-abc',
    outputDirectory: 'downloads',
    downloadSubdirectory: 'images',
    scenes: [
      { sceneId: 's001', prompt: 'A hand-drawn doodle scientist holding a telescope.', kind: 'image', expectedAspectRatio: '9:16' },
      { sceneId: 's002', prompt: 'A hand-drawn doodle city beneath stars.', kind: 'image', expectedAspectRatio: '9:16' },
    ],
  });
});

test('Flow queue rejects unsafe ids, blank prompts, duplicates, and unknown aspects', () => {
  assert.equal(flowProjectId('___'), 'vidmyo-project');
  assert.throws(() => createFlowQueue({ projectId: 'x', aspect: '1:1', scenes: [{ id: 's001', prompt: 'x' }] }), /aspect ratio/);
  assert.throws(() => createFlowQueue({ projectId: 'x', aspect: '16:9', scenes: [{ id: '../bad', prompt: 'x' }] }), /sNNN/);
  assert.throws(() => createFlowQueue({ projectId: 'x', aspect: '16:9', scenes: [{ id: 's001', prompt: ' ' }] }), /no prompt/);
  assert.throws(() => createFlowQueue({ projectId: 'x', aspect: '16:9', scenes: [{ id: 's001', prompt: 'x' }, { id: 's001', prompt: 'y' }] }), /repeats/);
});
