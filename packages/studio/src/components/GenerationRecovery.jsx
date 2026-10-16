export default function GenerationRecovery({ jobs, busy, onResume, onCancel }) {
  if (!jobs?.length) return null;
  return (
    <section aria-label="Unfinished generations" style={{ background: 'var(--vm-panel)', border: '1px solid var(--vm-line)', borderRadius: 12, padding: 13, marginBottom: 16 }}>
      <strong style={{ color: 'var(--vm-text)', fontSize: 13 }}>Unfinished generations</strong>
      <div style={{ display: 'grid', gap: 8, marginTop: 9 }}>
        {jobs.map(job => (
          <div key={job.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', color: 'var(--vm-muted)', fontSize: 11 }}>
            <span style={{ flex: 1, minWidth: 180 }}>{job.provider} · {job.model || 'model unavailable'} · {job.state}{job.active ? ' in this window' : ''}</span>
            {job.safeToResume && !job.active && <button disabled={busy} onClick={() => onResume(job)} style={{ color: 'var(--vm-text)', background: 'var(--vm-raised)', border: '1px solid var(--vm-line)', borderRadius: 6, padding: '6px 9px' }}>Resume existing request</button>}
            {job.state !== 'error' && <button disabled={busy && !job.active} onClick={() => onCancel(job)} style={{ color: 'var(--vm-danger)', background: 'transparent', border: '1px solid var(--vm-line)', borderRadius: 6, padding: '6px 9px' }}>Cancel</button>}
            {!job.safeToResume && <small style={{ flexBasis: '100%' }}>{job.reason}</small>}
          </div>
        ))}
      </div>
    </section>
  );
}
