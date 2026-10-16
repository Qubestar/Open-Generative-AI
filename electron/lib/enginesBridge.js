// Engines & Models Desktop Bridge for Vidmyo V2.6.
// Status and verification for managed model packages (Kokoro TTS, Whisper ASR).
// Phase 5, Step 4 & 6.

const { ipcMain, app } = require('electron');
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

function createEnginesBridge(deps = {}) {
  const ipc = deps.ipcMain || ipcMain;
  const getCore = deps.core || defaultCore;
  const userDataDir = resolveUserDataDir(deps);
  const packagesDir = deps.packagesDir ? path.resolve(deps.packagesDir) : path.join(userDataDir, 'models');

  fs.mkdirSync(packagesDir, { recursive: true });

  function register() {
    ipc.handle('engines:model-packages-status', async () => {
      try {
        const core = await getCore();
        const manager = deps.modelPackageManager || new core.ModelPackageManager({ packagesDir });
        const catalog = manager.catalog || core.BUILTIN_MODEL_CATALOG;
        const packages = catalog.map((pkg) => {
          const st = manager.status(pkg.name);
          return {
            name: pkg.name,
            status: st.installed ? 'installed' : (st.pending ? 'manifest-pending' : 'not-installed'),
            installed: st.installed,
            pending: st.pending,
            installable: st.installable,
            verified: st.verified,
            verifyReason: st.verifyReason,
            notes: pkg.notes,
            version: st.receipt?.version || pkg.version || null,
            license: st.receipt?.license || pkg.license || null,
            receipt: st.receipt,
          };
        });
        return { ok: true, packages };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    ipc.handle('engines:model-package-verify', async (_, options = {}) => {
      try {
        const { name } = options;
        if (!name) return { ok: false, error: 'Package name is required' };
        const core = await getCore();
        const manager = deps.modelPackageManager || new core.ModelPackageManager({ packagesDir });
        const result = manager.verify(name);
        return { ok: true, result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // HyperFrames pin status (read-only). Fail-closed: a missing or mismatched
    // package reports exactly why, and the renderer must not impersonate it.
    ipc.handle('engines:hyperframes-status', async () => {
      try {
        const core = await getCore();
        const pinned = core.HYPERFRAMES_PINNED;
        const license = core.HYPERFRAMES_LICENSE;
        try {
          const resolved = core.resolveHyperframesPackage();
          return {
            ok: true,
            pinned,
            license: resolved.license || license,
            installed: true,
            installedVersion: resolved.version,
            matchesPin: resolved.version === pinned,
            reason: null,
          };
        } catch (err) {
          return {
            ok: true,
            pinned,
            license,
            installed: false,
            installedVersion: null,
            matchesPin: false,
            reason: err.message,
          };
        }
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });
  }

  return {
    register,
    packagesDir,
  };
}

let defaultBridge = null;
function register() {
  if (!defaultBridge) {
    defaultBridge = createEnginesBridge();
  }
  return defaultBridge.register();
}

module.exports = {
  createEnginesBridge,
  register,
};
