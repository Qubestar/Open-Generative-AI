import { useState, useEffect, useCallback } from 'react';
import './LocalAgentsStudio.css';

// Agents — the MCP connection center. Detects coding agents installed on this
// machine (window.agents → electron/lib/agents.js), connects them to Vidmyo's
// MCP server (Video Delta + Story + Clipper + Cleaner tools), and launches
// them at the project. This replaced the old muapi-era cloud AgentStudio.

const C = {
  card: 'var(--vm-panel)', line: 'var(--vm-line)', text: 'var(--vm-text)', dim: 'var(--vm-muted)',
  accent: 'var(--vm-accent)', accent2: 'var(--vm-accent)', good: 'var(--vm-good)', bad: 'var(--vm-danger)',
};
const card = { background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16 };
const btn = (primary = false, disabled = false) => ({
  padding: '7px 14px', borderRadius: 9, fontSize: 12, fontWeight: 700,
  cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1,
  background: primary ? 'var(--vm-primary)' : 'var(--vm-raised)',
  color: primary ? 'var(--vm-on-primary)' : C.text, border: primary ? 'none' : `1px solid ${C.line}`,
});

const MCP_TOOL_HINT = 'Story creation · Clipper analysis · Cleaner transcript review and export · provider-backed Image and Video generation';

export default function LocalAgentsStudio() {
  const hasBridge = typeof window !== 'undefined' && !!window.agents?.isElectron;
  const [agents, setAgents] = useState(null);   // null = loading
  const [busyId, setBusyId] = useState(null);
  const [results, setResults] = useState({});   // agentId -> {ok, output/error/command/hint}
  const [detectError, setDetectError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    if (!hasBridge) return;
    setRefreshing(true);
    setDetectError('');
    try {
      const res = await window.agents.detect();
      if (!res?.ok) throw new Error(res?.error || 'Could not detect installed agents.');
      setAgents(res.agents || []);
    } catch (error) { setDetectError(error.message); setAgents(prev => prev || []); }
    finally { setRefreshing(false); }
  }, [hasBridge]);
  useEffect(() => { refresh(); }, [refresh]);

  if (!hasBridge) {
    return (
      <div style={{ maxWidth: 560, margin: '80px auto', textAlign: 'center', color: C.dim }}>
        <h2 style={{ color: C.text, fontSize: 22, fontWeight: 900, marginBottom: 10 }}>Agents</h2>
        <p style={{ fontSize: 13, lineHeight: 1.6 }}>
          Agent detection and MCP connection run inside the Vidmyo desktop window.
          Open the Vidmyo desktop app to connect your installed agents.
        </p>
      </div>
    );
  }

  const connect = async (agent, serverId = 'vidmyo') => {
    setBusyId(`${agent.id}:${serverId}`);
    try {
      const res = await window.agents.installMcp(agent.id, serverId);
      setResults((r) => ({ ...r, [agent.id]: { ...res, serverId } }));
    } catch (error) { setResults(r => ({ ...r, [agent.id]: { ok: false, error: error.message } })); }
    finally { setBusyId(null); }
  };

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div className="agents-workspace">
        <div className="agents-heading">
          <div>
          <h2 style={{ color: C.text, fontSize: 26, fontWeight: 650 }}>Agents</h2>
          <div style={{ color: C.dim, fontSize: 12, marginTop: 4, lineHeight: 1.6 }}>
            Connect an installed agent to Vidmyo’s local tools, then open it with your project context.
          </div>
          </div>
          <button style={btn()} onClick={refresh} disabled={refreshing || !!busyId}>{refreshing ? 'Checking…' : 'Refresh agents'}</button>
        </div>

        <div style={card}>
          <div style={{ color: C.accent2, fontSize: 11, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 }}>
            MCP servers you can connect
          </div>
          <div style={{ color: C.dim, fontSize: 12, lineHeight: 1.6 }}>
            <b style={{ color: C.text }}>Vidmyo</b> local tools: {MCP_TOOL_HINT}. Production rules
            (scene IDs, on-disk artifact checks, script length gate) baked in.
          </div>
          <p style={{ color: C.dim, fontSize: 12, lineHeight: 1.6, marginTop: 8 }}>Connecting registers local tools; it does not purchase credits or confirm subscription access. Signed-in status is separate from the agent’s current allowance. Image and video APIs use separate provider billing.</p>
        </div>

        {detectError && <div role="alert" style={{ color: C.bad }}>{detectError} Use Refresh agents to retry.</div>}
        {agents?.length === 0 && !detectError && <p style={{ color: C.dim }}>No agents were detected. Install and sign in to your preferred agent, then refresh.</p>}
        <div className="agents-grid">

        {agents === null && <div style={{ color: C.dim, fontSize: 12 }}>Detecting installed agents…</div>}

        {agents?.map((a) => {
          const res = results[a.id];
          return (
            <div key={a.id} style={card}>
              <div className="agent-card-header">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ color: C.text, fontSize: 14, fontWeight: 800 }}>{a.name}</span>
                  <span style={{ color: C.dim, fontSize: 11, marginLeft: 8 }}>
                    {a.installed ? `installed${a.version ? ` · v${a.version}` : ''}${a.authed ? ' · signed in' : ' · not signed in'}` : 'not installed'}
                  </span>
                </div>
                {!a.installed && (
                  <button style={btn()} onClick={() => window.agents.openExternal(a.id === 'claude_code'
                    ? 'https://docs.anthropic.com/en/docs/agents-and-tools/claude-code'
                    : `https://www.google.com/search?q=${encodeURIComponent(a.name + ' install')}`)}>
                    Install guide ↗
                  </button>
                )}
                {a.installed && !a.authed && (
                  <button style={btn()} onClick={() => window.agents.login(a.id)}>Sign in…</button>
                )}
                {a.installed && (
                  <>
                    <button style={btn(true, busyId === `${a.id}:vidmyo`)} disabled={!!busyId} onClick={() => connect(a, 'vidmyo')}>
                      {busyId === `${a.id}:vidmyo` ? 'Connecting…' : 'Connect Vidmyo MCP'}
                    </button>
                    <button style={btn()}
                            title={a.desktopApp ? `Opens ${a.desktopApp}.app with the current project brief (change mode in Settings)` : 'Opens in Terminal at the project (no desktop app found)'}
                            onClick={async () => {
                              // Launch with the active story project so the new
                              // session starts with real context.
                              try {
                                const projectDir = localStorage.getItem('vidmyo_story_last_dir') || undefined;
                                const r = await window.agents.launch(a.id, projectDir);
                                setResults((prev) => ({ ...prev, [a.id]: r.ok ? { ok: true, notice: r.message } : r }));
                              } catch (error) { setResults(prev => ({ ...prev, [a.id]: { ok: false, error: error.message } })); }
                            }}>
                      Launch{a.desktopApp ? ` ${a.desktopApp}` : ''} ↗
                    </button>
                  </>
                )}
              </div>
              {res && (
                <div role="status" style={{ marginTop: 10, padding: '8px 10px', borderRadius: 8, background: 'var(--vm-raised)', fontSize: 12, lineHeight: 1.6 }}>
                  {res.ok ? (
                    <span style={{ color: C.good }}>{res.notice || `Connected — the “${res.serverId || 'vidmyo'}” MCP server is registered.`}{res.note ? ` ${res.note}` : ''}</span>
                  ) : res.error === 'manual' ? (
                    <>
                      <div style={{ color: C.accent }}>{res.hint}</div>
                      {res.note && <div style={{ color: C.dim, marginTop: 4 }}>{res.note}</div>}
                      <div style={{ marginTop: 6 }}>
                        <button style={btn()} onClick={() => navigator.clipboard.writeText(res.command)}>Copy command</button>
                      </div>
                    </>
                  ) : (
                    <span style={{ color: C.bad }}>{res.error}</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
        </div>
      </div>
    </div>
  );
}
