export function canSubmitProviderRequest({ approved, busy, prompt, endpoint, requiresSource = false, hasSource = false }) {
  return Boolean(approved && !busy && String(prompt || '').trim() && String(endpoint || '').trim()
    && (!requiresSource || hasSource));
}
