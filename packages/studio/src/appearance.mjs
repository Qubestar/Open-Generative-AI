export const APPEARANCE_KEY = 'vidmyo_appearance_v1';
export const APPEARANCES = [
  { id: 'dark', label: 'Filmcraft Noir' },
  { id: 'light', label: 'Arctic Editorial' },
  { id: 'aurora', label: 'Graphite Aurora' },
];
export const normalizeAppearance = value => APPEARANCES.some(item => item.id === value) ? value : 'dark';
export function readAppearance(storage) {
  try { return normalizeAppearance(storage?.getItem(APPEARANCE_KEY)); } catch { return 'dark'; }
}
export function saveAppearance(storage, value) {
  const appearance = normalizeAppearance(value);
  try { storage?.setItem(APPEARANCE_KEY, appearance); } catch { /* Appearance still works without storage. */ }
  return appearance;
}
