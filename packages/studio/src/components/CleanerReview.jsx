import { useEffect, useMemo, useRef, useState } from 'react';
import { sourceTimeForPlayback } from '../cleanerModel.mjs';
import AudioWaveform from './AudioWaveform.jsx';
import AutoEditorPanel from './AutoEditorPanel.jsx';
import PublisherQueuePanel from './PublisherQueuePanel.jsx';

export const reviewTime = seconds => {
  const value = Math.max(0, Number(seconds) || 0);
  return `${Math.floor(value / 60)}:${(value % 60).toFixed(1).padStart(4, '0')}`;
};

const reasonFor = item => item.reason === 'Kept by the conservative cleanup pass.'
  ? 'The earlier analysis supplied no specific reason to remove this speech. Listen in context to decide.' : item.reason;

const categoryFor = item => {
  if (item.category === 'pause') return 'Pause';
  if (['untranscribed', 'gap', 'cut_margin'].includes(item.category)) {
    return String(item.text || '').toLowerCase().includes('cough') ? 'Cough candidate' : 'Audio to check';
  }
  return item.category === 'retake' ? 'Retake' : item.category === 'false_start' ? 'False start' : 'Speech';
};

const rowText = item => {
  if (item.category === 'pause') return 'Pause';
  if (['untranscribed', 'gap', 'cut_margin'].includes(item.category)) return categoryFor(item);
  return item.text;
};

function JoinEditor({ left, right, disabled, playSource, onDecision }) {
  const [draft, setDraft] = useState(String(left.end_seconds));
  const seconds = Number(draft);
  const valid = draft.trim() !== '' && Number.isFinite(seconds)
    && seconds > left.start_seconds + .001 && seconds < right.end_seconds - .001;
  return <details className="cleaner-join-editor">
    <summary>Adjust join → {rowText(right)}</summary>
    <p>If the next section includes an earlier word, move the join later. If its first word is clipped, move it earlier. Listen on both sides before saving.</p>
    <label>Join time in source seconds <input type="number" step="0.01" min={left.start_seconds + .002}
      max={right.end_seconds - .002} value={draft} disabled={disabled}
      onChange={event => setDraft(event.target.value)} /></label>
    <div className="cleaner-review-actions">
      <button type="button" disabled={disabled || !valid} onClick={() => playSource(Math.max(left.start_seconds, seconds - 2), seconds)}>Listen before join</button>
      <button type="button" disabled={disabled || !valid} onClick={() => playSource(seconds, Math.min(right.end_seconds, seconds + 3))}>Listen after join</button>
      <button type="button" disabled={disabled || !valid || seconds === left.end_seconds}
        onClick={() => onDecision(left.segment_id, left.decision, { seconds, expectedSeconds: left.end_seconds })}>Save join</button>
      <button type="button" disabled={disabled} onClick={() => setDraft(String(left.original_timing?.end_seconds ?? left.end_seconds))}>Reset draft</button>
    </div>
    <p>Saving transfers audio between these sections; it does not change Keep/Remove. Confirm both sections again, then rebuild the cleaned preview. Transcript words are approximate labels.</p>
  </details>;
}

export default function CleanerReview({ plan, sourceUrl, loading, error, onRetry, onDecision, disabled, onEditedPreview, reviewTools, onWaveform, projectDir }) {
  const player = useRef(null);
  const workspace = useRef(null);
  const transcript = useRef(null);
  const rows = useRef(new Map());
  const stopAt = useRef(null);
  const previewRequest = useRef(0);
  const pendingPlayback = useRef(null);
  const [mode, setMode] = useState('source');
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [followPlayback, setFollowPlayback] = useState(true);
  const [split, setSplit] = useState(44);
  const [playError, setPlayError] = useState('');
  const [editedUrl, setEditedUrl] = useState('');
  const [preparing, setPreparing] = useState(false);
  disabled = disabled || preparing;

  const summary = plan.summary;
  const duration = summary.source_seconds || 0;
  const ranges = plan.kept_ranges || [];
  const videoUrl = mode === 'edited' ? editedUrl : sourceUrl;
  const sourcePosition = sourceTimeForPlayback(mode, position, ranges);
  const canPreview = Boolean(sourceUrl && duration);
  const appliedCount = plan.decisions.filter(item => item.decision === 'cut').length;
  const suggestedCount = plan.decisions.filter(item => item.proposed === 'cut').length;
  const needsReviewCount = plan.decisions.filter(item => item.needs_review && !item.reviewed).length;
  const playingItem = useMemo(() => {
    const candidates = mode === 'edited'
      ? plan.decisions.filter(item => item.decision !== 'cut')
      : plan.decisions;
    return candidates.find((item, index) => sourcePosition >= item.start_seconds - .001
      && (sourcePosition < item.end_seconds - .001 || (index === candidates.length - 1 && sourcePosition <= item.end_seconds + .001)));
  }, [mode, plan.decisions, sourcePosition]);
  const playingId = playing ? playingItem?.segment_id : null;
  const normalizedQuery = query.trim().toLowerCase();
  const items = plan.decisions.filter(item => {
    if (filter === 'cut' && item.decision !== 'cut') return false;
    if (filter === 'review' && (!item.needs_review || item.reviewed)) return false;
    return !normalizedQuery || `${item.text} ${item.reason} ${categoryFor(item)}`.toLowerCase().includes(normalizedQuery);
  });

  useEffect(() => {
    player.current?.pause();
    stopAt.current = null;
    pendingPlayback.current = null;
    previewRequest.current += 1;
    // Never substitute the uncut source for an invalidated cleaned preview.
    setEditedUrl(''); setPreparing(false); setPlaying(false); setPosition(0);
    setPlayError('');
    return () => { previewRequest.current += 1; };
  }, [sourceUrl, plan]);

  useEffect(() => {
    let frame;
    const tick = () => {
      const video = player.current;
      if (video && !video.paused && !video.seeking) {
        const now = video.currentTime;
        setPosition(now);
        if (mode === 'source' && stopAt.current != null && now >= stopAt.current) {
          video.pause(); stopAt.current = null;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [mode]);

  const scrollToPlayhead = () => {
    const list = transcript.current;
    const row = playingId ? rows.current.get(playingId) : null;
    if (!list || !row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < list.scrollTop + 12 || bottom > list.scrollTop + list.clientHeight - 12) {
      list.scrollTo({ top: Math.max(0, top - list.clientHeight * .38), behavior: 'auto' });
    }
  };

  useEffect(() => {
    if (followPlayback && playingId) scrollToPlayhead();
  }, [followPlayback, playingId]);

  const pauseFollowing = () => {
    if (playing) setFollowPlayback(false);
  };
  const resumeFollowing = () => {
    setFollowPlayback(true);
    requestAnimationFrame(scrollToPlayhead);
  };
  const startResize = event => {
    if (!workspace.current || window.innerWidth <= 980) return;
    event.preventDefault();
    const rect = workspace.current.getBoundingClientRect();
    const move = pointer => {
      const minimumLeft = Math.min(42, 340 / rect.width * 100);
      const maximumLeft = Math.max(48, 100 - (420 / rect.width * 100));
      setSplit(Math.max(minimumLeft, Math.min(maximumLeft, (pointer.clientX - rect.left) / rect.width * 100)));
    };
    const done = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', done);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', done);
  };

  const play = async (start, end = null) => {
    const video = player.current;
    if (!video) return;
    const version = previewRequest.current;
    stopAt.current = end;
    video.currentTime = start;
    try { await video.play(); setPlayError(''); }
    catch (failure) {
      if (failure.name !== 'AbortError' && version === previewRequest.current && video === player.current) {
        setPlayError('The video could not play. Retry loading it, then press Play.');
      }
    }
  };
  const playItem = (item, context = false) => {
    setSelected(item.segment_id);
    playSource(Math.max(0, item.start_seconds - (context ? 2 : 0)), Math.min(duration, item.end_seconds + (context ? 2 : 0)));
  };
  const playSource = (start, end = null) => {
    if (mode === 'source') play(start, end);
    else { pendingPlayback.current = { start, end }; setMode('source'); }
  };
  const previewEdit = async () => {
    if (preparing) return;
    player.current?.pause();
    if (editedUrl) {
      if (mode === 'edited') play(0);
      else { pendingPlayback.current = { start: 0, end: null }; setMode('edited'); }
      return;
    }
    const request = ++previewRequest.current;
    setPreparing(true); setPlayError('');
    try {
      const result = await onEditedPreview?.();
      if (request !== previewRequest.current) return;
      if (!result?.ok || !result.editedUrl) throw new Error(result?.error || 'Cleaned preview is unavailable. Reopen the project and try again.');
      pendingPlayback.current = { start: 0, end: null };
      setEditedUrl(result.editedUrl); setMode('edited'); setSelected(null);
    } catch (failure) {
      if (request === previewRequest.current) setPlayError(failure.message);
    } finally {
      if (request === previewRequest.current) setPreparing(false);
    }
  };

  return <section className="cleaner-review" aria-label="Review cleanup">
    <div ref={workspace} className="cleaner-review-workspace" style={{ '--cleaner-left': `${split}fr`, '--cleaner-right': `${100 - split}fr` }}>
      <section className="cleaner-transcript-pane" aria-label="Transcript decisions">
        <header className="cleaner-review-heading">
          <div><small>TRANSCRIPT EDIT</small><h2>Review the cut</h2></div>
          <span>{suggestedCount} suggested · {appliedCount} applied</span>
        </header>
        <div className="cleaner-transcript-tools">
          <label><span className="sr-only">Search transcript</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search transcript" /></label>
          <div className="cleaner-filter-tabs" role="group" aria-label="Filter review sections">
            <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All <span>{plan.decisions.length}</span></button>
            <button type="button" aria-pressed={filter === 'cut'} onClick={() => setFilter('cut')}>Removed <span>{appliedCount}</span></button>
            <button type="button" aria-pressed={filter === 'review'} onClick={() => setFilter('review')}>Needs review <span>{needsReviewCount}</span></button>
          </div>
        </div>
        {plan.requires_reanalysis && <p role="alert" className="cleaner-review-error">This older transcript has unreliable word timings and may be missing takes. Automatic pause cuts have been restored. Use “Analyze again with improved transcription” before export.</p>}
        {needsReviewCount > 0 && !plan.requires_reanalysis && <p role="alert" className="cleaner-review-notice">{needsReviewCount} sections need listening before export. Play each flagged section and confirm Keep or Remove.</p>}
        {!!plan.unresolved_reanalysis_overrides?.length && <details className="cleaner-review-notice">
          <summary>Some previous choices need checking after reanalysis</summary>
          <p>The transcript changed, so these choices could not transfer safely. Review the affected sections below. Your previous plan is saved in the project’s cleaner-plan-history folder.</p>
          {plan.unresolved_reanalysis_overrides.map((item, index) => <p key={index}>{reviewTime(item.start_seconds)}–{reviewTime(item.end_seconds)} · Previously {item.decision === 'cut' ? 'removed' : 'kept'}: {item.text}</p>)}
        </details>}
        <div ref={transcript} className="cleaner-review-list" onWheel={pauseFollowing} onTouchMove={pauseFollowing}
          onPointerDown={pauseFollowing} onKeyDown={event => {
            if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) pauseFollowing();
          }}>
          {!items.length && <p className="cleaner-empty-filter">No matching sections. Change the filter or search.</p>}
          {items.map(item => {
            const isPlaying = playingId === item.segment_id;
            const isSelected = selected === item.segment_id;
            const isSpeech = !['pause', 'untranscribed', 'gap', 'cut_margin'].includes(item.category);
            const right = plan.decisions.find(next => next.segment_id !== item.segment_id && Math.abs(next.start_seconds - item.end_seconds) < .001);
            const similar = (plan.repeated_takes || []).filter(pair => pair.earlier === item.segment_id)
              .map(pair => plan.decisions.find(entry => entry.segment_id === pair.later)).filter(Boolean);
            return <article key={item.segment_id} ref={node => node ? rows.current.set(item.segment_id, node) : rows.current.delete(item.segment_id)}
              data-playing={isPlaying} data-selected={isSelected} data-cut={item.decision === 'cut'} aria-current={isPlaying ? 'true' : undefined}>
              <div className="cleaner-row-main">
                <button type="button" className="cleaner-row-play" disabled={!canPreview || disabled} onClick={() => isPlaying ? player.current?.pause() : playItem(item)} aria-label={`${isPlaying ? 'Pause' : 'Play'} ${rowText(item)}`}>{isPlaying ? '■' : '▶'}</button>
                <button type="button" className="cleaner-section-text" disabled={!canPreview || disabled} onClick={() => playItem(item)}>
                  <span>{rowText(item)}</span>
                  <small>{categoryFor(item)} · {reviewTime(item.start_seconds)}–{reviewTime(item.end_seconds)}{item.proposed === 'cut' && item.decision === 'keep' && !item.reviewed ? ' · Suggested removal' : ''}{item.needs_review && !item.reviewed ? ' · Needs review' : ''}</small>
                </button>
                <button type="button" className="cleaner-decision-toggle" data-cut={item.decision === 'cut'} disabled={disabled || loading}
                  onClick={() => onDecision(item.segment_id, item.decision === 'cut' ? 'keep' : 'cut')}>
                  {item.decision === 'cut' ? 'Restore' : 'Remove'}
                </button>
              </div>
              <details className="cleaner-row-details" open={isSelected && item.needs_review && !item.reviewed}>
                <summary>Why & timing <span>{item.proposed === 'cut' ? 'Suggested removal' : item.reviewed ? 'Reviewed' : 'Details'}</span></summary>
                <div className="cleaner-row-detail-body">
                  <p><b>{item.decision === 'cut' ? 'Removed' : 'Kept'}.</b> {reasonFor(item)}</p>
                  {!isSpeech && item.text && item.text !== rowText(item) && <p>{item.text}</p>}
                  {item.join_warning && !item.timing_adjusted && <p>Uncertain join: audio from a neighboring take may cross this boundary. Adjust the join below and listen on both sides.</p>}
                  {item.timing_adjusted && <p>Timing adjusted by you. The transcript label has not been retranscribed; listen to verify the new boundary.</p>}
                  {item.override_conflict && <p className="cleaner-warning-copy">A previous choice or boundary changed during reanalysis. Listen and confirm this section again.</p>}
                  {item.proposed === 'cut' && item.decision === 'keep' && !item.reviewed && <p className="cleaner-warning-copy">Suggested removal, currently kept because the audio needs checking.</p>}
                  {item.reviewed && item.decision !== item.proposed && <p>Your choice overrides the suggestion: {item.decision === 'cut' ? 'remove this section' : 'keep this section'}.</p>}
                  <div className="cleaner-review-actions">
                    <button type="button" disabled={!canPreview || disabled} onClick={() => playItem(item)}>Play section</button>
                    <button type="button" disabled={!canPreview || disabled} onClick={() => playItem(item, true)}>Play with context</button>
                    {item.needs_review && !item.reviewed && <button type="button" disabled={disabled || loading} onClick={() => onDecision(item.segment_id, item.decision)}>{item.decision === 'cut' ? 'Confirm removal' : 'Confirm keep'}</button>}
                    {item.reviewed && <span>Choice saved</span>}
                  </div>
                  {similar.map(alternative => <button key={alternative.segment_id} type="button" className="cleaner-compare-take" disabled={!canPreview || disabled} onClick={() => playItem(alternative, true)}>Compare take at {reviewTime(alternative.start_seconds)} →</button>)}
                  {right && <JoinEditor key={`${item.end_seconds}-${right.end_seconds}`} left={item} right={right}
                    disabled={disabled || loading || !canPreview} playSource={playSource} onDecision={onDecision} />}
                </div>
              </details>
            </article>;
          })}
        </div>
        <footer className="cleaner-transcript-footer">
          <span>Removed speech stays visible and restorable.</span>
          <button type="button" aria-pressed={followPlayback} onClick={() => followPlayback ? setFollowPlayback(false) : resumeFollowing()}>Follow playback {followPlayback ? 'on' : 'off'}</button>
          {!followPlayback && playingId && <button type="button" className="cleaner-back-playhead" onClick={resumeFollowing}>Back to playhead</button>}
        </footer>
      </section>

      <button type="button" className="cleaner-splitter" role="separator" aria-label="Resize transcript and preview" aria-orientation="vertical"
        aria-valuemin="34" aria-valuemax="58" aria-valuenow={Math.round(split)} onPointerDown={startResize}
        onKeyDown={event => {
          if (event.key === 'ArrowLeft') setSplit(value => Math.max(34, value - 2));
          if (event.key === 'ArrowRight') setSplit(value => Math.min(58, value + 2));
        }} />

      <aside className="cleaner-preview-pane" aria-label="Video preview and edit summary">
        <div className="cleaner-preview-sticky">
          <div className="cleaner-monitor">
            {videoUrl ? <video key={videoUrl} ref={player} src={videoUrl} controls playsInline preload="metadata"
              aria-label={mode === 'edited' ? 'Cleaned edit preview' : 'Original recording'}
              onLoadedMetadata={() => { const pending = pendingPlayback.current; pendingPlayback.current = null; if (pending) play(pending.start, pending.end); }}
              onTimeUpdate={event => setPosition(event.currentTarget.currentTime)}
              onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
              onError={() => setPlayError('This video could not be decoded. Its codec may need a compatible preview. Your source is safe.')} />
              : <p>{mode === 'edited' ? (preparing ? 'Preparing the updated cleaned preview…' : 'Your decisions changed. Prepare the cleaned preview again to hear the current edit.') : loading ? 'Preparing a local playback copy and cut timeline. The first load can take a few minutes for a long recording…' : 'Load the recording to review your edit.'}</p>}
            <div className="cleaner-monitor-bar"><b>{mode === 'edited' ? 'CLEANED EDIT' : 'ORIGINAL'}</b><span>{mode === 'edited' ? 'Edited' : 'Source'} {reviewTime(position)} / {reviewTime(mode === 'edited' ? summary.output_seconds : duration)}</span></div>
          </div>
          {(error || playError) && <div role="alert" className="cleaner-review-error">{error || playError} <button type="button" onClick={onRetry} disabled={disabled}>Reload preview</button></div>}
          <div className="cleaner-transport">
            <div className="cleaner-mode-toggle" role="group" aria-label="Preview version">
              <button type="button" aria-pressed={mode === 'source'} disabled={!canPreview || disabled} onClick={() => { setSelected(null); playSource(0); }}>Original</button>
              <button type="button" className="cleaner-review-primary" aria-pressed={mode === 'edited'} disabled={!canPreview || !ranges.length || disabled} onClick={previewEdit}>{preparing ? 'Preparing…' : editedUrl ? 'Cleaned' : 'Prepare cleaned'}</button>
            </div>
            <span>Same boundaries as export · local preview</span>
          </div>
          <div className="cleaner-timeline" aria-label="Clickable source timeline">
            {plan.decisions.map(item => <button type="button" key={item.segment_id} title={`${item.decision === 'cut' ? 'Remove' : 'Keep'} · ${reviewTime(item.start_seconds)}–${reviewTime(item.end_seconds)} · ${item.text}`}
              aria-label={`Play ${rowText(item)}`} disabled={!canPreview || disabled}
              onClick={() => playItem(item)} style={{ left: `${100 * item.start_seconds / (duration || 1)}%`, width: `${100 * (item.end_seconds - item.start_seconds) / (duration || 1)}%` }} data-cut={item.decision === 'cut'} />)}
            <i style={{ left: `${Math.min(100, 100 * sourcePosition / (duration || 1))}%` }} />
          </div>
          <AudioWaveform sourceUrl={sourceUrl} load={onWaveform} sourcePosition={sourcePosition} duration={duration}/>
          <div className="cleaner-review-stats"><span>Original <b>{reviewTime(duration)}</b></span><span>Cleaned <b>{reviewTime(summary.output_seconds)}</b></span><span>Removed <b>{reviewTime(summary.removed_seconds)}</b></span></div>
          {!summary.speech_cuts && <p className="cleaner-review-guide">No speech is marked for removal. {summary.pause_cuts ? 'Only long gaps are shortened.' : 'Keeping all useful speech is a valid result.'}</p>}
          {reviewTools}
          <AutoEditorPanel projectDir={projectDir} />
          <PublisherQueuePanel currentVideoPath={editedUrl || sourceUrl} />
        </div>
      </aside>
    </div>
  </section>;
}
