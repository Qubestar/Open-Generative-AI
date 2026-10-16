export type CanvasClass = 'portrait' | 'landscape' | 'square';

export const canvasClass = (width: number, height: number): CanvasClass => {
  const ratio = width / height;
  if (ratio <= 0.8) return 'portrait';
  if (ratio >= 1.25) return 'landscape';
  return 'square';
};

export const shortSide = (width: number, height: number) => Math.min(width, height);

type Insets = {top: number; right: number; bottom: number; left: number};

// Conservative content zones. Platform chrome changes over time, so these are
// deliberately represented as profiles rather than baked into every component.
// Decorative backgrounds may bleed outside; text, faces and controls may not.
export const safeInsets = (spec: any, width: number, height: number): Insets => {
  const kind = canvasClass(width, height);
  const platform = spec?.meta?.format?.platform ?? (kind === 'portrait' ? 'shorts' : 'youtube');
  if (kind !== 'portrait') return {top: height * 0.055, right: width * 0.055, bottom: height * 0.065, left: width * 0.055};
  const profiles: Record<string, [number, number, number, number]> = {
    shorts: [0.12, 0.18, 0.2, 0.08],
    tiktok: [0.11, 0.2, 0.21, 0.08],
    reels: [0.1, 0.16, 0.19, 0.08],
    generic: [0.07, 0.07, 0.09, 0.07],
  };
  const [top, right, bottom, left] = profiles[platform] ?? profiles.shorts;
  return {top: height * top, right: width * right, bottom: height * bottom, left: width * left};
};

export const safeBox = (spec: any, width: number, height: number) => {
  const inset = safeInsets(spec, width, height);
  return {...inset, width: width - inset.left - inset.right, height: height - inset.top - inset.bottom};
};
