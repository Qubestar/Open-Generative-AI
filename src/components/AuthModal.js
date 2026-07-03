// MUAPI has been removed from Vidmyo. This shim remains only so any legacy
// call sites keep resolving. Instead of prompting for a MUAPI key, it sends the
// user to Settings → Providers to configure OpenRouter. It intentionally does
// NOT invoke the success callback (avoids retry loops) and renders no modal.
export function AuthModal(_onSuccess) {
    try {
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'settings' } }));
        }
    } catch { /* no-op */ }
    return null;
}
