// Pure export cancellation and outcome state model for Vidmyo V2.6 studios.
// Ensures consistent jobId generation matching /^job_[\w-]+$/,
// cancellation detection, and uniform Polish status labels ("Gotowe" / "Anulowano" / "Błąd: ...").

/**
 * Generates a validated job identifier for export jobs.
 * Guaranteed to match /^job_[\w-]+$/ for JobStore compatibility.
 *
 * @param {string} [prefix='job']
 * @returns {string}
 */
export function newExportJobId(prefix = 'job') {
  const sanitized = String(prefix).replace(/[^a-zA-Z0-9_-]/g, '') || 'job';
  const head = sanitized.startsWith('job') ? sanitized : `job_${sanitized}`;
  const timestamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `${head}_${timestamp}_${rand}`;
}

/**
 * Checks whether an export response indicates cancellation.
 *
 * @param {any} res
 * @returns {boolean}
 */
export function isJobCancelled(res) {
  if (!res) return false;
  if (res.cancelled === true || res.canceled === true) return true;
  if (res.state === 'cancelled') return true;
  const msg = String(res.error || res.message || '');
  return /cancelled|canceled|anulowan/i.test(msg);
}

/**
 * Translates an export response into a structured outcome.
 *
 * @param {any} res
 * @returns {{ state: 'done' | 'cancelled' | 'error', label: string, cancelled: boolean, ok: boolean, jobId: string|null, message: string, outputPath?: string|null, encoder?: any, unsupported?: any[] }}
 */
export function exportOutcome(res) {
  if (!res) {
    return {
      state: 'error',
      label: 'Błąd: brak odpowiedzi',
      cancelled: false,
      ok: false,
      jobId: null,
      message: 'Błąd: brak odpowiedzi',
    };
  }

  if (isJobCancelled(res)) {
    return {
      state: 'cancelled',
      label: 'Anulowano',
      cancelled: true,
      ok: false,
      jobId: res.jobId || null,
      message: 'Anulowano eksport.',
    };
  }

  if (res.ok) {
    return {
      state: 'done',
      label: 'Gotowe',
      cancelled: false,
      ok: true,
      outputPath: res.outputPath || null,
      jobId: res.jobId || null,
      encoder: res.encoder || null,
      unsupported: res.unsupported || [],
      message: res.outputPath ? `Gotowe: ${res.outputPath}` : 'Gotowe',
    };
  }

  const err = res.error || res.message || 'Nieznany błąd';
  return {
    state: 'error',
    label: `Błąd: ${err}`,
    cancelled: false,
    ok: false,
    jobId: res.jobId || null,
    error: err,
    message: `Błąd: ${err}`,
  };
}
