// Optional desktop subscription runtime. When release configuration is
// present it refreshes silently once per day; missing configuration leaves the
// local development/open-core build readable and reports `not-configured`.
const { app, ipcMain, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createEntitlementService } = require('./entitlementService');

let service = null;
let registered = false;

function storeFile(application) { return path.join(application.getPath('userData'), 'entitlement-secure.json'); }

function secureStore(application, storage) {
  const file = storeFile(application);
  const readAll = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; } };
  const writeAll = value => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temporary, file);
  };
  return {
    async get(key) {
      if (!storage.isEncryptionAvailable()) return null;
      const blob = readAll()[key];
      try { return blob ? storage.decryptString(Buffer.from(blob, 'base64')) : null; } catch { return null; }
    },
    async set(key, value) {
      if (!storage.isEncryptionAvailable()) throw new Error('Secure operating-system storage is unavailable.');
      const values = readAll(); values[key] = storage.encryptString(String(value)).toString('base64'); writeAll(values);
    },
    async delete(key) { const values = readAll(); delete values[key]; writeAll(values); },
  };
}

function publicKey(application) {
  const candidates = [
    process.env.VIDMYO_ENTITLEMENT_PUBLIC_KEY_FILE,
    process.resourcesPath ? path.join(process.resourcesPath, 'vidmyo-entitlement-public.pem') : null,
    application.getAppPath?.() ? path.join(application.getAppPath(), 'resources', 'vidmyo-entitlement-public.pem') : null,
  ].filter(Boolean);
  for (const candidate of candidates) try { return fs.readFileSync(candidate, 'utf8'); } catch { /* try next */ }
  return null;
}

function bundledServiceUrl(application) {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'vidmyo-service.json') : null,
    application.getAppPath?.() ? path.join(application.getAppPath(), 'resources', 'vidmyo-service.json') : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { const value = JSON.parse(fs.readFileSync(candidate, 'utf8')); if (typeof value.url === 'string') return value.url; } catch { /* try next */ }
  }
  return null;
}

function register(deps = {}) {
  if (registered) return false;
  registered = true;
  const application = deps.app || app;
  const ipc = deps.ipcMain || ipcMain;
  const storage = deps.safeStorage || safeStorage;
  const serviceUrl = deps.serviceUrl || process.env.VIDMYO_SERVICE_URL || bundledServiceUrl(application);
  const key = deps.publicKey || publicKey(application);
  if (serviceUrl && key && storage?.isEncryptionAvailable?.()) {
    service = createEntitlementService({
      serviceUrl, publicKey: key, secureStore: deps.secureStore || secureStore(application, storage),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    service.start();
  }
  ipc.handle('entitlement:status', async () => service ? service.current() : ({ ok: false, code: 'not_configured', localProjectsReadable: true }));
  ipc.handle('entitlement:refresh', async () => service ? service.refresh() : ({ ok: false, code: 'not_configured', localProjectsReadable: true }));
  return true;
}

function stop() { service?.stop(); service = null; }
function getService() { return service; }

module.exports = { register, stop, getService };
