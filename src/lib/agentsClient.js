// Frontend client for the local AI agent bridge — wraps window.agents (Electron
// IPC). In the browser/hosted build window.agents is absent, so every call
// degrades to a clear "desktop only" result instead of throwing.

export const isAgentBridgeAvailable = () =>
  typeof window !== 'undefined' && !!window.agents?.isElectron;

const DESKTOP_ONLY = { ok: false, error: 'desktop_only' };

export const agentsClient = {
  available: isAgentBridgeAvailable,

  async detect() {
    if (!isAgentBridgeAvailable()) return { ok: false, error: 'desktop_only', agents: [] };
    try {
      return await window.agents.detect();
    } catch (e) {
      return { ok: false, error: String(e?.message || e), agents: [] };
    }
  },

  async authStatus(agentId) {
    if (!isAgentBridgeAvailable()) return DESKTOP_ONLY;
    return window.agents.authStatus(agentId);
  },

  async login(agentId) {
    if (!isAgentBridgeAvailable()) return DESKTOP_ONLY;
    return window.agents.login(agentId);
  },

  async launch(agentId, cwd) {
    if (!isAgentBridgeAvailable()) return DESKTOP_ONLY;
    return window.agents.launch(agentId, cwd);
  },

  async setupMediaSkills(opts) {
    if (!isAgentBridgeAvailable()) return DESKTOP_ONLY;
    return window.agents.setupMediaSkills(opts || {});
  },

  async openExternal(url) {
    if (!isAgentBridgeAvailable()) {
      if (typeof window !== 'undefined') window.open(url, '_blank');
      return { ok: true };
    }
    return window.agents.openExternal(url);
  },
};
