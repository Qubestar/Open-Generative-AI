import { useState, useEffect, useCallback } from 'react';

// Agents — the MCP connection center. Detects coding agents installed on this
// machine (window.agents → electron/lib/agents.js), connects them to Vidmyo's
// MCP server (15 tools: Video Delta + the full Story pipeline), and launches
// them at the project. This replaced the old muapi-era cloud AgentStudio.

const C = {
  card: '#16161A', line: '#26262C', text: '#F5F1E8', dim: '#9A9AA2',
  accent: '#E8A33D', accent2: '#7c3aed', good: '#3ECF8E', bad: '#ff6b6b',
};
const card = { background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16 };
const btn = (primary = false, disabled = false) => ({
  padding: '7px 14px', borderRadius: 9, fontSize: 12, fontWeight: 700,
  cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1,
  background: primary ? C.accent : 'rgba(255,255,255,0.06)',
  color: primary ? '#111' : C.text, border: primary ? 'none' : `1px solid ${C.line}`,
});

const MCP_TOOL_HINT = 'story_sheet_rows · story_create · story_set_script · story_run_stage · story_accept_artifact · story_approve_scene · story_open + the Video Delta film tools';

export default function LocalAgentsStudio() {
  const hasBridge = typeof window !== 'undefined' && !!window.agents?.isElectron;
  const [agents, setAgents] = useState(null);   // null = loading
  const [busyId, setBusyId] = useState(null);
  const [results, setResults] = useState({});   // agentId -> {ok, output/error/command/hint}

  const refresh = useCallback(async () => {
    if (!hasBridge) return;
    const res = await window.agents.detect();
    setAgents(res.ok ? res.agents : []);
  }, [hasBridge]);
  useEffect(() => { refresh(); }, [refresh]);

  if (!hasBridge) {
    return (
      <div style={{ maxWidth: 560, margin: '80px auto', textAlign: 'center', color: C.dim }}>
        <h2 style={{ color: C.text, fontSize: 22, fontWeight: 900, marginBottom: 10 }}>Agents</h2>
        <p style={{ fontSize: 13, lineHeight: 1.6 }}>
          Agent detection and MCP connection run inside the Vidmyo desktop window.
          Launch with “Start Vidmyo + Video Delta”.
        </p>
      </div>
    );
  }

  const connect = async (agent, serverId = 'vidmyo') => {
    setBusyId(`${agent.id}:${serverId}`);
    const res = await window.agents.installMcp(agent.id, serverId);
    setBusyId(null);
    setResults((r) => ({ ...r, [agent.id]: { ...res, serverId } }));
  };

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '24px 20px 60px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <h2 style={{ color: C.text, fontSize: 20, fontWeight: 900 }}>Agents</h2>
          <div style={{ color: C.dim, fontSize: 12, marginTop: 4, lineHeight: 1.6 }}>
            Connect your coding agents to Vidmyo over MCP — then a single request like
            {' '}<i>“make the next Planned video from the tracker”</i> runs the whole Story pipeline.
          </div>
        </div>

        <div style={{ ...card, borderColor: 'rgba(124,58,237,0.35)' }}>
          <div style={{ color: C.accent2, fontSize: 11, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 }}>
            MCP servers you can connect
          </div>
          <div style={{ color: C.dim, fontSize: 12, lineHeight: 1.6 }}>
            <b style={{ color: C.text }}>Vidmyo</b> — 15 local tools: {MCP_TOOL_HINT}. Production rules
            (scene IDs, on-disk artifact checks, script length gate) baked in.
          </div>
        </div>

        {agents === null && <div style={{ color: C.dim, fontSize: 12 }}>Detecting installed agents…</div>}

        {agents?.map((a) => {
          const res = results[a.id];
          return (
            <div key={a.id} style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
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
                              const projectDir = localStorage.getItem('vidmyo_story_last_dir')
                                || '/Volumes/My Lexar/AI Projects/Vidmyo';
                              const r = await window.agents.launch(a.id, projectDir);
                              setResults((prev) => ({ ...prev, [a.id]: r.ok ? { ok: true, notice: r.message } : r }));
                            }}>
                      Launch{a.desktopApp ? ` ${a.desktopApp}` : ''} ↗
                    </button>
                  </>
                )}
              </div>
              {res && (
                <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 8, background: 'rgba(0,0,0,0.3)', fontSize: 11, lineHeight: 1.6 }}>
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
  );
}
