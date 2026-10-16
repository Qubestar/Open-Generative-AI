// Auto-Editor & B-roll/Retention Desktop Bridge for Vidmyo V2.6
// Connects EDG, Undo/Redo, B-roll matching, Retention optimization,
// Preview rendering, and NLE export to Electron IPC.

const { ipcMain, app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { resolveRuntimePaths } = require('./runtimePaths');
const { vidmyoHome } = require('../../packages/core/src/paths.cjs');

let corePromise = null;
function defaultCore() {
  if (!corePromise) {
    const runtime = resolveRuntimePaths({ isPackaged: app?.isPackaged, resourcesPath: process.resourcesPath });
    const entry = path.join(runtime.coreDir, 'index.js');
    corePromise = import(pathToFileURL(entry).href);
  }
  return corePromise;
}

// In-memory undo/redo stacks per project, backed by disk
const undoStacks = new Map(); // projectDir -> Array<action>
const redoStacks = new Map(); // projectDir -> Array<action>

function getHistory(projectDir) {
  const norm = path.resolve(projectDir);
  if (!undoStacks.has(norm)) {
    const historyFile = path.join(norm, 'artifacts', 'auto-editor-history.json');
    if (fs.existsSync(historyFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
        undoStacks.set(norm, Array.isArray(data.undo) ? data.undo : []);
        redoStacks.set(norm, Array.isArray(data.redo) ? data.redo : []);
      } catch {
        undoStacks.set(norm, []);
        redoStacks.set(norm, []);
      }
    } else {
      undoStacks.set(norm, []);
      redoStacks.set(norm, []);
    }
  }
  return {
    undo: undoStacks.get(norm),
    redo: redoStacks.get(norm),
  };
}

function persistHistory(projectDir) {
  const norm = path.resolve(projectDir);
  const historyFile = path.join(norm, 'artifacts', 'auto-editor-history.json');
  const { undo, redo } = getHistory(projectDir);
  atomicWriteJson(historyFile, {
    version: '1.0.0',
    updatedAt: new Date().toISOString(),
    undo,
    redo,
  });
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* ignore */ }
  }
}

function loadCleanerPlan(projectDir) {
  const planPath = path.join(projectDir, 'artifacts', 'cleaner-plan.v1.json');
  if (fs.existsSync(planPath)) {
    return JSON.parse(fs.readFileSync(planPath, 'utf8'));
  }
  return null;
}

// Resolution order (Phase 3 item 1): explicit dep -> app.getPath('userData')
// -> vidmyoHome(). Production keeps app.getPath('userData').
function resolveUserDataDir(deps) {
  if (deps && deps.userDataDir) return path.resolve(deps.userDataDir);
  const application = (deps && deps.app) || app;
  try {
    if (application && typeof application.getPath === 'function') return application.getPath('userData');
  } catch {
    // fall through to vidmyoHome()
  }
  return vidmyoHome();
}

// Shared by the manual 'add_broll_overlay' action and the B-roll suggestion
// accept flow, so both leave a consistent, undoable history entry and the
// overlay is actually persisted into the plan (and therefore the EDG).
function addBrollOverlayToPlan(projectDir, overlay) {
  const planPath = path.join(projectDir, 'artifacts', 'cleaner-plan.v1.json');
  if (!fs.existsSync(planPath)) throw new Error('Cleaner plan not found');
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

  if (!plan.overlays) plan.overlays = [];
  plan.overlays.push(overlay);
  atomicWriteJson(planPath, plan);

  const { undo, redo } = getHistory(projectDir);
  undo.push({ type: 'remove_broll_overlay', overlayId: overlay.id });
  redo.length = 0;
  persistHistory(projectDir);
}

function loadCleanerManifest(projectDir) {
  const manifestPath = path.join(projectDir, 'cleaner.json');
  if (fs.existsSync(manifestPath)) {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  }
  return null;
}

function buildProjectEdg(projectDir, core) {
  const manifest = loadCleanerManifest(projectDir);
  const plan = loadCleanerPlan(projectDir);
  const sourcePath = manifest?.source?.path || path.join(projectDir, 'source.mp4');

  let fileHash = '0000000000000000';
  if (fs.existsSync(sourcePath)) {
    fileHash = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
  }

  const fps = 30;
  const edg = core.createEdgTimeline({
    title: manifest?.name || path.basename(projectDir),
    aspect: '16:9',
    fps,
    assets: {
      asset_main_video: {
        id: 'asset_main_video',
        path: sourcePath,
        hash: fileHash,
        type: 'video',
        durationSec: plan?.summary?.source_seconds || 60,
      },
    },
    tracks: [
      { id: 'video-primary', type: 'video', name: 'Primary Video', clips: [] },
      { id: 'overlay-broll', type: 'overlay', name: 'B-Roll & Overlays', clips: [] },
      { id: 'audio-voice', type: 'audio', name: 'Voiceover & Dialogue', clips: [] },
      { id: 'captions-main', type: 'caption', name: 'Subtitles & Captions', clips: [] },
    ],
  });

  const videoTrack = edg.tracks.find(t => t.id === 'video-primary');
  const overlayTrack = edg.tracks.find(t => t.id === 'overlay-broll');
  const audioTrack = edg.tracks.find(t => t.id === 'audio-voice');
  const captionTrack = edg.tracks.find(t => t.id === 'captions-main');

  let timelineFrame = 0;
  const decisions = plan?.decisions || [];

  for (const item of decisions) {
    if (item.decision === 'cut') continue;
    const startSec = item.start_seconds || 0;
    const endSec = item.end_seconds || startSec + 1;
    const durSec = Math.max(0.1, endSec - startSec);
    const startFrame = Math.round(startSec * fps);
    const endFrame = Math.round(endSec * fps);
    const clipDurFrames = Math.max(1, endFrame - startFrame);

    const clipId = `clip_${item.segment_id || timelineFrame}`;
    videoTrack.clips.push({
      id: clipId,
      assetId: 'asset_main_video',
      sourceStartFrame: startFrame,
      sourceEndFrame: endFrame,
      timelineStartFrame: timelineFrame,
      timelineEndFrame: timelineFrame + clipDurFrames,
    });

    audioTrack.clips.push({
      id: `audio_${clipId}`,
      assetId: 'asset_main_video',
      sourceStartFrame: startFrame,
      sourceEndFrame: endFrame,
      timelineStartFrame: timelineFrame,
      timelineEndFrame: timelineFrame + clipDurFrames,
    });

    if (item.text) {
      captionTrack.clips.push({
        id: `cap_${clipId}`,
        text: item.text,
        timelineStartFrame: timelineFrame,
        timelineEndFrame: timelineFrame + clipDurFrames,
      });
    }

    timelineFrame += clipDurFrames;
  }

  // Embed B-roll overlays with provenance and hashes into EDG
  if (Array.isArray(plan?.overlays) && overlayTrack) {
    for (const ov of plan.overlays) {
      const assetId = ov.assetId || `broll_${ov.id || ov.segment_id || 'overlay'}`;
      if (!edg.assets[assetId]) {
        edg.assets[assetId] = {
          id: assetId,
          path: ov.path || path.join(projectDir, 'assets', `${assetId}.mp4`),
          hash: ov.hash || crypto.createHash('sha256').update(String(ov.id || assetId)).digest('hex'),
          type: 'video',
          durationSec: ov.durationSec || 5,
          provenance: {
            license: ov.license || 'cc0',
            author: ov.author || 'Stock Provider',
            source: ov.source || 'stock_registry',
          },
        };
      }
      overlayTrack.clips.push({
        id: `overlay_${ov.id || Math.random().toString(36).slice(2, 8)}`,
        assetId,
        timelineStartFrame: Math.round((ov.startSec || 0) * fps),
        timelineEndFrame: Math.round(((ov.startSec || 0) + (ov.durationSec || 3)) * fps),
        transform: ov.transform || { x: 0, y: 0, scale: 1 },
      });
    }
  }

  edg.totalTimelineFrames = timelineFrame;
  return edg;
}

function createAutoEditorBridge(deps = {}) {
  const ipc = deps.ipcMain || ipcMain;
  const getCore = deps.core || defaultCore;

  const userDataDir = resolveUserDataDir(deps);
  const jobsDir = deps.jobsDir ? path.resolve(deps.jobsDir) : path.join(userDataDir, 'jobs');
  const exportsDir = deps.exportsDir ? path.resolve(deps.exportsDir) : path.join(userDataDir, 'exports');
  const brollLibraryDir = deps.brollLibraryDir
    ? path.resolve(deps.brollLibraryDir)
    : path.join(userDataDir, 'broll-library');
  const defaultBrollLibraryDir = () => brollLibraryDir;
  const governorDirFor = (core) => (deps.governorDir ? path.resolve(deps.governorDir) : core.defaultGovernorDir());
  const previewAbortControllers = new Map();

  function register() {
    // 1. Get current EDG for project
    ipc.handle('autoEditor:get-edg', async (_event, projectDir) => {
      try {
        const core = await getCore();
        const edg = buildProjectEdg(projectDir, core);
        core.validateEdg(edg);
        const { undo, redo } = getHistory(projectDir);
        return {
          ok: true,
          edg,
          history: {
            canUndo: undo.length > 0,
            canRedo: redo.length > 0,
            undoCount: undo.length,
          },
        };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 2. Apply editing decision with undo tracking and disk persistence
    ipc.handle('autoEditor:apply-action', async (_event, projectDir, action) => {
      try {
        const core = await getCore();
        const planPath = path.join(projectDir, 'artifacts', 'cleaner-plan.v1.json');
        if (!fs.existsSync(planPath)) throw new Error('Cleaner plan not found');
        const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

        const { undo, redo } = getHistory(projectDir);

        if (action.type === 'toggle_decision') {
          const item = plan.decisions.find(d => d.segment_id === action.segmentId);
          if (!item) throw new Error('Segment not found');
          const previousDecision = item.decision;
          item.decision = action.decision;
          item.reviewed = true;
          plan.summary.proposed_cuts = plan.decisions.filter(d => d.decision === 'cut').length;
          atomicWriteJson(planPath, plan);

          undo.push({
            type: 'toggle_decision',
            segmentId: action.segmentId,
            decision: previousDecision,
          });
          redo.length = 0; // Clear redo stack on new action
          persistHistory(projectDir);
        } else if (action.type === 'add_broll_overlay') {
          addBrollOverlayToPlan(projectDir, action.overlay);
        }

        const updatedEdg = buildProjectEdg(projectDir, core);
        return {
          ok: true,
          edg: updatedEdg,
          history: {
            canUndo: undo.length > 0,
            canRedo: redo.length > 0,
          },
        };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 3. Undo
    ipc.handle('autoEditor:undo', async (_event, projectDir) => {
      try {
        const core = await getCore();
        const { undo, redo } = getHistory(projectDir);
        if (undo.length === 0) return { ok: false, error: 'Nothing to undo' };

        const lastAction = undo.pop();
        const planPath = path.join(projectDir, 'artifacts', 'cleaner-plan.v1.json');
        const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

        if (lastAction.type === 'toggle_decision') {
          const item = plan.decisions.find(d => d.segment_id === lastAction.segmentId);
          if (item) {
            const currentDecision = item.decision;
            item.decision = lastAction.decision;
            atomicWriteJson(planPath, plan);
            redo.push({
              type: 'toggle_decision',
              segmentId: lastAction.segmentId,
              decision: currentDecision,
            });
            persistHistory(projectDir);
          }
        } else if (lastAction.type === 'remove_broll_overlay') {
          const overlays = Array.isArray(plan.overlays) ? plan.overlays : [];
          const idx = overlays.findIndex(o => o.id === lastAction.overlayId);
          if (idx !== -1) {
            const [removed] = overlays.splice(idx, 1);
            atomicWriteJson(planPath, plan);
            redo.push({ type: 'add_broll_overlay', overlay: removed });
            persistHistory(projectDir);
          }
        }

        const edg = buildProjectEdg(projectDir, core);
        return {
          ok: true,
          edg,
          history: { canUndo: undo.length > 0, canRedo: redo.length > 0 },
        };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 4. Redo
    ipc.handle('autoEditor:redo', async (_event, projectDir) => {
      try {
        const core = await getCore();
        const { undo, redo } = getHistory(projectDir);
        if (redo.length === 0) return { ok: false, error: 'Nothing to redo' };

        const action = redo.pop();
        const planPath = path.join(projectDir, 'artifacts', 'cleaner-plan.v1.json');
        const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

        if (action.type === 'toggle_decision') {
          const item = plan.decisions.find(d => d.segment_id === action.segmentId);
          if (item) {
            const currentDecision = item.decision;
            item.decision = action.decision;
            atomicWriteJson(planPath, plan);
            undo.push({
              type: 'toggle_decision',
              segmentId: action.segmentId,
              decision: currentDecision,
            });
            persistHistory(projectDir);
          }
        } else if (action.type === 'add_broll_overlay') {
          if (!plan.overlays) plan.overlays = [];
          plan.overlays.push(action.overlay);
          atomicWriteJson(planPath, plan);
          undo.push({ type: 'remove_broll_overlay', overlayId: action.overlay.id });
          persistHistory(projectDir);
        }

        const edg = buildProjectEdg(projectDir, core);
        return {
          ok: true,
          edg,
          history: { canUndo: undo.length > 0, canRedo: redo.length > 0 },
        };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 5. Get B-roll and Retention Suggestions with configurable hypothesis
    // parameters (threshold / rotation / padding / zoom) and licence-field
    // enforcement: rejected manifest entries come back with exact reasons.
    ipc.handle('autoEditor:get-suggestions', async (_event, projectDir, options = {}) => {
      try {
        const core = await getCore();
        const plan = loadCleanerPlan(projectDir);
        if (!plan) throw new Error('Cleaner plan not found');

        const fullText = (plan.decisions || []).filter(d => d.decision !== 'cut').map(d => d.text).join(' ');

        // Hypothesis parameters: validated ranges, defaults match the UI defaults.
        const num = (value, fallback) => (Number.isFinite(value) ? value : fallback);
        const params = {
          threshold: num(options.threshold, 0.72),
          rotationDays: num(options.rotationDays, 30),
          paddingMs: num(options.paddingMs, 150),
          zoomFactor: num(options.zoomFactor, 1.15),
        };
        if (params.threshold < 0 || params.threshold > 1) throw new Error(`threshold must be within [0, 1], got ${params.threshold}`);
        if (params.rotationDays < 1 || params.rotationDays > 365) throw new Error(`rotationDays must be within [1, 365], got ${params.rotationDays}`);
        if (params.paddingMs < 0 || params.paddingMs > 2000) throw new Error(`paddingMs must be within [0, 2000], got ${params.paddingMs}`);
        if (params.zoomFactor < 1 || params.zoomFactor > 3) throw new Error(`zoomFactor must be within [1, 3], got ${params.zoomFactor}`);
        const threshold = params.threshold;

        // Visual intent & B-roll matching using a user-configurable, disk-backed registry.
        // Falls back to a small built-in CC0 sample set (honestly labeled) when the user
        // has not populated <userData>/broll-library/manifest.json with a licensed catalog.
        // Entries missing redistributionRight / source / proof of licence are rejected
        // by loadBrollRegistry with exact reasons (surfaced to the UI).
        const registryDir = (options && options.registryDir) || defaultBrollLibraryDir();
        const registry = core.loadBrollRegistry({ registryDir });
        const licenseRegistry = new core.MediaLicenseRegistry();
        for (const item of registry.clips) {
          licenseRegistry.register({
            id: item.id,
            author: item.author,
            source: item.source || registry.source,
            license: item.license,
            fileHash: item.fileHash,
            redistributionRight: item.redistributionRight,
            licenseProofUrl: item.licenseProofUrl,
            licenseProofDoc: item.licenseProofDoc,
            permittedUse: 'commercial_video',
          });
        }

        const intent = core.extractVisualIntent(fullText.slice(0, 300) || 'software developer workflow');
        const brollResult = core.matchBrollClip(intent, registry.clips, { threshold, licenseRegistry });

        // Retention & Hook analysis (rotation window honours the UI-configured hypothesis)
        const hookText = fullText.slice(0, 100) || 'How to build fast software';
        const rainyScore = core.scoreRainyHook(hookText);
        const retentionEvents = core.generateRetentionEvents(plan.summary?.source_seconds || 60);
        const rotationRegistry = new core.HookRotationRegistry({ rotationDays: params.rotationDays });

        return {
          ok: true,
          intent,
          brollResult,
          brollSuggestions: brollResult.chosenClip ? [brollResult.chosenClip] : [],
          registry: {
            source: registry.source,
            registryDir,
            clipCount: registry.clips.length,
            rejected: registry.rejected || [],
          },
          params,
          retention: {
            rainyScore,
            retentionEvents,
            rotationDays: rotationRegistry.rotationDays,
            paddingMs: params.paddingMs,
            zoomFactor: params.zoomFactor,
          },
        };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 5b. Apply a chosen B-roll suggestion (top match or a 1-click-swap alternative)
    // into the project's persisted overlays. Delegates to the same undo-tracked
    // 'add_broll_overlay' action as manual overlay edits, so history stays consistent
    // and the accepted clip is actually written into the EDG overlay track.
    ipc.handle('autoEditor:apply-broll-suggestion', async (_event, projectDir, { clip, startSec, durationSec } = {}) => {
      try {
        const core = await getCore();
        if (!clip || !clip.id || !clip.fileHash) {
          throw new Error('A clip with id and fileHash is required to apply a B-roll suggestion');
        }
        addBrollOverlayToPlan(projectDir, {
          id: `broll_${clip.id}_${Date.now()}`,
          assetId: clip.id,
          path: clip.path || null,
          hash: clip.fileHash,
          license: clip.license || 'cc0',
          author: clip.author || 'Unknown',
          source: clip.source || 'stock_registry',
          startSec: Number.isFinite(startSec) ? startSec : 0,
          durationSec: Number.isFinite(durationSec) ? durationSec : (clip.durationSec || 3),
        });

        const { undo, redo } = getHistory(projectDir);
        const edg = buildProjectEdg(projectDir, core);
        core.validateEdg(edg);
        return { ok: true, edg, history: { canUndo: undo.length > 0, canRedo: redo.length > 0 } };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 6. Export to NLE (FCPXML / Premiere XML)
    ipc.handle('autoEditor:export-nle', async (_event, projectDir, format = 'fcpxml') => {
      try {
        const core = await getCore();
        const edg = buildProjectEdg(projectDir, core);
        const exportsDir = path.join(projectDir, 'exports');
        fs.mkdirSync(exportsDir, { recursive: true });

        let xmlContent;
        let exportPath;
        if (format === 'premiere') {
          xmlContent = core.exportToPremiereXml(edg);
          exportPath = path.join(exportsDir, `${path.basename(projectDir)}_premiere.xml`);
        } else {
          xmlContent = core.exportToFcpxml(edg);
          exportPath = path.join(exportsDir, `${path.basename(projectDir)}.fcpxml`);
        }

        fs.writeFileSync(exportPath, xmlContent, 'utf8');
        return { ok: true, exportPath, format };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 7. Render Preview with JobStore and Resource Governor
    ipc.handle('autoEditor:render-preview', async (_event, projectDir, options = {}) => {
      let jobId = null;
      try {
        const core = await getCore();
        const edg = buildProjectEdg(projectDir, core);
        core.validateEdg(edg);
        const previewPath = path.join(projectDir, 'artifacts', 'edg-preview.mp4');
        fs.mkdirSync(path.dirname(previewPath), { recursive: true });

        const requestedJobId = typeof options === 'string' ? options : options?.jobId || _event?.jobId || null;
        const projectJobsDir = path.join(projectDir, '.vidmyo', 'jobs');
        const store = new core.JobStore(projectJobsDir, { governorDir: governorDirFor(core) });
        const job = store.create({
          id: requestedJobId,
          type: 'render_preview',
          project: path.basename(projectDir),
          params: { isPreview: true },
        });
        jobId = job.id;
        const runningJob = store.setState(job.id, 'running');
        if (!runningJob || runningJob.state !== 'running') {
          return { ok: false, jobId: job.id, error: runningJob?.error || 'Governor admission denied' };
        }

        const controller = new AbortController();
        previewAbortControllers.set(job.id, controller);
        try {
          const adapter = new core.RendererAdapter();
          const result = await adapter.renderExport(edg, previewPath, {
            renderer: 'ffmpeg',
            isPreview: true,
            execute: true,
            governor: store.governor,
            jobId: job.id,
            signal: controller.signal,
          });
          const currentJob = store.get(job.id);
          if (currentJob && currentJob.state === 'cancelled') {
            return { ok: false, jobId: job.id, cancelled: true, error: 'Job was cancelled' };
          }
          store.artifact(job.id, { path: previewPath, kind: 'preview' });
          store.checkpoint(job.id, 'artifact', previewPath);
          store.setState(job.id, 'done');
          return {
            ok: true,
            previewPath,
            result,
            jobId: job.id,
            encoder: result?.encoder,
            code: result?.code ?? 0,
          };
        } catch (err) {
          const currentJob = store.get(job.id);
          if (currentJob && currentJob.state === 'cancelled') {
            return { ok: false, jobId: job.id, cancelled: true, error: 'Job was cancelled' };
          }
          store.setState(job.id, 'error', { error: err.message });
          throw err;
        } finally {
          previewAbortControllers.delete(job.id);
        }
      } catch (err) {
        return { ok: false, jobId, error: err.message };
      }
    });

    // 8. Cancel an in-flight preview render
    ipc.handle('autoEditor:cancel-preview', async (_event, cancelJobId, projectDir = null) => {
      try {
        if (!cancelJobId) return { ok: false, error: 'jobId is required' };
        const core = await getCore();
        const pJobsDir = projectDir ? path.join(projectDir, '.vidmyo', 'jobs') : jobsDir;
        const store = new core.JobStore(pJobsDir, { governorDir: governorDirFor(core) });
        const job = store.get(cancelJobId);
        if (job && (job.state === 'running' || job.state === 'queued')) {
          store.cancel(cancelJobId);
        }
        const controller = previewAbortControllers.get(cancelJobId);
        if (controller) {
          try { controller.abort(); } catch { /* ignore */ }
        }
        return { ok: true, jobId: cancelJobId, cancelled: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    return true;
  }

  return { register, buildProjectEdg };
}

let defaultBridge = null;
function register() {
  if (!defaultBridge) defaultBridge = createAutoEditorBridge();
  return defaultBridge.register();
}

module.exports = { createAutoEditorBridge, register };
