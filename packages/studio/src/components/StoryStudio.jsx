import { useState, useEffect, useCallback } from 'react';

// Story Studio — the flagship faceless-doodle workflow, rendered in the
// Next.js dev shell that Luke's launcher opens inside Electron. All pipeline
// state lives in project.json on disk; this component only talks to
// @vidmyo/core in the Electron main process via window.story
// (electron/lib/storyBridge.js). In a plain browser tab window.story is
// undefined and we show the desktop-only notice.

const C = {
  bg: '#0B0B0D', card: '#16161A', line: '#26262C', text: '#F5F1E8', dim: '#9A9AA2',
  accent: '#E8A33D', accent2: '#7c3aed', good: '#3ECF8E', bad: '#ff6b6b',
};

const LAST_DIR_KEY = 'vidmyo_story_last_dir';

const STAGES = [
  ['script', 'Script'],
  ['voiceover', 'Voiceover (Kokoro, local)'],
  ['beats', 'Beats & scenes'],
  ['prompts', 'Image prompts'],
  ['images', 'Scene images'],
  ['assemble', 'Assemble'],
  ['finalize', 'Finalize (4K + −14 LUFS)'],
];

const card = { background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16 };
const btn = (primary = false, disabled = false) => ({
  padding: '7px 14px', borderRadius: 9, fontSize: 12, fontWeight: 700, cursor: disabled ? 'default' : 'pointer',
  background: primary ? C.accent : 'rgba(255,255,255,0.06)',
  color: primary ? '#111' : C.text,
  border: primary ? 'none' : `1px solid ${C.line}`,
  opacity: disabled ? 0.45 : 1,
});
const smallBtn = { padding: '4px 9px', borderRadius: 7, fontSize: 11, fontWeight: 700, cursor: 'pointer', background: 'rgba(255,255,255,0.06)', color: C.text, border: `1px solid ${C.line}` };

export default function StoryStudio() {
  const hasBridge = typeof window !== 'undefined' && !!window.story?.isElectron;
  const [dir, setDir] = useState(null);
  const [data, setData] = useState(null);           // last story:get summary
  const [readiness, setReadiness] = useState(null);
  const [busy, setBusy] = useState(null);           // stage id while running
  const [log, setLog] = useState([]);
  const [topic, setTopic] = useState('');
  const [scriptDraft, setScriptDraft] = useState('');

  const apply = useCallback((res) => {
    if (res?.ok) {
      setDir(res.dir);
      setData(res);
      setScriptDraft(res.manifest.script || '');
      localStorage.setItem(LAST_DIR_KEY, res.dir);
    } else if (res && res.error !== 'cancelled') {
      alert(res.error);
    }
  }, []);

  useEffect(() => {
    if (!hasBridge) return;
    const unsub = window.story.onProgress((p) => setLog((l) => [...l.slice(-6), p]));
    window.story.readiness().then(setReadiness);
    const last = localStorage.getItem(LAST_DIR_KEY);
    if (last) window.story.get(last).then((res) => { if (res.ok) apply(res); });
    return unsub;
  }, [hasBridge, apply]);

  const createProject = async () => {
    const picked = await window.story.pickDir();
    if (picked.ok && picked.dir) apply(await window.story.create({ dir: picked.dir, brief: { topic: topic.trim() || 'untitled' } }));
  };
  const openProject = async () => {
    const picked = await window.story.pickDir();
    if (picked.ok && picked.dir) apply(await window.story.get(picked.dir));
  };
  const runStage = async (stage, opts = {}) => {
    // Pipeline stages spawn the local Python scripts — refuse with a pointer
    // to the banner instead of failing with a raw spawn ENOENT.
    if (readiness?.missing?.length > 0 && stage !== 'finalize') {
      alert('The pipeline environment isn’t ready yet — use the yellow banner above: “Install pipeline environment…” or “Use existing venv…”.');
      return;
    }
    setBusy(stage);
    const res = await window.story.runStage(dir, stage, opts);
    setBusy(null);
    apply(res);
  };
  const saveScript = async () => apply(await window.story.setScript(dir, scriptDraft));

  if (!hasBridge) {
    return (
      <div style={{ maxWidth: 560, margin: '80px auto', textAlign: 'center', color: C.dim }}>
        <h2 style={{ color: C.text, fontSize: 22, fontWeight: 900, marginBottom: 10 }}>Story Studio</h2>
        <p style={{ fontSize: 13, lineHeight: 1.6 }}>
          Story Studio runs the local pipeline (Kokoro TTS, whisper beat detection, ffmpeg) and is
          available inside the Vidmyo desktop window. Launch it with the usual
          “Start Vidmyo + Video Delta” launcher — if you opened this page in a plain browser tab,
          the pipeline bridge isn’t there.
        </p>
      </div>
    );
  }

  const readinessBanner = readiness && readiness.missing?.length > 0 && (
    <div style={{ ...card, borderColor: 'rgba(232,163,61,0.5)', background: 'rgba(232,163,61,0.08)' }}>
      <div style={{ color: C.accent, fontSize: 12, fontWeight: 800, marginBottom: 6 }}>Pipeline not ready</div>
      <ul style={{ color: C.dim, fontSize: 11, paddingLeft: 18, marginBottom: 10 }}>
        {readiness.missing.map((m) => <li key={m}>{m}</li>)}
      </ul>
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={btn()} onClick={async () => {
          if (!confirm('This builds a Python environment and downloads Kokoro + whisper models (several hundred MB, one time). Continue?')) return;
          setBusy('setup-env');
          const res = await window.story.setupEnv();
          setBusy(null);
          if (!res.ok) alert(res.error);
          setReadiness(await window.story.readiness());
        }}>Install pipeline environment…</button>
        <button style={btn()} onClick={async () => {
          const p = prompt('Path to an existing venv python (…/.venv/bin/python):', readiness.venvPython || '');
          if (!p) return;
          const res = await window.story.setVenv(p);
          if (!res.ok) alert(res.error);
          setReadiness(res.ok ? res : await window.story.readiness());
        }}>Use existing venv…</button>
      </div>
    </div>
  );

  if (!data) {
    return (
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '60px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ textAlign: 'center' }}>
          <h2 style={{ color: C.text, fontSize: 24, fontWeight: 900 }}>Story Studio</h2>
          <p style={{ color: C.dim, fontSize: 13, lineHeight: 1.6, marginTop: 8 }}>
            Create a complete faceless doodle video: script → voiceover → beat-cut scenes → images →
            assembled MP4. Everything lives in a project folder you can resume anytime.
          </p>
        </div>
        <input
          value={topic} onChange={(e) => setTopic(e.target.value)}
          placeholder="Topic, e.g. Why you wake up at 2am"
          style={{ background: 'rgba(255,255,255,0.05)', border: `1px solid ${C.line}`, borderRadius: 11, padding: '11px 14px', fontSize: 13, color: C.text, outline: 'none' }}
        />
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button style={btn(true)} onClick={createProject}>Create project…</button>
          <button style={btn()} onClick={openProject}>Open existing…</button>
        </div>
        {readinessBanner}
      </div>
    );
  }

  const m = data.manifest;
  const status = data.status;
  const check = data.scriptCheck;
  const finalized = m.renders?.find((r) => r.finalized);

  // Short scripts fail the 1,400-word retention gate — offer the override
  // in plain language instead of surfacing the internal force flag.
  const generateVoiceover = () => {
    if (check && !check.ok) {
      const goAhead = confirm(
        `The script is ${check.words} words, under the ${check.minWords}-word target — the finished video will run well short of 5 minutes (fine for a test, weak for the channel).\n\nGenerate the voiceover anyway?`
      );
      if (!goAhead) return;
      runStage('voiceover', { force: true });
      return;
    }
    runStage('voiceover');
  };

  const stageActions = {
    voiceover: status.script && !status.voiceover && [[
      check && !check.ok ? 'Generate anyway (short script)' : 'Generate voiceover',
      generateVoiceover,
      true,
    ]],
    beats: status.voiceover && !status.beats && [['Detect beats', () => runStage('beats'), true]],
    assemble: status.beats && !status.finalize && [
      ['Preview (white frames)', () => runStage('assemble', { allowMissing: true }), false],
      ...(status.images ? [['Assemble', () => runStage('assemble'), true]] : []),
    ],
    finalize: status.assemble && status.images && !status.finalize && [['Finalize', () => runStage('finalize'), true]],
  };

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '24px 20px 60px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ color: C.text, fontSize: 20, fontWeight: 900 }}>{m.brief?.topic || 'Story project'}</h2>
          <div style={{ color: C.dim, fontSize: 11, marginTop: 2 }}>{dir} · {m.style} · {m.aspect}</div>
        </div>
        <button style={btn()} onClick={openProject}>Switch project…</button>
      </div>

      {readinessBanner}

      {log.length > 0 && (
        <div style={{ ...card, padding: '10px 14px' }}>
          {log.slice(-4).map((p, i) => (
            <div key={i} style={{ fontSize: 11, color: p.phase === 'error' ? C.bad : C.dim }}>
              {p.stage}: {p.phase}{p.message ? ` — ${p.message}` : ''}
            </div>
          ))}
        </div>
      )}

      {/* Stage checklist */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {STAGES.map(([stage, label]) => {
          const done = status[stage];
          const isNext = status.nextStage === stage;
          const actions = stageActions[stage] || [];
          return (
            <div key={stage} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '10px 14px', borderRadius: 11,
              background: isNext ? 'rgba(232,163,61,0.08)' : 'rgba(255,255,255,0.03)',
              border: `1px solid ${isNext ? 'rgba(232,163,61,0.4)' : C.line}`,
            }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span style={{ color: done ? C.good : 'rgba(255,255,255,0.25)' }}>{done ? '✓' : '○'}</span>
                <span style={{ color: done ? C.text : C.dim, fontSize: 13, fontWeight: 700 }}>{label}</span>
                {isNext && <span style={{ color: C.accent, fontSize: 9, fontWeight: 900, letterSpacing: 1.5 }}>NEXT</span>}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {actions && actions.map(([lab, fn, primary]) => (
                  <button key={lab} style={btn(primary, !!busy)} disabled={!!busy} onClick={fn}>
                    {busy ? 'Working…' : lab}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Script editor */}
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ color: C.dim, fontSize: 11, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase' }}>Script</span>
          {check && (
            <span style={{ fontSize: 11, color: check.ok ? C.good : C.accent }}>
              {check.words} words {check.ok ? '— ready' : `(need ≥ ${check.minWords} for a 5:00+ video)`}
            </span>
          )}
        </div>
        <textarea
          rows={9} value={scriptDraft} onChange={(e) => setScriptDraft(e.target.value)}
          placeholder="Paste or write the narration script. Ask your agent to draft one with packages/core/pipelines/doodle/references/master-prompt.txt."
          style={{ width: '100%', background: 'rgba(0,0,0,0.3)', border: `1px solid ${C.line}`, borderRadius: 11, padding: 12, fontSize: 12.5, lineHeight: 1.6, color: C.text, outline: 'none', fontFamily: 'ui-monospace, monospace', resize: 'vertical' }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
          <button style={btn()} onClick={saveScript}>Save script</button>
        </div>
      </div>

      {/* Scenes */}
      {m.scenes?.length > 0 && (
        <div style={card}>
          <div style={{ color: C.dim, fontSize: 11, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 }}>
            Scenes ({m.scenes.length}) — attach and approve each image
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {m.scenes.map((s) => {
              const state = s.image.approved ? '✓ approved' : (s.image.artifact ? 'needs approval' : 'no image');
              const color = s.image.approved ? C.good : (s.image.artifact ? C.accent : 'rgba(255,255,255,0.3)');
              return (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 9, background: 'rgba(0,0,0,0.25)' }}>
                  <span style={{ color: C.accent2, fontSize: 11, fontWeight: 900, width: 36 }}>{s.id}</span>
                  <span title={s.prompt || ''} style={{ color: C.dim, fontSize: 12, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {s.beat || '(no beat text)'}
                  </span>
                  <span style={{ color, fontSize: 10, fontWeight: 800, width: 92, textAlign: 'right' }}>{state}</span>
                  <button style={smallBtn} title="Copy the image prompt (paste into Google Flow — the free path)"
                          onClick={() => navigator.clipboard.writeText(s.prompt || '')}>Prompt</button>
                  <button style={smallBtn} onClick={async () => apply(await window.story.attachImage(dir, s.id))}>Attach…</button>
                  {!s.image.artifact && (
                    <button style={smallBtn} title="Generate with your fal.ai key — paid per image"
                            disabled={!!busy}
                            onClick={async () => {
                              setBusy(`image:${s.id}`);
                              apply(await window.story.generateScene(dir, s.id));
                              setBusy(null);
                            }}>
                      {busy === `image:${s.id}` ? '…' : 'fal ⚡'}
                    </button>
                  )}
                  {s.image.artifact && !s.image.approved && (
                    <button style={{ ...smallBtn, background: C.accent, color: '#111', border: 'none' }}
                            onClick={async () => apply(await window.story.approveScene(dir, s.id))}>Approve</button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {finalized && (
        <div style={{ ...card, borderColor: 'rgba(62,207,142,0.4)', background: 'rgba(62,207,142,0.07)' }}>
          <span style={{ color: C.good, fontSize: 13, fontWeight: 800 }}>Final video ready: </span>
          <span style={{ color: C.text, fontSize: 12, fontFamily: 'ui-monospace, monospace' }}>{finalized.finalPath}</span>
        </div>
      )}
    </div>
  );
}
