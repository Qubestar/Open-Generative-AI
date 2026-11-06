import { useEffect, useMemo, useRef, useState } from 'react';
import { ANIMATION_STYLES } from '../../../core/src/animationCatalog.js';
import './AnimationGallery.css';

export default function AnimationGallery({ value, onChange, renderClassic }) {
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  const [category, setCategory] = useState('all');
  const [page, setPage] = useState(0);
  const [playing, setPlaying] = useState(null);
  const [failed, setFailed] = useState(false);
  const previewRef = useRef(null);
  useEffect(() => {
    if (playing) previewRef.current?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [playing]);
  const selected = ANIMATION_STYLES.find(style => style.id === value);
  const filtered = useMemo(() => ANIMATION_STYLES.filter(style => {
    const text = `${style.number} ${style.name} ${style.eyebrow} ${style.source || 'Vidmyo'}`.toLowerCase();
    const term = query.trim().toLowerCase().replace(/^#/, '');
    const matches = !term || (/^\d+$/.test(term) ? style.number === Number(term) : text.includes(term));
    return matches && (source === 'all' || (source === 'classic' ? style.engine === 'classic' : style.id.startsWith(source + '-'))) && (category === 'all' || style.eyebrow === category);
  }), [query, source, category]);
  const pages = Math.max(1, Math.ceil(filtered.length / 12));
  const currentPage = Math.min(page, pages - 1);
  const preview = ANIMATION_STYLES.find(style => style.id === playing);
  return <div className="animation-gallery">
    <div className="animation-gallery-toolbar">
      <label className="creative-field"><span className="creative-label">Find a style</span><input className="creative-input" placeholder="Name, number or technique…" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label>
      <label className="creative-field"><span className="creative-label">Collection</span><select className="creative-select" value={source} onChange={event => { setSource(event.target.value); setPage(0); }}><option value="all">All {ANIMATION_STYLES.length} styles</option><option value="classic">Vidmyo · original pipelines</option><option value="atlas">AI Style Atlas · 86</option><option value="lemo">Lemo-Opuscar · 66</option><option value="mg">MG Styles · 15</option><option value="ink">Animated 3D Story · 1</option></select></label>
      <label className="creative-field"><span className="creative-label">Category</span><select className="creative-select" value={category} onChange={event => { setCategory(event.target.value); setPage(0); }}><option value="all">All categories</option>{[...new Set(ANIMATION_STYLES.map(style => style.eyebrow))].sort().map(item => <option key={item}>{item}</option>)}</select></label>
    </div>
    <div className="animation-selected"><span>Selected</span><strong>#{selected?.number} · {selected?.name}</strong><span>{selected?.engine === 'code' ? 'Code → local render · no image generator required' : 'Original Vidmyo pipeline'}</span></div>
    {preview && <div className="animation-reference" ref={previewRef}>
      <div className="animation-reference-title"><strong>#{preview.number} · {preview.name}</strong><button className="creative-button creative-button-small" onClick={() => setPlaying(null)} type="button">Close preview</button></div>
      {!failed ? <video key={preview.id} controls autoPlay muted playsInline poster={preview.poster} src={preview.preview} onError={() => setFailed(true)} /> : <p>Preview could not be loaded. <a href={preview.sourceUrl} target="_blank" rel="noreferrer">Watch at the source</a></p>}
      <p>{preview.previewKind === 'generated-demo' ? 'Original Vidmyo demonstration, authored locally from this style guide.' : `Reference example by ${preview.source}.`} This is an example of the technique; your film is created from your brief. <a href={preview.sourceUrl} target="_blank" rel="noreferrer">Source & attribution</a></p>
    </div>}
    <div className="creative-style-grid">
      {filtered.slice(currentPage * 12, currentPage * 12 + 12).map(item => <div className="animation-gallery-card" key={item.id} style={{ '--style-accent': item.accent }} data-selected={value === item.id}>
        <button type="button" className="creative-style-card" aria-pressed={value === item.id} onClick={() => onChange(item)}>
          {item.poster ? <img className="animation-style-poster" src={item.poster} alt={`${item.name} reference frame`} loading="lazy" referrerPolicy="no-referrer" /> : renderClassic(item.id)}
          <span className="creative-style-copy"><span className="animation-style-meta">#{String(item.number).padStart(2, '0')} · {item.eyebrow}</span><span className="creative-style-name">{item.name}</span><span className="creative-style-description">{item.description}</span></span>
        </button>
        {item.preview && <button className="animation-preview-button" type="button" onClick={() => { setPlaying(item.id); setFailed(false); }}>▶ Watch example</button>}
      </div>)}
    </div>
    {!filtered.length && <p role="status">No styles match. Try another name, number or collection.</p>}
    <div className="animation-pagination"><span>{filtered.length} styles · page {currentPage + 1} of {pages}</span><div><button className="creative-button creative-button-small" type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button><button className="creative-button creative-button-small" type="button" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>Next</button></div></div>
  </div>;
}
