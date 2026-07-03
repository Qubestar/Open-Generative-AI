// Main-process fetch proxy.
//
// Lets the renderer keep webSecurity/CORS enabled: all cloud provider
// requests are forwarded here over one narrow IPC channel and executed with
// Node's fetch, which is not subject to browser CORS. The renderer wrapper is
// src/lib/apiFetch.js. http:// is only allowed for private/loopback hosts
// (local engines like Wan2GP or Video Delta); everything else must be https.

const { ipcMain } = require('electron');

function isPrivateHost(hostname) {
    return (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '0.0.0.0' ||
        hostname.startsWith('192.168.') ||
        hostname.startsWith('10.') ||
        hostname.endsWith('.local')
    );
}

function isAllowed(rawUrl) {
    let u;
    try {
        u = new URL(rawUrl);
    } catch {
        return false;
    }
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:') return isPrivateHost(u.hostname);
    return false;
}

function register() {
    ipcMain.handle('net:fetch', async (_evt, req) => {
        const { url, method = 'GET', headers = {}, body = null } = req || {};
        if (!isAllowed(url)) {
            return {
                ok: false, status: 0, statusText: 'blocked', headers: {}, body: null,
                error: `URL not allowed: ${String(url).slice(0, 120)}`,
            };
        }
        try {
            const res = await fetch(url, {
                method,
                headers,
                ...(body != null
                    ? { body: typeof body === 'string' ? body : Buffer.from(body) }
                    : {}),
            });
            const bytes = new Uint8Array(await res.arrayBuffer());
            const outHeaders = {};
            res.headers.forEach((v, k) => { outHeaders[k] = v; });
            return { ok: res.ok, status: res.status, statusText: res.statusText, headers: outHeaders, body: bytes };
        } catch (err) {
            return {
                ok: false, status: 0, statusText: 'network_error', headers: {}, body: null,
                error: String((err && err.message) || err),
            };
        }
    });
}

module.exports = { register };
