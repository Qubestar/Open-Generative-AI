// fetch wrapper for cloud provider requests.
//
// Desktop app: requests go through the Electron main process (net:fetch IPC,
// electron/lib/netProxy.js) so the renderer keeps webSecurity enabled and is
// never subject to provider CORS policies. Browser build: plain fetch.
// Returns a Response-like object supporting ok/status/statusText/headers.get/
// json()/text()/arrayBuffer()/blob() — the subset Vidmyo's clients use.

export async function apiFetch(url, options = {}) {
    // Relative URLs (dev-server proxy paths) stay on plain fetch — the IPC
    // proxy only handles absolute cloud/LAN URLs.
    const isAbsolute = /^https?:\/\//i.test(String(url));
    if (typeof window === 'undefined' || !window.localNet?.fetch || !isAbsolute) {
        return fetch(url, options);
    }
    const res = await window.localNet.fetch({
        url: String(url),
        method: options.method || 'GET',
        headers: options.headers || {},
        body: options.body ?? null,
    });
    if (!res.ok && res.status === 0) {
        // Network-level failure — mirror fetch() semantics by throwing.
        throw new TypeError(res.error || 'Network request failed');
    }
    const bytes = res.body || new Uint8Array();
    const text = () => new TextDecoder().decode(bytes);
    return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        headers: { get: (k) => res.headers?.[String(k).toLowerCase()] ?? null },
        json: async () => JSON.parse(text() || 'null'),
        text: async () => text(),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        blob: async () => new Blob([bytes], { type: res.headers?.['content-type'] || 'application/octet-stream' }),
    };
}
