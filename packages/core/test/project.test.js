import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Project, sceneIdFor, MANIFEST_NAME } from '../src/project.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-proj-'));

test('sceneIdFor pads to three digits and rejects nonsense', () => {
  assert.equal(sceneIdFor(1), 's001');
  assert.equal(sceneIdFor(17), 's017');
  assert.equal(sceneIdFor(120), 's120');
  assert.throws(() => sceneIdFor(0));
  assert.throws(() => sceneIdFor(1.5));
});

test('create → addScene → load roundtrip', () => {
  const dir = tmpDir();
  const p = Project.create(dir, { brief: { topic: 'why cats purr' }, style: 'doodle-v1' });
  p.addScene({ beat: 'hook', prompt: 'a curious cat, doodle style' });
  p.addScene({ beat: 'setup', prompt: 'a vet explaining, doodle style' });

  const loaded = Project.load(dir);
  assert.equal(loaded.manifest.scenes.length, 2);
  assert.equal(loaded.manifest.scenes[0].id, 's001');
  assert.equal(loaded.manifest.scenes[1].id, 's002');
  assert.equal(loaded.manifest.style, 'doodle-v1');
});

test('create refuses to overwrite an existing manifest', () => {
  const dir = tmpDir();
  Project.create(dir, {});
  assert.throws(() => Project.create(dir, {}), /Refusing to overwrite/);
  assert.ok(fs.existsSync(path.join(dir, MANIFEST_NAME)));
});

test('scenes resolve ONLY by explicit sNNN id', () => {
  const dir = tmpDir();
  const p = Project.create(dir, {});
  p.addScene({ beat: 'a' });
  assert.equal(p.getScene('s001').beat, 'a');
  assert.throws(() => p.getScene('17'), /Malformed scene id/);
  assert.throws(() => p.getScene(1), /Malformed scene id/);
  assert.throws(() => p.getScene('s099'), /No scene s099/);
});

test('scene ids are immutable through updateScene', () => {
  const dir = tmpDir();
  const p = Project.create(dir, {});
  p.addScene({ beat: 'a' });
  p.updateScene('s001', { id: 's999', beat: 'b' });
  assert.equal(p.getScene('s001').beat, 'b');
  assert.throws(() => p.getScene('s999'));
});

test('artifacts must exist on disk to be accepted; approval requires an artifact', () => {
  const dir = tmpDir();
  const p = Project.create(dir, {});
  p.addScene({ beat: 'hook' });

  assert.throws(() => p.approveScene('s001'), /no artifact/);
  assert.throws(
    () => p.acceptSceneArtifact('s001', path.join(dir, 'nope.png')),
    /does not exist on disk/,
  );

  const real = path.join(dir, 's001.png');
  fs.writeFileSync(real, 'png');
  p.acceptSceneArtifact('s001', real);
  assert.equal(p.getScene('s001').image.approved, false);
  p.approveScene('s001');
  assert.equal(Project.load(dir).getScene('s001').image.approved, true);
});

test('pendingScenes is the resume queue', () => {
  const dir = tmpDir();
  const p = Project.create(dir, {});
  p.addScene({ beat: 'a' });
  p.addScene({ beat: 'b' });
  const real = path.join(dir, 's001.png');
  fs.writeFileSync(real, 'png');
  p.acceptSceneArtifact('s001', real, { approved: true });
  const pending = p.pendingScenes().map(s => s.id);
  assert.deepEqual(pending, ['s002']);
});
