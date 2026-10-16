import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as actualCore from '../index.js';

const require = createRequire(import.meta.url);
const { createAutoEditorBridge } = require('../../../electron/lib/autoEditorBridge.js');
const preloadPath = fileURLToPath(new URL('../../../electron/preload.js', import.meta.url));
const preloadSource = fs.readFileSync(preloadPath, 'utf8');
const tempDir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// Phase 3 item 1: every bridge test runs against private mkdtemp directories
// (userData/jobs/exports/broll-library/governor), so no test can read or write
// the real ~/.vidmyo even when the suite is run without the isolated wrapper.
function harness() {
  const handlers = new Map();
  const homeRoot = tempDir('vidmyo-autoeditor-home-');
  const userDataDir = path.join(homeRoot, 'user-data');
  const governorDir = tempDir('vidmyo-autoeditor-governor-');
  const bridge = createAutoEditorBridge({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    core: async () => actualCore,
    userDataDir,
    jobsDir: path.join(userDataDir, 'jobs'),
    exportsDir: path.join(userDataDir, 'exports'),
    brollLibraryDir: path.join(userDataDir, 'broll-library'),
    governorDir,
  });
  bridge.register();
  return { bridge, handlers, userDataDir, governorDir };
}

function createSampleProject({ realVideo = false } = {}) {
  const root = tempDir('vidmyo-auto-editor-project-');
  const artifactsDir = path.join(root, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });

  const sourceFile = path.join(root, 'source.mp4');
  if (realVideo) {
    const ffmpegBin = actualCore.resolveFfmpegBinary();
    const gen = spawnSync(ffmpegBin, [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=1:sample_rate=48000',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000',
      sourceFile,
    ], { encoding: 'utf8' });
    if (gen.status !== 0) {
      throw new Error(`Failed to generate test fixture: ${gen.stderr}`);
    }
  } else {
    fs.writeFileSync(sourceFile, 'fake video data for hash');
  }

  const manifest = {
    name: 'Sample Cleaner Take',
    source: { path: sourceFile },
  };
  fs.writeFileSync(path.join(root, 'cleaner.json'), JSON.stringify(manifest));

  const plan = {
    summary: { source_seconds: 12.0, output_seconds: 8.0, removed_seconds: 4.0, proposed_cuts: 1 },
    decisions: [
      { segment_id: 'seg_001', start_seconds: 0.0, end_seconds: 4.0, decision: 'keep', text: 'Welcome back to the channel developer tutorial today.' },
      { segment_id: 'seg_002', start_seconds: 4.0, end_seconds: 8.0, decision: 'cut', text: 'Um let me restart that sentence.' },
      { segment_id: 'seg_003', start_seconds: 8.0, end_seconds: 12.0, decision: 'keep', text: 'Today we explore software and analytics growth.' },
    ],
  };
  fs.writeFileSync(path.join(artifactsDir, 'cleaner-plan.v1.json'), JSON.stringify(plan));

  return { root, manifest, plan };
}

test('preload exposes window.autoEditor and window.publisher with exact IPC contracts', () => {
  assert.match(preloadSource, /getEdg: \(projectDir\) => ipcRenderer\.invoke\('autoEditor:get-edg', projectDir\)/);
  assert.match(preloadSource, /applyAction: \(projectDir, action\) => ipcRenderer\.invoke\('autoEditor:apply-action', projectDir, action\)/);
  assert.match(preloadSource, /undo: \(projectDir\) => ipcRenderer\.invoke\('autoEditor:undo', projectDir\)/);
  assert.match(preloadSource, /redo: \(projectDir\) => ipcRenderer\.invoke\('autoEditor:redo', projectDir\)/);
  assert.match(preloadSource, /getSuggestions: \(projectDir, options\) => ipcRenderer\.invoke\('autoEditor:get-suggestions', projectDir, options\)/);
  assert.match(preloadSource, /exportNle: \(projectDir, format\) => ipcRenderer\.invoke\('autoEditor:export-nle', projectDir, format\)/);
  assert.match(preloadSource, /publisher:[\s\S]*testMockUpload: \(opts\) => ipcRenderer\.invoke\('publisher:test-mock-upload', opts\)/);
});

test('autoEditorBridge builds validated EDG from Cleaner project', async () => {
  const { handlers } = harness();
  const { root } = createSampleProject();

  const getEdgHandler = handlers.get('autoEditor:get-edg');
  assert.ok(getEdgHandler);

  const res = await getEdgHandler(null, root);
  assert.equal(res.ok, true);
  assert.ok(res.edg);
  assert.equal(res.edg.schemaVersion, '1.0.0');

  // Verify only kept segments are in the EDG primary video track
  const videoTrack = res.edg.tracks.find(t => t.id === 'video-primary');
  assert.equal(videoTrack.clips.length, 2);
  assert.equal(videoTrack.clips[0].id, 'clip_seg_001');
  assert.equal(videoTrack.clips[1].id, 'clip_seg_003');
  assert.equal(res.history.canUndo, false);
});

test('autoEditorBridge supports apply-action, undo, and redo with history state', async () => {
  const { handlers } = harness();
  const { root } = createSampleProject();

  const applyAction = handlers.get('autoEditor:apply-action');
  const undo = handlers.get('autoEditor:undo');
  const redo = handlers.get('autoEditor:redo');

  // 1. Cut segment 1
  const cutRes = await applyAction(null, root, {
    type: 'toggle_decision',
    segmentId: 'seg_001',
    decision: 'cut',
  });
  assert.equal(cutRes.ok, true);
  assert.equal(cutRes.history.canUndo, true);
  assert.equal(cutRes.history.canRedo, false);

  // Now only seg_003 should be kept
  let videoTrack = cutRes.edg.tracks.find(t => t.id === 'video-primary');
  assert.equal(videoTrack.clips.length, 1);
  assert.equal(videoTrack.clips[0].id, 'clip_seg_003');

  // 2. Undo
  const undoRes = await undo(null, root);
  assert.equal(undoRes.ok, true);
  assert.equal(undoRes.history.canUndo, false);
  assert.equal(undoRes.history.canRedo, true);

  // seg_001 should be restored
  videoTrack = undoRes.edg.tracks.find(t => t.id === 'video-primary');
  assert.equal(videoTrack.clips.length, 2);

  // 3. Redo
  const redoRes = await redo(null, root);
  assert.equal(redoRes.ok, true);
  assert.equal(redoRes.history.canUndo, true);
  assert.equal(redoRes.history.canRedo, false);

  videoTrack = redoRes.edg.tracks.find(t => t.id === 'video-primary');
  assert.equal(videoTrack.clips.length, 1);
});

test('autoEditorBridge returns B-roll (0.72 threshold) and Retention suggestions', async () => {
  const { handlers } = harness();
  const { root } = createSampleProject();

  const getSuggestions = handlers.get('autoEditor:get-suggestions');
  const res = await getSuggestions(null, root);
  assert.equal(res.ok, true, res.error);

  assert.ok(Array.isArray(res.brollSuggestions));
  // B-roll suggestions score >= 0.72
  for (const broll of res.brollSuggestions) {
    assert.ok(broll.score >= 0.72);
    assert.ok(broll.assetId);
  }

  assert.ok(res.retention);
  assert.ok(res.retention.rainyScore.totalScore >= 0);
  assert.ok(Array.isArray(res.retention.retentionEvents));
});

test('autoEditorBridge exports FCPXML and Premiere XML', async () => {
  const { handlers } = harness();
  const { root } = createSampleProject();

  const exportNle = handlers.get('autoEditor:export-nle');

  // Export FCPXML
  const fcpxmlRes = await exportNle(null, root, 'fcpxml');
  assert.equal(fcpxmlRes.ok, true);
  assert.ok(fs.existsSync(fcpxmlRes.exportPath));
  const fcpxmlContent = fs.readFileSync(fcpxmlRes.exportPath, 'utf8');
  assert.match(fcpxmlContent, /<!DOCTYPE fcpxml>/);

  // Export Premiere XML
  const premiereRes = await exportNle(null, root, 'premiere');
  assert.equal(premiereRes.ok, true);
  assert.ok(fs.existsSync(premiereRes.exportPath));
  const premiereContent = fs.readFileSync(premiereRes.exportPath, 'utf8');
  assert.match(premiereContent, /<xmeml version="4">/);
});

test('autoEditorBridge persists undo/redo history to disk and embeds b-roll overlays in EDG', async () => {
  const { handlers } = harness();
  const { root } = createSampleProject();

  const applyAction = handlers.get('autoEditor:apply-action');
  const getSuggestions = handlers.get('autoEditor:get-suggestions');
  const getEdg = handlers.get('autoEditor:get-edg');

  // 1. Test custom threshold in get-suggestions
  const strictSug = await getSuggestions(null, root, { threshold: 0.99 });
  assert.equal(strictSug.ok, true);
  // High threshold preserves original / yields 0 matches
  assert.equal(strictSug.brollSuggestions.length, 0);

  const looseSug = await getSuggestions(null, root, { threshold: 0.30 });
  assert.equal(looseSug.ok, true);
  assert.ok(looseSug.brollSuggestions.length > 0);

  // 2. Add B-roll overlay action
  const ovRes = await applyAction(null, root, {
    type: 'add_broll_overlay',
    overlay: {
      id: 'ov_code_01',
      assetId: 'stock_code_typing',
      startSec: 1.0,
      durationSec: 2.5,
      license: 'cc0',
      author: 'Vidmyo Stock',
      source: 'pexels',
    },
  });
  assert.equal(ovRes.ok, true);

  // Check history file exists on disk
  const historyFile = path.join(root, 'artifacts', 'auto-editor-history.json');
  assert.ok(fs.existsSync(historyFile));
  const historyData = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
  assert.equal(historyData.undo.length, 1);
  assert.equal(historyData.undo[0].type, 'remove_broll_overlay');

  // Verify overlay track and asset in EDG
  const edgRes = await getEdg(null, root);
  assert.equal(edgRes.ok, true);
  const overlayTrack = edgRes.edg.tracks.find(t => t.id === 'overlay-broll');
  assert.equal(overlayTrack.clips.length, 1);
  assert.equal(overlayTrack.clips[0].assetId, 'stock_code_typing');
  assert.ok(edgRes.edg.assets.stock_code_typing);
  assert.equal(edgRes.edg.assets.stock_code_typing.provenance.license, 'cc0');
});

test('autoEditorBridge loads a user-configured B-roll registry from disk and falls back honestly when absent', async () => {
  const { handlers } = harness();
  const { root } = createSampleProject();
  const getSuggestions = handlers.get('autoEditor:get-suggestions');

  // No manifest configured: falls back to the small built-in CC0 sample, labeled as such.
  const fallbackRes = await getSuggestions(null, root, { threshold: 0.30 });
  assert.equal(fallbackRes.ok, true, fallbackRes.error);
  assert.equal(fallbackRes.registry.source, 'builtin_cc0_sample');
  assert.deepEqual(fallbackRes.registry.rejected, []);

  // A real user-configured registry directory with complete licence fields is honored.
  const registryDir = tempDir('vidmyo-broll-registry-');
  fs.writeFileSync(path.join(registryDir, 'manifest.json'), JSON.stringify([
    {
      id: 'user_clip_dev_setup',
      tags: ['code', 'software', 'developer'],
      shot: 'medium',
      emotion: 'neutral',
      durationSec: 4.0,
      license: 'pexels',
      author: 'Test Provider',
      fileHash: 'user_hash_0001',
      redistributionRight: true,
      source: 'https://www.pexels.com/license/',
      licenseProofUrl: 'https://www.pexels.com/license/',
    },
  ]));

  const userRes = await getSuggestions(null, root, { threshold: 0.30, registryDir });
  assert.equal(userRes.ok, true, userRes.error);
  assert.equal(userRes.registry.source, 'user_registry');
  assert.equal(userRes.registry.clipCount, 1);
  assert.deepEqual(userRes.registry.rejected, []);
});

test('autoEditorBridge surfaces rejected registry entries with exact licence reasons', async () => {
  const { handlers } = harness();
  const { root } = createSampleProject();
  const getSuggestions = handlers.get('autoEditor:get-suggestions');

  const registryDir = tempDir('vidmyo-broll-registry-mixed-');
  fs.writeFileSync(path.join(registryDir, 'manifest.json'), JSON.stringify([
    {
      id: 'good_entry',
      tags: ['code', 'software', 'developer'],
      shot: 'medium',
      emotion: 'neutral',
      durationSec: 4.0,
      license: 'cc0',
      author: 'Provider',
      fileHash: 'good_hash_0001',
      redistributionRight: true,
      source: 'https://example.com/cc0',
      licenseProofDoc: 'docs/licences/cc0.txt',
    },
    {
      id: 'bad_entry',
      tags: ['code'],
      shot: 'medium',
      emotion: 'neutral',
      durationSec: 3.0,
      license: 'mystery-licence',
      author: 'Provider',
      fileHash: 'bad_hash_00001',
      // no redistributionRight, no source, no proof
    },
  ]));

  const res = await getSuggestions(null, root, { threshold: 0.30, registryDir });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.registry.clipCount, 1);
  assert.equal(res.registry.rejected.length, 1);
  assert.equal(res.registry.rejected[0].id, 'bad_entry');
  const reasons = res.registry.rejected[0].reasons.join('; ');
  assert.match(reasons, /redistributionRight/);
  assert.match(reasons, /source/);
  assert.match(reasons, /proof of licence/);
  assert.match(reasons, /not approved for commercial redistribution/);

  // The rejected entry must not leak into matching candidates
  assert.equal(res.brollResult.chosenClip?.id, 'good_entry');
});

test('autoEditorBridge get-suggestions applies hypothesis defaults and echoes backend-received params', async () => {
  const { handlers } = harness();
  const { root } = createSampleProject();
  const getSuggestions = handlers.get('autoEditor:get-suggestions');

  // Defaults (no options): 0.72 / 30 / 150 / 1.15
  const defaults = await getSuggestions(null, root);
  assert.equal(defaults.ok, true, defaults.error);
  assert.deepEqual(defaults.params, { threshold: 0.72, rotationDays: 30, paddingMs: 150, zoomFactor: 1.15 });
  assert.equal(defaults.retention.rotationDays, 30);
  assert.equal(defaults.retention.paddingMs, 150);
  assert.equal(defaults.retention.zoomFactor, 1.15);

  // Overrides from the UI reach the backend and are echoed back
  const overridden = await getSuggestions(null, root, {
    threshold: 0.55,
    rotationDays: 14,
    paddingMs: 250,
    zoomFactor: 1.22,
  });
  assert.equal(overridden.ok, true, overridden.error);
  assert.deepEqual(overridden.params, { threshold: 0.55, rotationDays: 14, paddingMs: 250, zoomFactor: 1.22 });
  assert.equal(overridden.retention.rotationDays, 14);
  assert.equal(overridden.retention.paddingMs, 250);
  assert.equal(overridden.retention.zoomFactor, 1.22);

  // Out-of-range hypothesis values are rejected with a clear error
  const badThreshold = await getSuggestions(null, root, { threshold: 1.5 });
  assert.equal(badThreshold.ok, false);
  assert.match(badThreshold.error, /threshold must be within/);
  const badRotation = await getSuggestions(null, root, { rotationDays: 0 });
  assert.equal(badRotation.ok, false);
  assert.match(badRotation.error, /rotationDays must be within/);
});

test('AutoEditorPanel sends all four hypothesis params to the backend and labels them as hypotheses', () => {
  const panelPath = fileURLToPath(new URL('../../../packages/studio/src/components/AutoEditorPanel.jsx', import.meta.url));
  const panelSource = fs.readFileSync(panelPath, 'utf8');

  // All four configured values are sent in the getSuggestions payload
  assert.match(panelSource, /threshold: brollThreshold/);
  assert.match(panelSource, /rotationDays,\n\s*paddingMs,\n\s*zoomFactor,/);

  // Hypothesis labelling: configurable values are hypotheses to measure, not proven rules
  assert.match(panelSource, /hipotez/i);
  assert.match(panelSource, /mierzone, nie gwarantowane/);

  // The backend echo of received params is rendered in the existing UI
  assert.match(panelSource, /Backend otrzymał/);
});

test('autoEditorBridge apply-broll-suggestion writes the accepted match into the EDG with undo support', async () => {
  const { handlers } = harness();
  const { root } = createSampleProject();

  const getSuggestions = handlers.get('autoEditor:get-suggestions');
  const applySuggestion = handlers.get('autoEditor:apply-broll-suggestion');
  const undo = handlers.get('autoEditor:undo');
  const getEdg = handlers.get('autoEditor:get-edg');

  const sug = await getSuggestions(null, root, { threshold: 0.30 });
  assert.equal(sug.ok, true);
  assert.ok(sug.brollResult.chosenClip);

  const applyRes = await applySuggestion(null, root, { clip: sug.brollResult.chosenClip, startSec: 2.0, durationSec: 3.0 });
  assert.equal(applyRes.ok, true, applyRes.error);
  assert.equal(applyRes.history.canUndo, true);

  const overlayTrack = applyRes.edg.tracks.find(t => t.id === 'overlay-broll');
  assert.equal(overlayTrack.clips.length, 1);
  assert.equal(overlayTrack.clips[0].assetId, sug.brollResult.chosenClip.id);

  // Rejects malformed clip input instead of silently no-op'ing
  const badRes = await applySuggestion(null, root, { clip: { id: 'no_hash' } });
  assert.equal(badRes.ok, false);

  // Accept flow is undoable through the same history stack as manual overlay edits
  const undoRes = await undo(null, root);
  assert.equal(undoRes.ok, true, undoRes.error);
  const edgAfterUndo = await getEdg(null, root);
  const overlayTrackAfterUndo = edgAfterUndo.edg.tracks.find(t => t.id === 'overlay-broll');
  assert.equal(overlayTrackAfterUndo.clips.length, 0);
});

test('autoEditorBridge render-preview routes through JobStore with heavy governor lease', async () => {
  const { handlers } = harness();
  const { root } = createSampleProject({ realVideo: true });

  const renderPreview = handlers.get('autoEditor:render-preview');
  const res = await renderPreview(null, root);
  assert.equal(res.ok, true, res.error);
  assert.ok(res.jobId);
  assert.ok(fs.existsSync(res.previewPath));

  // Check job record in .vidmyo/jobs
  const jobFile = path.join(root, '.vidmyo', 'jobs', `${res.jobId}.json`);
  assert.ok(fs.existsSync(jobFile));
  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  assert.equal(job.type, 'render_preview');
  assert.equal(job.state, 'done');
  assert.equal(job.artifacts[0].path, res.previewPath);
});

