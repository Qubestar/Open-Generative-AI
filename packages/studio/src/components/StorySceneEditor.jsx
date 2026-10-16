import { useRef, useState } from 'react';
import { resolveSelectedScene, sceneDuration, sceneState } from '../storySceneModel.mjs';
import './StorySceneEditor.css';

export default function StorySceneEditor({ scenes, thumbs, aspect, imageSource, busy, onAttach, onApprove, onGenerate, onZoom }) {
  const [selectedId, setSelectedId] = useState(null);
  const [notice, setNotice] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const actionLock = useRef(false);
  busy = busy || actionBusy;
  const runAction = async action => {
    if (busy || actionLock.current) return;
    actionLock.current = true; setActionBusy(true); setNotice('');
    try { await action(); }
    catch (error) { setNotice(error.message || 'Could not update this scene. Try again.'); }
    finally { actionLock.current = false; setActionBusy(false); }
  };
  const scene = resolveSelectedScene(scenes, selectedId);
  if (!scene) return null;
  const index = scenes.findIndex(item => item.id === scene.id);
  const duration = sceneDuration(scene);
  const copyPrompt = async () => {
    try { await navigator.clipboard.writeText(scene.prompt || ''); setNotice('Prompt copied.'); }
    catch { setNotice('Copy unavailable. Select the prompt text below and copy it.'); }
  };
  const select = id => { setSelectedId(id); setNotice(''); };
  const thumbnail = item => thumbs[item.id]
    ? <img src={thumbs[item.id]} alt="" /> : <span className="story-image-placeholder" aria-hidden="true">▧</span>;

  return <section className="story-scene-workbench" aria-label="Scene editor">
    <aside className="story-outline">
      <header><h3>Story outline</h3><span>{scenes.length} scenes</span></header>
      <div className="story-outline-list">
        {scenes.map((item, position) => <button key={item.id} type="button" aria-pressed={item.id === scene.id}
          onClick={() => select(item.id)} className="story-outline-item">
          {thumbnail(item)}
          <span><b>{String(position + 1).padStart(2, '0')} · {item.beat || item.id}</b>
            <small>{item.id}{sceneDuration(item) != null ? ` · ${sceneDuration(item).toFixed(1)}s` : ''}</small>
            <em data-approved={Boolean(item.image?.approved)}>{sceneState(item)}</em></span>
        </button>)}
      </div>
    </aside>

    <div className="story-scene-stage">
      <header className="story-scene-toolbar">
        <div><b>Scene {String(index + 1).padStart(2, '0')}</b><span>{scene.id} · {aspect || '16:9'}{duration != null ? ` · ${duration.toFixed(1)}s` : ''}</span></div>
        <div className="story-scene-navigation">
          <button type="button" aria-label="Previous scene" disabled={index === 0} onClick={() => select(scenes[index - 1].id)}>←</button>
          <button type="button" aria-label="Next scene" disabled={index === scenes.length - 1} onClick={() => select(scenes[index + 1].id)}>→</button>
        </div>
      </header>
      <div className="story-scene-monitor">
        {thumbs[scene.id] ? <button type="button" onClick={() => onZoom(thumbs[scene.id])} aria-label={`Enlarge ${scene.id} image`}>
          <img src={thumbs[scene.id]} alt={`Scene ${scene.id}: ${scene.beat || 'generated image'}`} />
        </button> : <div className="story-scene-empty"><span aria-hidden="true">▧</span><h3>This scene needs an image</h3>
          <p>Copy its prompt into your image tool, then attach the result. Review it before approval.</p>
          <button type="button" disabled={busy} onClick={() => runAction(() => onAttach(scene.id))}>Attach image</button></div>}
      </div>
      <div className="story-narration"><small>Narration</small><p>{scene.beat || 'No narration text for this scene yet.'}</p></div>
    </div>

    <aside className="story-scene-inspector">
      <header><h3>Scene direction</h3><span>{sceneState(scene)}</span></header>
      <label htmlFor="story-scene-prompt">Image prompt</label>
      <textarea id="story-scene-prompt" value={scene.prompt || ''} readOnly rows={9} placeholder="Run Image prompts to prepare this scene." />
      <button type="button" disabled={!scene.prompt} onClick={copyPrompt}>Copy prompt</button>
      <div className="story-source-note"><small>Image source</small><b>{imageSource?.name || 'Loading settings…'}</b>
        <p>{imageSource?.manual ? 'Generate in your image tool and attach the finished image here.' : 'Provider generation uses your separate API credits. Choose the source in Settings → Story.'}</p></div>
      <div className="story-scene-actions">
        <button type="button" disabled={busy} onClick={() => runAction(() => onAttach(scene.id))}>{scene.image?.artifact ? 'Replace image…' : 'Attach image…'}</button>
        {!scene.image?.artifact && imageSource && !imageSource.manual && <button type="button" disabled={busy || !scene.prompt} onClick={() => runAction(() => onGenerate(scene.id))}>Generate with {imageSource.name}</button>}
        {scene.image?.artifact && !scene.image.approved && <button type="button" className="story-approve" disabled={busy} onClick={() => runAction(() => onApprove(scene.id))}>Approve this image</button>}
        {scene.image?.approved && <p className="story-approved">✓ Approved for assembly</p>}
      </div>
      {notice && <p role="status" className="story-copy-notice">{notice}</p>}
      <p className="story-inspector-hint">Image approval stays manual. Changing scenes never starts a generation or render.</p>
    </aside>

    <nav className="story-filmstrip" aria-label="Scene sequence">
      {scenes.map((item, position) => <button type="button" key={item.id} aria-pressed={item.id === scene.id} onClick={() => select(item.id)}>
        {thumbnail(item)}<b>{String(position + 1).padStart(2, '0')} · {item.id}</b><small>{sceneState(item)}</small>
      </button>)}
    </nav>
  </section>;
}
