// OS-keychain-backed provider key store.
//
// Uses Electron safeStorage (Keychain on macOS, DPAPI on Windows, libsecret
// on Linux) to encrypt provider API keys at rest. Encrypted blobs live in
// userData/secure-keys.json; plaintext only ever exists in memory. The
// renderer talks to this through the narrow window.secureKeys preload surface
// and migrates its old localStorage keys on first run (src/lib/providers.js).

const { ipcMain, app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

const storeFile = () => path.join(app.getPath('userData'), 'secure-keys.json');

function readStore() {
    try {
        return JSON.parse(fs.readFileSync(storeFile(), 'utf8')) || {};
    } catch {
        return {};
    }
}

function writeStore(store) {
    fs.writeFileSync(storeFile(), JSON.stringify(store, null, 2), { mode: 0o600 });
}

function register() {
    ipcMain.handle('secrets:available', () => safeStorage.isEncryptionAvailable());

    ipcMain.handle('secrets:get-all', () => {
        if (!safeStorage.isEncryptionAvailable()) return { ok: false, keys: {} };
        const store = readStore();
        const keys = {};
        for (const [id, b64] of Object.entries(store)) {
            try {
                keys[id] = safeStorage.decryptString(Buffer.from(b64, 'base64'));
            } catch {
                // Skip entries encrypted under a different OS user/keychain.
            }
        }
        return { ok: true, keys };
    });

    ipcMain.handle('secrets:set', (_evt, id, key) => {
        if (typeof id !== 'string' || !/^[\w.-]{1,64}$/.test(id)) {
            return { ok: false, error: 'invalid provider id' };
        }
        if (!safeStorage.isEncryptionAvailable()) {
            return { ok: false, error: 'OS encryption unavailable' };
        }
        const store = readStore();
        if (key) store[id] = safeStorage.encryptString(String(key)).toString('base64');
        else delete store[id];
        writeStore(store);
        return { ok: true };
    });
}

module.exports = { register };
