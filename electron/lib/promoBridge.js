// Promo, UGC Review, Avatar Fallback & Screen Studio Desktop Bridge for Vidmyo V2.6
const { ipcMain, app, systemPreferences, desktopCapturer, screen, dialog } = require('electron');
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

// Resolution order (Phase 3 item 1): explicit dep -> app.getPath('userData')
// -> vidmyoHome(). Production keeps app.getPath('userData'); tests inject a
// private mkdtemp directory so no bridge test can touch the real ~/.vidmyo.
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

// Reject anything that escapes `allowed` — computed with path.relative so
// sibling-prefix tricks (…/exports-evil) cannot pass a startsWith check.
function isOutside(base, target) {
  const rel = path.relative(base, target);
  return rel === '' ? false : (rel.startsWith('..') || path.isAbsolute(rel));
}

function makeResolveSafeOutputPath(userDataDir, exportsDir) {
  return function resolveSafeOutputPath(outputPath, prefix = 'export') {
    const baseDir = exportsDir;
    fs.mkdirSync(baseDir, { recursive: true });
    if (!outputPath) {
      return path.join(baseDir, `${prefix}_${Date.now()}.mp4`);
    }
    const resolved = path.resolve(outputPath);
    if (isOutside(baseDir, resolved) && isOutside(userDataDir, resolved)) {
      throw new Error(`Export outputPath must be within userData exports: ${resolved}`);
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    return resolved;
  };
}

const SAMPLE_FIXTURES = {
  saas: {
    id: 'saas',
    name: 'Vidmyo AI Studio',
    category: 'digital_saas',
    url: 'https://example.com/vidmyo',
    title: 'Vidmyo - Automated Video Generation & Editing Suite',
    description: 'Transform raw footage into viral shorts in minutes with deterministic AI.',
    h1: 'Next-Gen Video Production for Teams',
    price: '199 zł / mies.',
    coreBenefit: 'automatyzację montażu wideo i skracanie czasu postprodukcji',
    targetAudience: 'twórców i montażystów wideo',
    avoidAudience: 'osób, które nie publikują żadnych treści wideo',
    claims: [
      { text: '10x szybszy montaż w porównaniu do klasycznego workflow', claim: '10x szybszy montaż', source: 'Internal benchmark M2 Pro 2026', verified: true, userExplicitlyConfirmedExperience: true },
      { text: 'Ponad 500 zadowolonych klientów w programie beta', claim: '500 zadowolonych klientów', source: 'Rejestr kont produkcyjnych Vidmyo', verified: true, userExplicitlyConfirmedExperience: true },
    ],
  },
  local_business: {
    id: 'local_business',
    name: 'Klinika Stomatologiczna Warszawa',
    category: 'local_business',
    url: 'https://example.com/stomatologia-warszawa',
    title: 'Bezbolesne Leczenie Zębów i Implanty Warszawa Marszałkowska',
    description: 'Nowoczesny gabinet stomatologiczny w centrum Warszawy. Zapisz się na bezpłatną konsultację.',
    h1: 'Stomatologia i Implantologia Warszawa Śródmieście',
    price: 'od 150 zł',
    coreBenefit: 'bezstresowe i bezbolesne leczenie w centrum Warszawy',
    targetAudience: 'mieszkańców Warszawy szukających sprawdzonego stomatologa',
    avoidAudience: 'osób szukających najtańszych usług bez gwarancji jakości',
    claims: [
      { text: 'Ponad 250 opinii 5-gwiazdkowych', claim: '250 opinii 5.0', source: 'Wizytówka Google Reviews 2026', verified: true, userExplicitlyConfirmedExperience: true },
      { text: 'Zabiegi w znieczuleniu komputerowym bez bólu', claim: 'Znieczulenie komputerowe', source: 'Specyfikacja sprzętu The Wand', verified: true, userExplicitlyConfirmedExperience: true },
    ],
  },
  ecommerce: {
    id: 'ecommerce',
    name: 'Fotel Ergonomiczny ErgoPro Max',
    category: 'ecommerce_product',
    url: 'https://example.com/fotel-ergopro',
    title: 'Fotel Biurowy ErgoPro Max z Dynamicznym Podparciem Lędźwi',
    description: 'Zadbaj o kręgosłup podczas 8-godzinnej pracy przy biurku. 30 dni na darmowy zwrot.',
    h1: 'ErgoPro Max - Koniec z Bólem Pleców',
    price: '1 299 zł',
    coreBenefit: 'eliminację bólu kręgosłupa i zdrowe podparcie lędźwi',
    targetAudience: 'programistów i osób pracujących zdalnie ponad 6h dziennie',
    avoidAudience: 'osób szukających taniego krzesła do sporadycznego siedzenia',
    claims: [
      { text: 'Atest wytrzymałościowy BIFMA do 150 kg', claim: 'Atest BIFMA 150 kg', source: 'Certyfikat TÜV Rheinland 2025', verified: true, userExplicitlyConfirmedExperience: true },
      { text: 'Przetestowane w 30-dniowym badaniu ergonomicznym', claim: '30-dniowe badanie ergonomiczne', source: 'Wewnętrzny raport testowy zespołu ErgoPro', verified: true, userExplicitlyConfirmedExperience: true },
    ],
  },
};

function createPromoBridge(deps = {}) {
  const ipc = deps.ipcMain || ipcMain;
  const getCore = deps.core || defaultCore;

  const userDataDir = resolveUserDataDir(deps);
  const jobsDir = deps.jobsDir ? path.resolve(deps.jobsDir) : path.join(userDataDir, 'jobs');
  const exportsDir = deps.exportsDir ? path.resolve(deps.exportsDir) : path.join(userDataDir, 'exports');
  const resolveSafeOutputPath = makeResolveSafeOutputPath(userDataDir, exportsDir);

  // Governor directory: explicit dep wins, otherwise the shared default
  // (~/.vidmyo/governor, VIDMYO_HOME-overridable) from the loaded core.
  async function governorDirFor(core) {
    return deps.governorDir ? path.resolve(deps.governorDir) : core.defaultGovernorDir();
  }

  // Phase 3 item 4: only the two real renderers exist. Anything else is
  // refused instead of silently falling back to FFmpeg.
  const ALLOWED_RENDERERS = ['ffmpeg', 'hyperframes'];
  function assertRenderer(renderer) {
    if (!ALLOWED_RENDERERS.includes(renderer)) {
      throw new Error(`Unsupported renderer '${renderer}'. Allowed: ${ALLOWED_RENDERERS.join(', ')}.`);
    }
    return renderer;
  }

  const renderAbortControllers = new Map();

  function register() {
    // 1. List or get sample fixtures
    ipc.handle('promo:load-fixtures', async () => {
      return { ok: true, fixtures: SAMPLE_FIXTURES };
    });

    // 2. Safe fetch web page with SSRF protection
    ipc.handle('promo:safe-fetch', async (_event, targetUrl) => {
      try {
        const core = await getCore();
        const metadata = await core.safeFetchPromoPage(targetUrl);
        const classification = core.classifyPromoIntent(metadata);
        return { ok: true, metadata, classification };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 3. Classify intent with optional override
    ipc.handle('promo:classify-intent', async (_event, metadata, override) => {
      try {
        const core = await getCore();
        const result = core.classifyPromoIntent(metadata, override);
        return { ok: true, result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 4. Verify claim sources
    ipc.handle('promo:verify-claims', async (_event, claims) => {
      try {
        const core = await getCore();
        const verification = core.verifyUgcClaims(claims);
        return { ok: true, verification };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 5. Generate 5-step Promo Script
    ipc.handle('promo:generate-promo-script', async (_event, params) => {
      try {
        const core = await getCore();
        const script = core.generatePromoScript(params);
        return { ok: true, script };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 6. Generate UGC Review Script (Type 1 Review or Type 2 Problem)
    ipc.handle('promo:generate-ugc-script', async (_event, type, params) => {
      try {
        const core = await getCore();
        let script;
        if (type === 'type_2_goal_problem') {
          script = core.generateType2GoalProblemScript(params);
        } else {
          script = core.generateType1ReviewScript(params);
        }
        return { ok: true, script };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 7. Build Responsive EDG Timeline (9:16, 1:1, 16:9)
    ipc.handle('promo:build-edg', async (_event, { mode, script, layoutKey, durationSec, fps }) => {
      try {
        const core = await getCore();
        let edg;
        if (mode === 'ugc') {
          edg = core.createResponsiveUgcEdg(script, layoutKey, { fps: fps || 30 });
        } else {
          edg = core.createResponsivePromoEdg(script, layoutKey, { durationSec: durationSec || 15, fps: fps || 30 });
        }
        core.validateEdg(edg);
        return { ok: true, edg };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 8. Render Video Export (routed through JobStore and Governor).
    // `jobId` is optional and client-generated (same pattern as the 2D mascot)
    // so the panel can cancel an in-flight export through
    // `promo:cancel-render-export`. JobStore._file() rejects any id that does
    // not match /^job_[\w-]+$/, so a bad id cannot escape the jobs directory.
    ipc.handle('promo:render-export', async (_event, { edg, outputPath, renderer = 'ffmpeg', isPreview = false, strictEdg = false, jobId: requestedJobId = null } = {}) => {
      let jobId = null;
      try {
        const core = await getCore();
        assertRenderer(renderer);
        core.validateEdg(edg);
        const targetOutput = resolveSafeOutputPath(outputPath, 'promo');

        const store = new core.JobStore(jobsDir, { governorDir: await governorDirFor(core) });
        const job = store.create({
          id: requestedJobId || _event?.jobId || null,
          type: 'render_promo',
          params: { renderer, isPreview },
        });
        jobId = job.id;
        const runningJob = store.setState(job.id, 'running');
        if (!runningJob || runningJob.state !== 'running') {
          return { ok: false, jobId: job.id, error: runningJob?.error || 'Governor admission denied' };
        }

        const controller = new AbortController();
        renderAbortControllers.set(job.id, controller);
        try {
          const adapter = new core.RendererAdapter();
          const result = await adapter.renderExport(edg, targetOutput, {
            renderer,
            isPreview,
            execute: true,
            governor: store.governor,
            jobId: job.id,
            signal: controller.signal,
            strictEdg,
          });
          const currentJob = store.get(job.id);
          if (currentJob && currentJob.state === 'cancelled') {
            return { ok: false, jobId: job.id, cancelled: true, error: 'Job was cancelled' };
          }
          store.artifact(job.id, { path: targetOutput, kind: 'video' });
          store.checkpoint(job.id, 'artifact', targetOutput);
          store.setState(job.id, 'done');
          return {
            ok: true,
            outputPath: targetOutput,
            result,
            jobId: job.id,
            renderer,
            encoder: result?.encoder,
            code: result?.code ?? 0,
            unsupported: result.unsupported || [],
          };
        } catch (err) {
          const currentJob = store.get(job.id);
          if (currentJob && currentJob.state === 'cancelled') {
            return { ok: false, jobId: job.id, cancelled: true, error: 'Job was cancelled' };
          }
          store.setState(job.id, 'error', { error: err.message });
          throw err;
        } finally {
          renderAbortControllers.delete(job.id);
        }
      } catch (err) {
        return { ok: false, jobId, error: err.message, unsupported: err.unsupported || [] };
      }
    });

    // 8b. Cancel an in-flight render export (HyperFrames/FFmpeg) — tree-kill.
    ipc.handle('promo:cancel-render-export', async (_event, cancelJobId) => {
      try {
        if (!cancelJobId) return { ok: false, error: 'jobId is required' };
        const core = await getCore();
        const store = new core.JobStore(jobsDir, { governorDir: await governorDirFor(core) });
        const job = store.get(cancelJobId);
        if (job && (job.state === 'running' || job.state === 'queued')) {
          store.cancel(cancelJobId);
        }
        const controller = renderAbortControllers.get(cancelJobId);
        if (controller) {
          try { controller.abort(); } catch { /* ignore */ }
        }
        return { ok: true, jobId: cancelJobId, cancelled: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 9. Generate Cartoon EDG from Script and Character Consistency Sheet
    ipc.handle('promo:generate-cartoon-edg', async (_event, { scriptLines, characterConfig, aspect = '16:9', fps = 30 } = {}) => {
      try {
        const core = await getCore();
        const registry = new Map();
        if (characterConfig?.id) {
          const char = new core.CharacterSheet(characterConfig);
          registry.set(char.id, char);
        }
        const scenes = core.decomposeScriptToCartoonScenes(scriptLines || [], registry);
        const edg = core.createCartoonEdgTimeline(scenes, { aspect, fps });
        core.validateEdg(edg);
        return { ok: true, edg, scenes };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 10. Render Cartoon Video Export (routed through JobStore and Governor)
    ipc.handle('promo:render-cartoon-export', async (_event, { edg, outputPath, isPreview = false, renderer = 'ffmpeg', strictEdg = false, jobId: requestedJobId = null } = {}) => {
      let jobId = null;
      try {
        const core = await getCore();
        assertRenderer(renderer);
        core.validateEdg(edg);
        const targetOutput = resolveSafeOutputPath(outputPath, 'cartoon');

        const store = new core.JobStore(jobsDir, { governorDir: await governorDirFor(core) });
        const job = store.create({
          id: requestedJobId || _event?.jobId || null,
          type: 'render_cartoon',
          params: { isPreview, renderer },
        });
        jobId = job.id;
        const runningJob = store.setState(job.id, 'running');
        if (!runningJob || runningJob.state !== 'running') {
          return { ok: false, jobId: job.id, error: runningJob?.error || 'Governor admission denied' };
        }

        const controller = new AbortController();
        renderAbortControllers.set(job.id, controller);
        try {
          const adapter = new core.RendererAdapter();
          const result = await adapter.renderExport(edg, targetOutput, {
            renderer,
            isPreview,
            execute: true,
            governor: store.governor,
            jobId: job.id,
            signal: controller.signal,
            strictEdg,
          });
          const currentJob = store.get(job.id);
          if (currentJob && currentJob.state === 'cancelled') {
            return { ok: false, jobId: job.id, cancelled: true, error: 'Job was cancelled' };
          }
          store.artifact(job.id, { path: targetOutput, kind: 'video' });
          store.checkpoint(job.id, 'artifact', targetOutput);
          store.setState(job.id, 'done');
          return {
            ok: true,
            outputPath: targetOutput,
            result,
            jobId: job.id,
            renderer,
            encoder: result?.encoder,
            code: result?.code ?? 0,
            unsupported: result.unsupported || [],
          };
        } catch (err) {
          const currentJob = store.get(job.id);
          if (currentJob && currentJob.state === 'cancelled') {
            return { ok: false, jobId: job.id, cancelled: true, error: 'Job was cancelled' };
          }
          store.setState(job.id, 'error', { error: err.message });
          throw err;
        } finally {
          renderAbortControllers.delete(job.id);
        }
      } catch (err) {
        return { ok: false, jobId, error: err.message, unsupported: err.unsupported || [] };
      }
    });

    // 11. 2D Mascot Fallback Generator
    ipc.handle('promo:generate-2d-mascot', async (_event, opts) => {
      try {
        const core = await getCore();
        const mascot = core.generate2dMascotAvatar(opts || {});
        return { ok: true, mascot };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    const activeMascotRenders = new Map();
    // Phase 3 item 2: cancel goes through an AbortController per job so the
    // governed process can tree-kill (SIGTERM -> SIGKILL escalation) instead
    // of signalling only the direct child.
    const mascotControllers = new Map();

    // 11a. Render 2D Mascot Video via JobStore and Governor
    ipc.handle('promo:render-2d-mascot', async (_event, opts = {}) => {
      try {
        const core = await getCore();
        const targetOutput = resolveSafeOutputPath(opts.outputPath, 'avatar-2d-mascot');
        const mascotConfig = opts.mascotConfig || core.generate2dMascotAvatar(opts);
        const store = new core.JobStore(jobsDir, { governorDir: await governorDirFor(core) });
        const job = store.create({
          id: opts.jobId || null,
          type: 'avatar_2d_mascot_render',
          params: { outputPath: targetOutput, audioPath: opts.audioPath || null },
        });
        const runningJob = store.setState(job.id, 'running');
        if (!runningJob || runningJob.state !== 'running') {
          return { ok: false, jobId: job.id, error: runningJob?.error || 'Governor admission denied' };
        }
        const controller = new AbortController();
        mascotControllers.set(job.id, controller);
        try {
          const result = await core.render2dMascotVideo(mascotConfig, targetOutput, {
            fps: opts.fps || 30,
            width: opts.width || 720,
            height: opts.height || 720,
            audioPath: opts.audioPath || null,
            amplitudeEnvelope: opts.amplitudeEnvelope || mascotConfig.amplitudeEnvelope || null,
            mouthStates: opts.mouthStates || mascotConfig.mouthStates || null,
            governor: store.governor,
            jobId: job.id,
            signal: controller.signal,
            ffmpegBinary: opts.ffmpegBinary || null,
            onSpawn: (proc) => {
              activeMascotRenders.set(job.id, proc);
              store.checkpoint(job.id, 'childProcess', { pid: proc.pid });
            },
          });
          activeMascotRenders.delete(job.id);
          mascotControllers.delete(job.id);
          const currentJob = store.get(job.id);
          if (currentJob && currentJob.state === 'cancelled') {
            return { ok: false, jobId: job.id, cancelled: true, error: 'Job was cancelled' };
          }
          store.artifact(job.id, { path: targetOutput, kind: 'video' });
          store.checkpoint(job.id, 'artifact', targetOutput);
          store.setState(job.id, 'done');
          return { ok: true, jobId: job.id, result, outputPath: targetOutput };
        } catch (renderErr) {
          activeMascotRenders.delete(job.id);
          mascotControllers.delete(job.id);
          const currentJob = store.get(job.id);
          if (currentJob && currentJob.state === 'cancelled') {
            return { ok: false, jobId: job.id, cancelled: true, error: 'Job was cancelled' };
          }
          store.setState(job.id, 'error', { error: renderErr.message });
          throw renderErr;
        }
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 11b. Cancel 2D Mascot Render via JobStore governor & process tree kill
    ipc.handle('promo:cancel-2d-mascot', async (_event, jobId) => {
      try {
        if (!jobId) return { ok: false, error: 'jobId is required' };
        const core = await getCore();
        const store = new core.JobStore(jobsDir, { governorDir: await governorDirFor(core) });
        const job = store.get(jobId);
        // 1. mark the job cancelled first (releases the governor lease via
        //    JobStore.setState), 2. abort so runGovernedProcess tree-kills
        //    the whole process group (grandchildren included).
        if (job && (job.state === 'running' || job.state === 'queued')) {
          store.cancel(jobId);
        }
        const controller = mascotControllers.get(jobId);
        if (controller) {
          try { controller.abort(); } catch { /* ignore */ }
        }
        // Back-compat safety net for a render that predates AbortController.
        const proc = activeMascotRenders.get(jobId);
        if (!controller && proc && typeof proc.kill === 'function') {
          try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        }
        activeMascotRenders.delete(jobId);
        return { ok: true, jobId, cancelled: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 11c. Pick Audio Narration file dialog
    ipc.handle('promo:pick-audio', async () => {
      try {
        const dialogApi = deps.dialog || dialog;
        if (!dialogApi || typeof dialogApi.showOpenDialog !== 'function') {
          return { ok: false, error: 'dialog API not available in current environment' };
        }
        const result = await dialogApi.showOpenDialog({
          title: 'Wybierz plik audio narracji',
          properties: ['openFile'],
          filters: [
            { name: 'Audio Files', extensions: ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'flac'] },
          ],
        });
        if (result.canceled || !result.filePaths?.length) {
          return { ok: false, canceled: true };
        }
        return { ok: true, path: result.filePaths[0] };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 12. Synthetic Screen Studio Session Generator
    ipc.handle('promo:generate-screen-session', async (_event, opts) => {
      try {
        const core = await getCore();
        const session = core.generateSyntheticScreenSession(opts || {});
        return { ok: true, session };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 12a. macOS TCC Screen Recording permission check (real status when running
    // inside Electron's main process; honestly reports "unavailable" otherwise
    // rather than fabricating a status).
    ipc.handle('promo:check-screen-recording-permission', async () => {
      try {
        const core = await getCore();
        const getMediaAccessStatus = systemPreferences && typeof systemPreferences.getMediaAccessStatus === 'function'
          ? systemPreferences.getMediaAccessStatus.bind(systemPreferences)
          : null;
        const permission = core.checkNativeScreenRecordingPermission({ getMediaAccessStatus });
        return { ok: true, permission };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 12b. Real avfoundation capture device enumeration (displays, cameras,
    // microphones) — lists actual hardware, does not require TCC to enumerate.
    ipc.handle('promo:list-screen-capture-devices', async () => {
      try {
        const core = await getCore();
        const devices = await core.listAvfoundationCaptureDevices();
        return { ok: true, devices };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 12c. Native Desktop Sources (screens and windows) via desktopCapturer
    ipc.handle('promo:list-native-sources', async () => {
      try {
        const core = await getCore();
        const sources = await core.listNativeCaptureSources({
          desktopCapturer: deps.desktopCapturer || desktopCapturer,
          screen: deps.screen || screen,
        });
        return { ok: true, sources };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 12d. Start Native Desktop Capture session
    let activeNativeCaptureSession = null;
    ipc.handle('promo:start-native-capture', async (_event, opts = {}) => {
      try {
        const core = await getCore();
        const targetOutput = resolveSafeOutputPath(opts.outputPath, 'native-screen-capture');
        const screenApi = deps.screen || screen;
        const getCursorPoint = screenApi && typeof screenApi.getCursorScreenPoint === 'function'
          ? () => screenApi.getCursorScreenPoint()
          : null;

        activeNativeCaptureSession = new core.NativeScreenCaptureSession({
          sourceId: opts.sourceId || 'screen:0:0',
          displayId: opts.displayId || null,
          videoDeviceIndex: opts.videoDeviceIndex ?? 0,
          audioDeviceIndex: opts.audioDeviceIndex ?? null,
          outputPath: targetOutput,
          fps: opts.fps || 30,
          getCursorPoint,
        });

        const session = activeNativeCaptureSession.start();
        return { ok: true, session };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 12e. Stop Native Desktop Capture session
    ipc.handle('promo:stop-native-capture', async () => {
      try {
        if (!activeNativeCaptureSession) {
          throw new Error('No active native capture session to stop');
        }
        const session = await activeNativeCaptureSession.stop();
        activeNativeCaptureSession = null;
        return { ok: true, session };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 12f. Integrate Cartoon Studio with Story / Animations
    ipc.handle('promo:integrate-cartoon-story', async (_event, { storyManifest, characterSheet, fps = 30, aspect = '16:9' } = {}) => {
      try {
        const core = await getCore();
        const result = core.integrateCartoonWithStory(storyManifest, { characterSheet, fps, aspect });
        return { ok: true, result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 13. Build Screen Studio EDG from telemetry session (Smart Auto-Zoom + Studio Canvas)
    ipc.handle('promo:build-screen-studio-edg', async (_event, { session, canvasConfig, aspect = '16:9', fps = 30 } = {}) => {
      try {
        const core = await getCore();
        if (!session || !Array.isArray(session.telemetry)) {
          throw new Error('A screen session with telemetry is required to build the EDG');
        }
        const zoomKeyframes = core.computeAutoZoomKeyframes(session.telemetry, {
          screenWidth: session.screenWidth,
          screenHeight: session.screenHeight,
        });
        const resolvedCanvas = core.createStudioCanvasConfig(canvasConfig || {});
        const edg = core.createScreenStudioEdgTimeline(session, zoomKeyframes, resolvedCanvas, { aspect, fps });
        return { ok: true, edg, zoomKeyframes };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 14. Render Screen Studio Video Export (routed through JobStore and Governor)
    ipc.handle('promo:render-screen-studio-export', async (_event, { edg, outputPath, fps = 30, width = 1280, height = 720, isPreview = false, jobId: requestedJobId = null } = {}) => {
      let jobId = null;
      try {
        const core = await getCore();
        core.validateEdg(edg);
        const targetOutput = resolveSafeOutputPath(outputPath, 'screen-studio');

        const store = new core.JobStore(jobsDir, { governorDir: await governorDirFor(core) });
        const job = store.create({
          id: requestedJobId || _event?.jobId || null,
          type: 'render_screen_studio',
          params: { isPreview },
        });
        jobId = job.id;
        const runningJob = store.setState(job.id, 'running');
        if (!runningJob || runningJob.state !== 'running') {
          return { ok: false, jobId: job.id, error: runningJob?.error || 'Governor admission denied' };
        }

        const controller = new AbortController();
        renderAbortControllers.set(job.id, controller);
        try {
          const result = await core.renderScreenStudioExport(edg, targetOutput, {
            fps,
            width,
            height,
            governor: store.governor,
            jobId: job.id,
            signal: controller.signal,
          });
          const currentJob = store.get(job.id);
          if (currentJob && currentJob.state === 'cancelled') {
            return { ok: false, jobId: job.id, cancelled: true, error: 'Job was cancelled' };
          }
          store.artifact(job.id, { path: targetOutput, kind: 'video' });
          store.checkpoint(job.id, 'artifact', targetOutput);
          store.setState(job.id, 'done');
          return {
            ok: true,
            outputPath: targetOutput,
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
          renderAbortControllers.delete(job.id);
        }
      } catch (err) {
        return { ok: false, jobId, error: err.message };
      }
    });

    // 15. FFmpeg capability report (Phase 3 item 3 / P11). Never downloads or
    // bundles a binary — it reports which FFmpeg the machine already has.
    ipc.handle('promo:ffmpeg-capabilities', async () => {
      try {
        const core = await getCore();
        let ffmpegPath = null;
        try {
          ffmpegPath = core.resolveFfmpegBinary();
        } catch (resolveErr) {
          return {
            ok: false,
            code: 'FFMPEG_MISSING',
            error: resolveErr.message,
            hints: ['brew install ffmpeg', 'VIDMYO_FFMPEG_PATH=/path/to/ffmpeg'],
          };
        }
        const probe = core.tryProbeFfmpegCapabilities({ ffmpegPath });
        return { ok: probe.ok, ...probe };
      } catch (err) {
        return {
          ok: false,
          code: err.code || 'FFMPEG_PROBE_FAILED',
          error: err.message,
          hints: err.hints || [],
        };
      }
    });

    return true;
  }

  return { register, SAMPLE_FIXTURES };
}

let defaultBridge = null;
function register() {
  if (!defaultBridge) defaultBridge = createPromoBridge();
  return defaultBridge.register();
}

module.exports = { createPromoBridge, register, SAMPLE_FIXTURES };
