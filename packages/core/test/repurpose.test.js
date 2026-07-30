import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPURPOSE_MANIFEST_NAME,
  REPURPOSE_MANIFEST_VERSION,
  REPURPOSE_PROTOCOL_VERSION,
  REPURPOSE_STAGES,
  RepurposeProject,
  validateRepurposeManifest,
  validateWorkerEventStream,
  validateWorkerRequest,
} from '../src/repurpose.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '../../repurpose-engine/tests/fixtures');
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-repurpose-'));
const loadFixture = name => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));
const loadJsonl = name => fs.readFileSync(path.join(fixtures, name), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map(line => JSON.parse(line));

test('shared version-1 request and manifest fixtures are accepted', () => {
  assert.equal(validateWorkerRequest(loadFixture('valid-worker-request.json')).protocol_version, 1);
  assert.equal(validateRepurposeManifest(loadFixture('valid-project-manifest.json')).version, 1);
});

test('shared invalid fixtures are rejected with field-specific errors', () => {
  assert.throws(
    () => validateWorkerRequest(loadFixture('invalid-worker-request-missing-project-dir.json')),
    /request\.project_dir: is required/,
  );
  assert.throws(
    () => validateWorkerRequest(loadFixture('invalid-worker-request-stage.json')),
    /request\.stage: unknown stage/,
  );
  assert.throws(
    () => validateRepurposeManifest(loadFixture('invalid-project-manifest-version.json')),
    /manifest\.version: expected 1/,
  );
  assert.throws(
    () => validateRepurposeManifest(loadFixture('invalid-project-manifest-candidate-id.json')),
    /manifest\.candidates\.0\.id: must match clip_NNN/,
  );
});

test('shared event stream fixtures enforce monotonic sequence and terminal order', () => {
  assert.equal(validateWorkerEventStream(loadJsonl('valid-worker-events.jsonl')).length, 3);
  assert.throws(
    () => validateWorkerEventStream(loadJsonl('invalid-worker-events-sequence.jsonl')),
    /events\.1\.sequence: expected 2, got 3/,
  );
});

test('create writes a versioned manifest with local and future URL source contracts', () => {
  const localDir = tempDir();
  const local = RepurposeProject.create(localDir, {
    source: { type: 'local_file', uri: '/videos/podcast.mp4' },
  });
  assert.match(local.manifest.id, /^repurpose_/);
  assert.equal(local.manifest.version, REPURPOSE_MANIFEST_VERSION);
  assert.equal(local.manifest.protocol_version, REPURPOSE_PROTOCOL_VERSION);
  assert.equal(local.manifest.render_mode, 'manual_approval');
  assert.deepEqual(Object.keys(local.manifest.stages), REPURPOSE_STAGES);
  assert.ok(fs.existsSync(path.join(localDir, REPURPOSE_MANIFEST_NAME)));

  const url = RepurposeProject.create(tempDir(), {
    source: { type: 'url', uri: 'https://example.com/video' },
  });
  assert.equal(url.manifest.source.type, 'url');
});

test('create refuses overwrite; load rejects unsupported versions and preserves caller directory', () => {
  const dir = tempDir();
  RepurposeProject.create(dir, { source: { type: 'local_file', uri: '/videos/source.mp4' } });
  assert.throws(
    () => RepurposeProject.create(dir, { source: { type: 'local_file', uri: '/videos/other.mp4' } }),
    /Refusing to overwrite/,
  );
  const loaded = RepurposeProject.load(dir);
  assert.equal(loaded.dir, dir);
  assert.equal(Object.hasOwn(loaded.manifest, 'project_dir'), false);

  loaded.manifest.version = 2;
  fs.writeFileSync(path.join(dir, REPURPOSE_MANIFEST_NAME), JSON.stringify(loaded.manifest));
  assert.throws(() => RepurposeProject.load(dir), /manifest\.version: expected 1/);
});

test('stages enforce ordering, legal transitions, failure retry, and durable artifacts', () => {
  const dir = tempDir();
  const project = RepurposeProject.create(dir, {
    source: { type: 'local_file', uri: '/videos/source.mp4' },
  });
  assert.throws(() => project.startStage('transcribe'), /prerequisite ingest is not completed/);
  assert.equal(project.startStage('ingest').state, 'running');
  assert.throws(() => project.startStage('ingest'), /running → running/);
  assert.equal(project.failStage('ingest', 'probe unavailable').state, 'failed');
  assert.equal(project.startStage('ingest').error, null);
  assert.equal(project.completeStage('ingest', { artifact: 'ingest.json' }).artifact, 'ingest.json');
  assert.equal(RepurposeProject.load(dir).manifest.stages.ingest.state, 'completed');
  assert.equal(project.startStage('transcribe').state, 'running');
});

test('stable candidate ids and manual approval gate prevent automatic selection', () => {
  const project = RepurposeProject.create(tempDir(), {
    source: { type: 'local_file', uri: '/videos/source.mp4' },
  });
  const first = project.addCandidate({ proposedStartSec: 3, proposedEndSec: 30 });
  const second = project.addCandidate({ proposedStartSec: 45, proposedEndSec: 75 });
  assert.equal(first.id, 'clip_001');
  assert.equal(second.id, 'clip_002');
  assert.equal(project.canRender(), false);
  assert.throws(() => project.selectCandidate('clip_001'), /not approved/);
  project.setCandidateDecision('clip_001', 'approved');
  project.selectCandidate('clip_001');
  assert.equal(project.canRender(), true);
  project.setCandidateDecision('clip_001', 'rejected');
  assert.equal(project.getCandidate('clip_001').selected, false);
  assert.equal(project.canRender(), false);
  assert.throws(() => project.getCandidate('candidate-one'), /Malformed candidate id/);
});

test('render defaults keep future caption style and translation fields without implementing them', () => {
  const project = RepurposeProject.create(tempDir(), {
    source: { type: 'local_file', uri: '/videos/source.mp4' },
    renderDefaults: {
      aspect_ratio: '1:1',
      crop_mode: 'blurred_background',
      captions: { enabled: true, style: 'bold', translation_target_language: 'pl' },
    },
  });
  assert.deepEqual(project.manifest.render_defaults, {
    aspect_ratio: '1:1',
    crop_mode: 'blurred_background',
    captions: { enabled: true, style: 'bold', translation_target_language: 'pl' },
  });
});

test('top-level core export exposes RepurposeProject', async () => {
  const core = await import('../index.js');
  assert.equal(core.RepurposeProject, RepurposeProject);
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(here, '../package.json'), 'utf8'));
  assert.equal(packageJson.exports['./repurpose'], './src/repurpose.js');
});
