// Frontend client for local inference — wraps window.localAI (Electron IPC).
// One provider lives behind this surface:
//   - wan2gp: user-run Gradio server, generation is remote HTTP
// The bundled sd.cpp engine and the Bonsai/ComfyUI bridges were removed
// 2026-07-03 (quality bar: Vidmyo image generation targets Google Flow and
// professional APIs; Wan2GP stays for bring-your-own-GPU Flux/Qwen/video).

import { getLocalModelById } from './localModels.js';

export const isLocalAIAvailable = () => typeof window !== 'undefined' && !!window.localAI?.isElectron;

class LocalInferenceClient {
    // ── Wan2GP APIs ───────────────────────────────────────────────────────
    async getWan2gpConfig() {
        if (!isLocalAIAvailable()) return { url: '' };
        return window.localAI.wan2gp.getConfig();
    }
    async setWan2gpUrl(url) {
        if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.');
        return window.localAI.wan2gp.setUrl(url);
    }
    async probeWan2gp(url) {
        if (!isLocalAIAvailable()) return { ok: false, error: 'Not in desktop app' };
        return window.localAI.wan2gp.probe(url);
    }
    // Pushes a File/Blob to the configured Wan2GP server's /upload endpoint
    // and returns { url, path }. URL is a previewable HTTP link; the provider
    // also remembers the path so a subsequent generate(params.image=url) call
    // can rehydrate it as a Gradio file descriptor.
    async uploadFileToWan2gp(file) {
        if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.');
        const buf = await file.arrayBuffer();
        return window.localAI.wan2gp.uploadFile({
            name: file.name,
            type: file.type,
            bytes: new Uint8Array(buf),
        });
    }

    // ── Unified model list ────────────────────────────────────────────────
    async listModels() {
        if (!isLocalAIAvailable()) return [];
        return window.localAI.wan2gp.listModels().catch(() => []);
    }

    // ── Provider-aware generate ───────────────────────────────────────────
    async generate(params) {
        if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.');
        const model = getLocalModelById(params.model);
        if (model?.provider !== 'wan2gp') {
            throw new Error(`Unknown local model "${params.model}" — only Wan2GP models are supported.`);
        }
        return window.localAI.wan2gp.generate(params);
    }

    cancelGeneration() {
        if (!isLocalAIAvailable()) return;
        window.localAI.wan2gp.cancelGeneration();
    }

    /**
     * Subscribe to generation progress events.
     * Wan2GP emits { progress, status }.
     */
    onProgress(callback) {
        if (!isLocalAIAvailable()) return () => {};
        return window.localAI.onProgress(callback);
    }
}

export const localAI = new LocalInferenceClient();
