// Shared render-outcome messaging for the Promo / Review / Cartoon export
// panels.
//
// The gate (Phase 3 item 4): an export that skipped unsupported EDG features
// must never report a plain success or a bare error. Every outcome carries the
// feature count and the feature names, so the panel shows what was not used
// instead of dropping it silently.

function featureName(entry) {
  if (typeof entry === 'string') return entry.trim();
  if (entry && typeof entry === 'object') {
    const value = entry.feature ?? entry.name ?? entry.id;
    if (typeof value === 'string') return value.trim();
  }
  return '';
}

/**
 * Normalises the `unsupported` payload returned by the promo bridge
 * (`res.unsupported`, `res.result.unsupported`, or `err.unsupported`) into a
 * plain list of feature names.
 */
export function unsupportedFeatureNames(unsupported) {
  if (!Array.isArray(unsupported)) return [];
  const names = [];
  for (const entry of unsupported) {
    const name = featureName(entry);
    if (name) names.push(name);
  }
  return names;
}

export function promoUnsupportedList(unsupported) {
  const features = unsupportedFeatureNames(unsupported);
  if (!features.length) return null;
  return { count: features.length, features };
}

export function promoUnsupportedNote(unsupported) {
  const list = promoUnsupportedList(unsupported);
  if (!list) return '';
  return ` · nieobsługiwane cechy EDG (${list.count}): ${list.features.join(', ')}`;
}

/**
 * Builds the message shown by the export panels plus the unsupported list the
 * panel renders as its own warning block.
 *
 * @param {{ ok?: boolean, successMessage?: string, errorMessage?: string, unsupported?: unknown }} outcome
 */
export function promoRenderOutcome({ ok = false, successMessage = '', errorMessage = '', unsupported = null } = {}) {
  const list = promoUnsupportedList(unsupported);
  const note = list ? promoUnsupportedNote(list.features) : '';
  return {
    ok: Boolean(ok),
    message: ok ? `${successMessage}${note}` : `${errorMessage}${note}`,
    unsupported: list ? list.features : [],
    unsupportedCount: list ? list.count : 0,
    hasUnsupported: Boolean(list),
  };
}
