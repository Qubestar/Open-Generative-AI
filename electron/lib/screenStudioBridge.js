// Screen Studio Desktop Bridge for Vidmyo V2.6.
// Governed screen capture, telemetry mapping, preview generation, and export.
// Phase 5, Step 4 (Checkpoint D).

const { ipcMain, app, systemPreferences, screen, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
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

function isOutside(base, target) {
  const rel = path.relative(base, target);
  return rel === '' ? false : (rel.startsWith('..') || path.isAbsolute(rel));
}

const JOB_ID_PATTERN = /^job_[\w-]+$/;
const VALID_BACKGROUNDS = new Set(['NONE', 'GRADIENT_PURPLE', 'GRADIENT_SUNSET', 'MINIMAL_DARK']);
const MAX_READ_BYTES = 256 * 1024 * 1024; // 256 MiB cap (R1)
// Native ScreenCaptureKit recorder (built from native/screen-capture). Inside a
// packaged app it lives in app.asar.unpacked, since binaries cannot run from asar.
function defaultCaptureHelper() {
  if (process.platform !== 'darwin') return null;
  const candidate = path
    .join(__dirname, '..', 'bin', 'vidmyo-capture')
    .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  return fs.existsSync(candidate) ? candidate : null;
}

const PERMISSION_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

function createScreenStudioBridge(deps = {}) {
  const ipc = deps.ipcMain || ipcMain;
  const getCore = deps.core || defaultCore;
  const electronScreen = deps.screen || screen;
  const electronSysPref = deps.systemPreferences || systemPreferences;
  const electronShell = deps.shell || shell;

  // Tests that inject a fake core keep the ffmpeg path unless they opt in.
  const captureHelper = deps.captureHelper !== undefined
    ? deps.captureHelper
    : (deps.core ? null : defaultCaptureHelper());
  const userDataDir = resolveUserDataDir(deps);
  const recordingsDir = deps.recordingsDir ? path.resolve(deps.recordingsDir) : path.join(userDataDir, 'recordings');
  const exportsDir = deps.exportsDir ? path.resolve(deps.exportsDir) : path.join(userDataDir, 'exports');
  const jobsDir = deps.jobsDir ? path.resolve(deps.jobsDir) : path.join(userDataDir, 'jobs');

  fs.mkdirSync(recordingsDir, { recursive: true });
  fs.mkdirSync(exportsDir, { recursive: true });

  let activeSession = null;
  const exportAbortControllers = new Map();
  // Telemetry/T0 captured at Stop, keyed by recording jobId (never trusted from renderer).
  const recordingTelemetry = new Map();
  // EDG built in main from the recording, keyed by recording jobId (edgId).
  const edgCache = new Map();

  const VALID_FPS = new Set([24, 25, 30, 60]);

  // Terminal-state-safe JobStore write. `screen:cancel-export` may set
  // `cancelled` while the render is still unwinding; a second write for the
  // same terminal state must not throw an illegal-transition error.
  function safeSetState(store, id, target, extra) {
    try {
      const record = store.get(id);
      if (record?.state === target) return;
      if (record?.state === 'cancelled' || record?.state === 'error') return;
      store.setState(id, target, extra);
    } catch {
      // never let a bookkeeping write reject the IPC handler
    }
  }

  function validateRecordingOptions(options = {}) {
    const fps = options.fps ?? 30;
    if (!VALID_FPS.has(Number(fps))) {
      return { ok: false, error: `Invalid fps: ${fps}. Must be one of: 24, 25, 30, 60.` };
    }
    const maxDurationSec = options.maxDurationSec ?? 7200;
    const duration = Number(maxDurationSec);
    if (!Number.isFinite(duration) || duration < 1 || duration > 7200) {
      return { ok: false, error: `Invalid maxDurationSec: ${maxDurationSec}. Must be between 1 and 7200 seconds.` };
    }
    return { ok: true, fps: Number(fps), maxDurationSec: duration };
  }

  // Validates requested device indexes against a fresh enumeration. When
  // enumeration fails, non-null indexes are refused rather than blindly allowed.
  async function validateCaptureDevices(core, { videoDeviceIndex, audioDeviceIndex, systemAudioDeviceIndex }) {
    let devices = null;
    let enumError = null;
    try {
      devices = await core.listAvfoundationCaptureDevices({ ffmpegBinary: deps.ffmpegBinary || null });
    } catch (err) {
      enumError = err;
    }

    const screens = devices?.screens || [];
    const audio = devices?.audio || [];

    if (screens.length > 0 && !screens.some((s) => Number(s.index) === Number(videoDeviceIndex))) {
      return { ok: false, error: `Unknown videoDeviceIndex: ${videoDeviceIndex}` };
    }
    if (enumError && screens.length === 0 && Number(videoDeviceIndex) > 0) {
      return { ok: false, error: `Cannot verify videoDeviceIndex ${videoDeviceIndex}: device enumeration failed (${enumError.message})` };
    }

    const checkAudio = (value, label) => {
      if (value === null || value === undefined || value === 'none') return null;
      const idx = Number(value);
      if (!Number.isInteger(idx) || idx < 0) return `Invalid ${label}: ${value}`;
      if (audio.length > 0) {
        return audio.some((a) => Number(a.index) === idx) ? null : `Unknown ${label}: ${idx}`;
      }
      if (enumError) return `Cannot verify ${label} ${idx}: device enumeration failed (${enumError.message})`;
      return `No audio capture devices available (requested ${label} ${idx})`;
    };

    const audioErr = checkAudio(audioDeviceIndex, 'audioDeviceIndex');
    if (audioErr) return { ok: false, error: audioErr };
    const sysErr = checkAudio(systemAudioDeviceIndex, 'systemAudioDeviceIndex');
    if (sysErr) return { ok: false, error: sysErr };

    return { ok: true };
  }

  // Confirms a candidate recording with ffprobe before a job is marked done.
  async function confirmRecording(core, filePath, { governor, jobId } = {}) {
    if (!filePath || !fs.existsSync(filePath)) {
      return { confirmed: false, reason: 'output file is missing', fileSize: 0 };
    }
    const stat = fs.statSync(filePath);
    if (stat.size <= 0) {
      return { confirmed: false, reason: 'output file is empty', fileSize: 0 };
    }
    const binary = core.resolveFfmpegBinary(deps.ffmpegBinary || null);
    const adapter = new core.RendererAdapter({ ffmpegPath: binary });
    const probe = await adapter.probeMediaGoverned(filePath, {
      governor: governor || null,
      jobId: `job_probe_${jobId}`,
      timeoutMs: 30000,
    });
    const video = probe.streams?.find((s) => s.codec_type === 'video');
    const durationSec = Number(video?.duration || probe.format?.duration || 0);
    if (!video || !(durationSec > 0)) {
      return { confirmed: false, reason: 'ffprobe found no playable video stream', fileSize: stat.size };
    }
    return {
      confirmed: true,
      durationSec,
      fileSize: stat.size,
      width: Number(video.width) || null,
      height: Number(video.height) || null,
      hasAudio: Boolean(probe.streams?.some((st) => st.codec_type === 'audio')),
    };
  }

  // Handles FFmpeg exiting on its own (duration limit, crash, TCC denial).
  // Clears the active session and finalizes the job so `screen:status` never
  // reports a stale `isRecording:true`.
  // Last recording that ended on its own (crash, permission loss, time limit),
  // so status/stop can tell the UI what happened instead of "no session".
  let lastSelfExit = null;

  async function handleSessionSelfExit(session, code, signal) {
    if (!session || session.isStopping || session.isCancelled) return;

    try {
      const { core, store, governor } = await getGovernorAndStore();
      const probe = await confirmRecording(core, session.outputPath, { governor, jobId: session.jobId });
      if (code === 0 && probe.confirmed) {
        lastSelfExit = {
          jobId: session.jobId,
          error: 'Nagrywanie zakończyło się samo (osiągnięto limit czasu). Plik został zapisany.',
        };
        store.setState(session.jobId, 'done', {
          outputPath: session.outputPath,
          durationSec: probe.durationSec,
          fileSize: probe.fileSize,
        });
      } else {
        const message = session.getLastError?.()
          ? `Nagrywanie przerwane: ${session.getLastError()}`
          : `Nagrywanie przerwane (kod ${code}${signal ? `, sygnał ${signal}` : ''})${probe.confirmed ? '' : `: ${probe.reason}`}`;
        lastSelfExit = { jobId: session.jobId, error: message };
        store.setState(session.jobId, 'error', {
          error: session.getLastError?.()
            ? `Nagrywanie przerwane: ${session.getLastError()}`
            : `Recording process exited unexpectedly (code ${code}, signal ${signal || 'none'})${probe.confirmed ? '' : `: ${probe.reason}`}`,
        });
      }
    } catch {
      // best effort: never let the exit observer throw
    } finally {
      // Clear the session only after the job state is finalized, so
      // `screen:status` never reports a fresh idle state ahead of the job.
      if (activeSession === session) activeSession = null;
    }
  }

  async function getGovernorAndStore() {
    const core = await getCore();
    const governorDir = deps.governorDir ? path.resolve(deps.governorDir) : core.defaultGovernorDir();
    const store = new core.JobStore(jobsDir, { governorDir });
    const governor = store.governor;
    return { core, store, governor };
  }

  function register() {
    // 1. Permission check
    ipc.handle('screen:check-permission', async () => {
      const core = await getCore();
      const getMediaStatus = electronSysPref?.getMediaAccessStatus
        ? (mediaType) => electronSysPref.getMediaAccessStatus(mediaType)
        : null;
      return core.checkNativeScreenRecordingPermission({
        platform: process.platform,
        getMediaAccessStatus: getMediaStatus,
      });
    });

    // 2. Open macOS System Settings for Screen Recording (constant URL)
    ipc.handle('screen:open-permission-settings', async () => {
      try {
        if (electronShell && typeof electronShell.openExternal === 'function') {
          await electronShell.openExternal(PERMISSION_SETTINGS_URL);
          return { ok: true, url: PERMISSION_SETTINGS_URL };
        }
        return { ok: false, error: 'shell.openExternal not available' };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 3. List capture sources (screens, microphones)
    ipc.handle('screen:list-sources', async () => {
      const core = await getCore();
      const displays = electronScreen?.getAllDisplays
        ? electronScreen.getAllDisplays().map((d) => ({
            id: d.id,
            bounds: d.bounds,
            scaleFactor: d.scaleFactor,
          }))
        : [];

      if (captureHelper) {
        try {
          const native = await core.listScreenCaptureKitSources({ helperBinary: captureHelper });
          return {
            ok: true,
            backend: 'screencapturekit',
            screens: native.displays.map((d, index) => ({
              index,
              displayId: d.id,
              name: `${d.name} (${d.width}×${d.height})`,
            })),
            audioDevices: native.microphones.map((m, index) => ({
              index,
              id: m.id,
              name: m.name,
              isDefault: Boolean(m.isDefault),
            })),
            // ScreenCaptureKit records system audio natively (no loopback driver).
            systemAudioSupported: true,
            displays,
          };
        } catch (err) {
          return { ok: false, code: err.code || 'EHELPER', error: err.message };
        }
      }

      let devices = { screens: [], audio: [] };
      try {
        devices = await core.listAvfoundationCaptureDevices({
          ffmpegBinary: deps.ffmpegBinary || null,
        });
      } catch (err) {
        // Fallback if ffmpeg is missing or listing fails
        devices = {
          screens: [{ index: 0, name: 'Default Display (Display 0)', isScreen: true }],
          audio: [],
        };
      }

      return {
        ok: true,
        backend: 'avfoundation',
        screens: devices.screens || [],
        audioDevices: devices.audio || [],
        systemAudioSupported: false,
        displays,
      };
    });

    // 4. Status (elapsed timer, governor busy state per R7)
    ipc.handle('screen:status', async () => {
      const { governor } = await getGovernorAndStore();
      const activeLeases = governor.getActiveLeases();
      const heavyLease = activeLeases.find((l) => l.resourceClass === 'heavy');
      const governorBusy = Boolean(heavyLease && (!activeSession || heavyLease.jobId !== activeSession.jobId));
      const heldBy = heavyLease ? heavyLease.jobId : null;

      if (!activeSession) {
        return {
          ok: true,
          isRecording: false,
          recording: false,
          activeJobId: null,
          jobId: null,
          elapsedSec: 0,
          durationSeconds: 0,
          governorBusy,
          heldBy,
          endedUnexpectedly: lastSelfExit,
        };
      }

      const elapsedSec = Math.round((Date.now() - activeSession.startedAtMs) / 1000);
      return {
        ok: true,
        isRecording: true,
        recording: true,
        activeJobId: activeSession.jobId,
        jobId: activeSession.jobId,
        startedAtMs: activeSession.startedAtMs,
        elapsedSec,
        durationSeconds: elapsedSec,
        governorBusy,
        heldBy,
      };
    });

    // 5. Start recording
    ipc.handle('screen:start-recording', async (_, options = {}) => {
      const videoDeviceIndex = options.videoDeviceIndex !== undefined
        ? options.videoDeviceIndex
        : (options.screenIndex !== undefined ? options.screenIndex : 0);
      const audioDeviceIndex = options.audioDeviceIndex ?? null;
      const systemAudioDeviceIndex = options.systemAudioDeviceIndex ?? null;
      const requestedJobId = options.jobId ?? null;

      // Validate renderer-supplied options in the main process, before any
      // JobStore write or governor admission (item 9).
      if (typeof videoDeviceIndex !== 'number' || !Number.isInteger(videoDeviceIndex) || videoDeviceIndex < 0) {
        return { ok: false, error: `Invalid screenIndex / videoDeviceIndex: ${videoDeviceIndex}` };
      }
      const optionCheck = validateRecordingOptions(options);
      if (!optionCheck.ok) return optionCheck;
      const { fps, maxDurationSec } = optionCheck;

      // Permission check
      const core = await getCore();
      const getMediaStatus = electronSysPref?.getMediaAccessStatus
        ? (mediaType) => electronSysPref.getMediaAccessStatus(mediaType)
        : null;
      const perm = await core.checkNativeScreenRecordingPermission({
        platform: process.platform,
        getMediaAccessStatus: getMediaStatus,
      });

      if (!perm.granted && !perm.authorized) {
        return {
          ok: false,
          code: 'EPERM_SCREEN',
          error: perm.reason || 'Screen Recording permission is required.',
        };
      }

      if (activeSession) {
        return {
          ok: false,
          code: 'EBUSY',
          error: 'A screen recording is already in progress.',
        };
      }

      const jobId = requestedJobId && JOB_ID_PATTERN.test(requestedJobId)
        ? requestedJobId
        : `job_record_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      if (!JOB_ID_PATTERN.test(jobId)) {
        return { ok: false, error: `Invalid jobId format: ${jobId}` };
      }

      // Output path generated strictly inside recordingsDir
      const outputPath = path.join(recordingsDir, `${jobId}.mp4`);

      // Verify the selected screen/microphone against a fresh enumeration.
      let helperOptions = null;
      if (captureHelper) {
        let native;
        try {
          native = await core.listScreenCaptureKitSources({ helperBinary: captureHelper });
        } catch (err) {
          return { ok: false, code: err.code || 'EDEVICE', error: err.message };
        }
        const display = native.displays[videoDeviceIndex];
        if (!display) return { ok: false, code: 'EDEVICE', error: `Unknown screen: ${videoDeviceIndex}` };
        let microphoneId = null;
        if (audioDeviceIndex !== null && audioDeviceIndex !== undefined && audioDeviceIndex !== 'none') {
          const mic = native.microphones[Number(audioDeviceIndex)];
          if (!mic) return { ok: false, code: 'EDEVICE', error: `Unknown microphone: ${audioDeviceIndex}` };
          microphoneId = mic.id;
        }
        helperOptions = {
          helperBinary: captureHelper,
          displayId: display.id,
          microphoneId,
          systemAudio: Boolean(options.systemAudio),
        };
      } else {
        const deviceCheck = await validateCaptureDevices(core, {
          videoDeviceIndex,
          audioDeviceIndex,
          systemAudioDeviceIndex,
        });
        if (!deviceCheck.ok) return { ok: false, code: 'EDEVICE', error: deviceCheck.error };
      }

      const { governor, store } = await getGovernorAndStore();

      // Reject a renderer-supplied jobId that already exists (JobStore record or
      // a recording on disk), so an existing recording can never be overwritten.
      const alreadyExists = Boolean(store.get(jobId)) || fs.existsSync(path.join(recordingsDir, `${jobId}.mp4`));
      if (alreadyExists) {
        return { ok: false, code: 'EJOB_EXISTS', error: `jobId already exists: ${jobId}` };
      }

      // Check governor heavy slot
      const leases = governor.getActiveLeases();
      if (leases.some((l) => l.resourceClass === 'heavy')) {
        return {
          ok: false,
          code: 'EGOVERNOR_BUSY',
          error: 'Resource busy: recording or heavy export already in progress',
          heldBy: leases.find((l) => l.resourceClass === 'heavy')?.jobId,
        };
      }

      store.create({
        id: jobId,
        type: 'screen_record',
        params: {
          outputPath,
          videoDeviceIndex,
          fps,
          startedAt: new Date().toISOString(),
        },
      });
      store.setState(jobId, 'running');

      const getCursorPoint = electronScreen?.getCursorScreenPoint
        ? () => electronScreen.getCursorScreenPoint()
        : null;

      // Watch the child so a self-exit (duration limit, crash, TCC denial)
      // finalizes the job instead of leaving `isRecording:true` forever (item 6).
      let session = null;
      let pendingSelfExit = null;
      const spawnHook = (child) => {
        try {
          child.once('exit', (code, signal) => {
            pendingSelfExit = { code, signal };
            if (session) handleSessionSelfExit(session, code, signal);
          });
        } catch { /* ignore */ }
      };

      try {
        session = await core.startGovernedCapture({
          videoDeviceIndex,
          audioDeviceIndex,
          systemAudioDeviceIndex,
          fps,
          maxDurationSec,
          outputPath,
          governor,
          jobId,
          ffmpegBinary: deps.ffmpegBinary || null,
          spawnImpl: deps.spawnImpl,
          getCursorPoint,
          onSpawn: deps.onSpawn || spawnHook,
          killImpl: deps.killImpl,
          livenessImpl: deps.livenessImpl,
          ...(helperOptions || {}),
        });

        activeSession = session;
        lastSelfExit = null;
        recordingTelemetry.delete(jobId);
        edgCache.delete(jobId);

        if (pendingSelfExit) {
          await handleSessionSelfExit(session, pendingSelfExit.code, pendingSelfExit.signal);
        }

        return {
          ok: true,
          jobId,
          outputPath,
          startedAtMs: session.startedAtMs,
        };
      } catch (err) {
        store.setState(jobId, 'error', { error: err.message });
        return {
          ok: false,
          code: err.code || 'ESTART_FAILED',
          error: `Failed to start recording: ${err.message}`,
        };
      }
    });

    // 6. Stop recording
    ipc.handle('screen:stop-recording', async () => {
      if (!activeSession) {
        if (lastSelfExit) {
          const { error, jobId } = lastSelfExit;
          lastSelfExit = null;
          return { ok: false, code: 'EENDED', jobId, error };
        }
        return { ok: false, error: 'Nagrywanie nie jest aktywne.' };
      }

      const session = activeSession;
      activeSession = null;

      const { core, store, governor } = await getGovernorAndStore();
      try {
        const result = await session.stop();
        if (!result.ok) {
          store.setState(session.jobId, 'error', { error: result.error });
          return result;
        }

        // Keep this session's telemetry and capture clock in main, keyed by jobId.
        // Never trust telemetry sent back from the renderer (item 4).
        recordingTelemetry.set(session.jobId, {
          telemetry: result.telemetry || [],
          captureT0Ms: Number.isFinite(result.captureT0Ms) ? result.captureT0Ms : null,
          samplerStartedAtMs: Number.isFinite(result.samplerStartedAtMs) ? result.samplerStartedAtMs : null,
        });
        edgCache.delete(session.jobId);

        // A recording is only done when ffprobe confirms a playable video
        // stream; exit code / wall clock alone is not enough (item 7).
        let probe;
        try {
          probe = await confirmRecording(core, result.outputPath, { governor, jobId: session.jobId });
        } catch (err) {
          probe = { confirmed: false, reason: err.message };
        }
        if (!probe.confirmed) {
          store.setState(session.jobId, 'error', { error: `Recording not confirmed: ${probe.reason}` });
          return { ok: false, code: 'EUNCONFIRMED', error: `Recording could not be confirmed: ${probe.reason}` };
        }

        store.setState(session.jobId, 'done', {
          outputPath: result.outputPath,
          durationSec: probe.durationSec,
          fileSize: probe.fileSize,
        });
        // Telemetry stays in main (see recordingTelemetry); the renderer only
        // needs the jobId to preview/export and the sample count to display.
        const { telemetry: _telemetry, ...summary } = result;
        return {
          ...summary,
          jobId: session.jobId,
          samplesCount: (result.telemetry || []).length,
          // Separate tracks for the export mixer.
          hasSystemAudio: Boolean(probe.hasAudio),
          hasMicrophone: Boolean(result.micPath && fs.existsSync(result.micPath)),
          durationSec: probe.durationSec,
          fileSize: probe.fileSize,
          confirmed: true,
        };
      } catch (err) {
        store.setState(session.jobId, 'error', { error: err.message });
        return { ok: false, error: err.message };
      }
    });

    // 7. Cancel recording
    ipc.handle('screen:cancel-recording', async () => {
      if (!activeSession) {
        return { ok: false, error: 'No recording session currently active' };
      }

      const session = activeSession;
      activeSession = null;

      const { store } = await getGovernorAndStore();
      try {
        const result = await session.cancel();
        store.setState(session.jobId, 'cancelled');
        recordingTelemetry.delete(session.jobId);
        edgCache.delete(session.jobId);
        return result;
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 8. Read recording (capped at 256 MiB per R1)
    ipc.handle('screen:read-recording', async (_, options = {}) => {
      const { jobId, filePath: requestedPath } = options;
      // track: 'microphone' reads the separate mic track for the preview mixer.
      const isMicTrack = options.track === 'microphone';
      let targetPath;

      if (jobId) {
        if (!JOB_ID_PATTERN.test(jobId)) {
          return { ok: false, error: `Invalid jobId: ${jobId}` };
        }
        targetPath = path.join(recordingsDir, isMicTrack ? `${jobId}.mic.m4a` : `${jobId}.mp4`);
      } else if (requestedPath) {
        targetPath = path.resolve(requestedPath);
        if (isOutside(recordingsDir, targetPath)) {
          return { ok: false, error: 'Access denied: filePath must be inside recordings directory' };
        }
      } else {
        return { ok: false, error: 'jobId or filePath is required' };
      }

      if (!fs.existsSync(targetPath)) {
        return { ok: false, error: `File not found: ${targetPath}` };
      }

      const stat = fs.statSync(targetPath);
      if (stat.size > MAX_READ_BYTES) {
        return {
          ok: false,
          tooLarge: true,
          size: stat.size,
          maxBytes: MAX_READ_BYTES,
          error: `Recording file (${(stat.size / (1024 * 1024)).toFixed(1)} MiB) exceeds the 256 MiB preview limit.`,
          message: 'Build a low-bitrate preview or open in Finder.',
        };
      }

      const buf = fs.readFileSync(targetPath);
      const dataUrl = `data:${isMicTrack ? 'audio/mp4' : 'video/mp4'};base64,${buf.toString('base64')}`;
      return { ok: true, data: dataUrl, dataUrl, size: stat.size, path: targetPath };
    });

    // 9. Build low-bitrate proxy preview (R1)
    ipc.handle('screen:build-preview', async (_, options = {}) => {
      const { jobId } = options;
      if (!jobId || !JOB_ID_PATTERN.test(jobId)) {
        return { ok: false, error: `Invalid jobId: ${jobId}` };
      }

      const inputPath = path.join(recordingsDir, `${jobId}.mp4`);
      const previewPath = path.join(recordingsDir, `${jobId}.preview.mp4`);

      if (!fs.existsSync(inputPath)) {
        return { ok: false, error: `Original recording not found: ${inputPath}` };
      }

      const { core, governor } = await getGovernorAndStore();
      const binary = core.resolveFfmpegBinary(deps.ffmpegBinary);

      try {
        await core.runGovernedFfmpeg({
          cmd: binary,
          args: [
            '-y',
            '-i', inputPath,
            '-vf', 'scale=960:-2',
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-b:v', '1M',
            '-c:a', 'aac',
            '-b:a', '96k',
            previewPath,
          ],
          governor,
          jobId: `job_prev_${jobId}`,
          resourceClass: 'heavy',
          timeoutMs: 60000,
        });

        if (fs.existsSync(previewPath)) {
          const stat = fs.statSync(previewPath);
          if (stat.size > MAX_READ_BYTES) {
            return {
              ok: false,
              tooLarge: true,
              size: stat.size,
              maxBytes: MAX_READ_BYTES,
              error: `Proxy preview (${(stat.size / (1024 * 1024)).toFixed(1)} MiB) exceeds the 256 MiB in-memory limit.`,
            };
          }
          const buf = fs.readFileSync(previewPath);
          return {
            ok: true,
            previewPath,
            size: stat.size,
            dataUrl: `data:video/mp4;base64,${buf.toString('base64')}`,
          };
        }
        return { ok: false, error: 'Preview generation produced no output' };
      } catch (err) {
        return { ok: false, error: `Failed to build preview: ${err.message}` };
      }
    });

    // 10. Build EDG from recording (main-side; the renderer never supplies the EDG)
    ipc.handle('screen:build-edg', async (_, options = {}) => {
      const { jobId, aspect = '16:9' } = options;
      if (!jobId || !JOB_ID_PATTERN.test(jobId)) {
        return { ok: false, error: `Invalid jobId: ${jobId}` };
      }
      if (!['16:9', '9:16', '1:1'].includes(aspect)) {
        return { ok: false, error: `Invalid aspect: ${aspect}` };
      }
      const fps = Number(options.fps ?? 30);
      if (!VALID_FPS.has(fps)) {
        return { ok: false, error: `Invalid fps: ${options.fps}` };
      }

      const recordingPath = path.join(recordingsDir, `${jobId}.mp4`);
      if (!fs.existsSync(recordingPath)) {
        return { ok: false, error: `Recording not found: ${recordingPath}` };
      }

      const { core, governor } = await getGovernorAndStore();
      const displays = electronScreen?.getAllDisplays
        ? electronScreen.getAllDisplays().map((d) => ({
            id: d.id,
            bounds: d.bounds,
            scaleFactor: d.scaleFactor,
          }))
        : [];

      // Telemetry captured at Stop, shifted onto the capture clock (item 4).
      const stored = recordingTelemetry.get(jobId) || {};
      const telemetry = core.shiftTelemetryToCaptureClock(stored.telemetry || [], {
        captureT0Ms: stored.captureT0Ms,
        samplerStartedAtMs: stored.samplerStartedAtMs,
      });

      try {
        const result = await core.createScreenStudioEdgFromRecording({
          recordingPath,
          telemetry,
          dwellEvents: [],
          aspect,
          fps,
          displays,
          governor,
          jobId: `job_edg_${jobId}`,
          ffmpegBinary: deps.ffmpegBinary || null,
        });

        // Keep the canonical EDG in main; render-export looks it up by edgId.
        edgCache.set(jobId, result.edg);

        return {
          ok: true,
          edgId: jobId,
          edg: result.edg,
          hash: result.hash,
          durationSec: result.durationSec,
          totalFrames: result.totalFrames,
          zoomKeyframes: result.zoomKeyframes,
          telemetryStatus: result.telemetryStatus,
          samplesCount: telemetry.length,
        };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 11. Render MP4 export from a main-side EDG looked up by edgId
    ipc.handle('screen:render-export', async (_, options = {}) => {
      const { jobId: requestedJobId = null, edgId = null } = options;
      if (!edgId || !JOB_ID_PATTERN.test(edgId)) {
        return { ok: false, error: 'edgId is required (call buildEdg after stopping the recording)' };
      }
      const edg = edgCache.get(edgId);
      if (!edg) {
        return { ok: false, error: `No EDG found for edgId ${edgId}` };
      }

      // Defence in depth: the recording source must stay inside recordingsDir.
      const sourcePath = edg.assets?.screen_source?.path;
      if (sourcePath && isOutside(recordingsDir, path.resolve(sourcePath))) {
        return { ok: false, error: 'Access denied: recording source must be inside the recordings directory' };
      }

      const fps = Number(options.fps ?? 30);
      if (!VALID_FPS.has(fps)) {
        return { ok: false, error: `Invalid fps: ${options.fps}` };
      }
      const width = Number(options.width ?? 1280);
      const height = Number(options.height ?? 720);
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16 || width > 8192 || height > 8192) {
        return { ok: false, error: `Invalid export dimensions: ${width}x${height}` };
      }

      const gain = (v) => (v === undefined || v === null ? 1 : Number(v));
      const micVolume = gain(options.micVolume);
      const systemVolume = gain(options.systemVolume);
      if (![micVolume, systemVolume].every((v) => Number.isFinite(v) && v >= 0 && v <= 2)) {
        return { ok: false, error: 'micVolume / systemVolume must be between 0 and 2' };
      }
      const backgroundPreset = options.backgroundPreset ?? 'NONE';
      if (!VALID_BACKGROUNDS.has(backgroundPreset)) {
        return { ok: false, error: `Invalid backgroundPreset: ${backgroundPreset}` };
      }

      const jobId = requestedJobId && JOB_ID_PATTERN.test(requestedJobId)
        ? requestedJobId
        : `job_export_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      if (!JOB_ID_PATTERN.test(jobId)) {
        return { ok: false, error: `Invalid jobId: ${jobId}` };
      }

      const outputPath = path.join(exportsDir, `${jobId}_export.mp4`);
      const { core, governor, store } = await getGovernorAndStore();

      store.create({
        id: jobId,
        type: 'screen_export',
        params: { outputPath, startedAt: new Date().toISOString() },
      });
      store.setState(jobId, 'running');

      const abortController = new AbortController();
      exportAbortControllers.set(jobId, abortController);

      try {
        const result = await core.renderScreenStudioExport(edg, outputPath, {
          fps,
          width,
          height,
          governor,
          jobId,
          signal: abortController.signal,
          ffmpegBinary: deps.ffmpegBinary || null,
          backgroundPreset,
          autoZoom: options.autoZoom !== false,
          micVolume,
          systemVolume,
        });

        if (abortController.signal.aborted) {
          safeSetState(store, jobId, 'cancelled', { error: 'Cancelled' });
          return { ok: false, cancelled: true, error: 'Cancelled', jobId };
        }
        safeSetState(store, jobId, 'done', { outputPath, durationSec: result.durationSec });
        return { ok: true, ...result, jobId };
      } catch (err) {
        const cancelled = abortController.signal.aborted || err.code === 'ECANCELLED';
        safeSetState(store, jobId, cancelled ? 'cancelled' : 'error', { error: err.message });
        return {
          ok: false,
          cancelled,
          error: err.message,
          jobId,
        };
      } finally {
        exportAbortControllers.delete(jobId);
      }
    });

    // 12. Cancel render export
    ipc.handle('screen:cancel-export', async (_, jobId) => {
      if (!jobId || !JOB_ID_PATTERN.test(jobId)) {
        return { ok: false, error: `Invalid jobId: ${jobId}` };
      }

      const controller = exportAbortControllers.get(jobId);
      if (controller) {
        controller.abort();
      }

      const { store } = await getGovernorAndStore();
      safeSetState(store, jobId, 'cancelled', { error: 'Cancelled' });

      return { ok: true, cancelled: true, jobId };
    });

    // 13. Show item in folder (safe check: must be in recordingsDir or exportsDir)
    ipc.handle('screen:show-in-finder', async (_, options = {}) => {
      const { filePath } = options;
      if (!filePath) return { ok: false, error: 'filePath is required' };

      const resolved = path.resolve(filePath);
      if (isOutside(recordingsDir, resolved) && isOutside(exportsDir, resolved)) {
        return { ok: false, error: 'Access denied: path is outside recordings and exports' };
      }

      if (electronShell && typeof electronShell.showItemInFolder === 'function') {
        electronShell.showItemInFolder(resolved);
        return { ok: true };
      }
      return { ok: false, error: 'shell.showItemInFolder not available' };
    });
  }

  async function stop({ waitMs = 10000 } = {}) {
    if (activeSession) {
      try {
        await activeSession.stop({ waitMs });
      } catch {
        try { await activeSession.cancel(); } catch { /* ignore */ }
      }
      activeSession = null;
    }
    for (const [id, ctrl] of exportAbortControllers.entries()) {
      try { ctrl.abort(); } catch { /* ignore */ }
    }
    exportAbortControllers.clear();
    recordingTelemetry.clear();
    edgCache.clear();
  }

  return {
    register,
    stop,
    userDataDir,
    recordingsDir,
    exportsDir,
  };
}

let defaultBridge = null;
function register() {
  if (!defaultBridge) {
    defaultBridge = createScreenStudioBridge();
  }
  return defaultBridge.register();
}

function stop(opts) {
  return defaultBridge ? defaultBridge.stop(opts) : Promise.resolve();
}

module.exports = {
  createScreenStudioBridge,
  register,
  stop,
};

