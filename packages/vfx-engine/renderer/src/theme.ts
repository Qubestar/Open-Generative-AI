import simpleClaude from '../../themes/simple-claude.json';
import liquidGlass from '../../themes/liquid-glass.json';
import synthwave from '../../themes/synthwave.json';
import {continueRender, delayRender} from 'remotion';
import {getAvailableFonts} from '@remotion/google-fonts';
import {loadFont as loadOutfit} from '@remotion/google-fonts/Outfit';
import {loadFont as loadAnton} from '@remotion/google-fonts/Anton';
import {loadFont as loadManrope} from '@remotion/google-fonts/Manrope';
import {loadFont as loadInter} from '@remotion/google-fonts/Inter';

// Load ONLY the weights/subsets the components actually render (400/600/700,
// latin). A bare loadFont() fetches every style x weight x subset: 189 font
// faces total, 126 network requests for Inter alone, per render.
const outfit = loadOutfit('normal', {weights: ['400', '600', '700'], subsets: ['latin'], ignoreTooManyRequestsWarning: true});
const anton = loadAnton('normal', {weights: ['400'], subsets: ['latin'], ignoreTooManyRequestsWarning: true}); // Anton ships 400 only
const manrope = loadManrope('normal', {weights: ['400', '600', '700'], subsets: ['latin'], ignoreTooManyRequestsWarning: true});
const inter = loadInter('normal', {weights: ['400', '600', '700'], subsets: ['latin'], ignoreTooManyRequestsWarning: true});

const THEMES: Record<string, any> = {
  'simple-claude': simpleClaude,
  'liquid-glass': liquidGlass,
  'synthwave': synthwave,
};

const GOOGLE_LOADED: Record<string, string> = {
  Outfit: outfit.fontFamily,
  Anton: anton.fontFamily,
  Manrope: manrope.fontFamily,
  Inter: inter.fontFamily,
};

// Any OTHER Google family named by a brand kit loads dynamically (case
// insensitive). The render is held (delayRender) until the module import
// resolves; loadFont() then holds it per fetched font file. Weights are
// intersected against what the family actually ships because loadFont throws
// on a weight the font does not have. Families that are not on Google Fonts
// pass through unchanged and resolve only if installed on this machine.
const dynamicLoaded: Record<string, string> = {};
const dynamicRequested = new Set<string>();

function ensureGoogleFamily(family: string | undefined) {
  if (!family || GOOGLE_LOADED[family] || dynamicRequested.has(family)) return;
  dynamicRequested.add(family);
  const entry = getAvailableFonts().find(
    (f) => f.fontFamily.toLowerCase() === family.toLowerCase()
  );
  if (!entry) return;
  const handle = delayRender(`Loading Google Font ${entry.fontFamily}`);
  entry
    .load()
    .then((mod) => {
      const info = mod.getInfo();
      const avail = Object.keys((info.fonts as any).normal ?? {});
      const wanted = ['400', '600', '700'].filter((w) => avail.includes(w));
      const loaded = (mod.loadFont as any)('normal', {
        weights: wanted.length ? wanted : avail,
        subsets: info.subsets.includes('latin') ? ['latin'] : info.subsets,
        ignoreTooManyRequestsWarning: true,
      });
      dynamicLoaded[family] = loaded.fontFamily;
      continueRender(handle);
    })
    .catch(() => continueRender(handle)); // unloadable: the fallback stack renders
}

export type Style = {
  theme: any;
  colors: Record<string, string>;
  headlineFamily: string;
  bodyFamily: string;
};

function stack(font: any, themeFont: any): string {
  const fam = font?.family ?? themeFont?.family ?? 'Outfit';
  const fallback = font?.fallback ?? themeFont?.fallback ?? 'sans-serif';
  ensureGoogleFamily(fam);
  ensureGoogleFamily(fallback);
  const parts = [fam, fallback, 'sans-serif']
    .filter(Boolean)
    .map((f) => GOOGLE_LOADED[f as string] ?? dynamicLoaded[f as string] ?? f);
  return parts.map((f) => `'${f}'`).join(', ');
}

export function resolveStyle(spec: any): Style {
  const theme = THEMES[spec?.brand?.theme] ?? synthwave;
  const colors = {...(theme.colors ?? {}), ...(spec?.brand?.colors ?? {})};
  const kitFonts = spec?.brand?.fonts ?? {};
  return {
    theme,
    colors,
    headlineFamily: stack(kitFonts.headline, theme.fonts?.headline),
    bodyFamily: stack(kitFonts.body, theme.fonts?.body),
  };
}

export function hexA(hex: string | undefined, a: number): string {
  if (!hex || !hex.startsWith('#')) return `rgba(255,255,255,${Math.max(0, Math.min(1, a))})`;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
}

// Very dark brand accents (e.g. a deep blue like #2600EF) glow poorly on dark
// fields; blend toward white for GLOW USE ONLY (fills/text keep the true hex).
export function liftGlow(hex: string | undefined): string {
  if (!hex || !hex.startsWith('#') || hex.length < 7) return hex ?? '#FFFFFF';
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (lum >= 90) return hex;
  const t = 0.45;
  const mix = (ch: number) => Math.round(ch + (255 - ch) * t);
  return `#${[mix(r), mix(g), mix(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

export type Materials = {
  bgBase: string;
  bgLayers: string;
  gridOpacity: number;
  perspectiveFloor: boolean;
  panelBg: string;
  panelBorder: string;
  panelBlurPx: number;
  radiusPx: number;
  glowA: string;
  glowB: string;
  titleGradient: string | null;
  isFlat: boolean;
  negationHot: string;
  ghostNumeralOpacity: number;
};

// Per-theme material resolution so every component renders the THEME, not a
// hardcoded look. Fullscreen/75 fields, panel surfaces, glows, title style.
export function materials(style: Style): Materials {
  const n = style.theme.name;
  const c = style.colors as Record<string, string | undefined>;
  if (n === 'liquid-glass') {
    const ice = liftGlow(c.accent ?? '#5AC8FA');
    return {
      bgBase: '#141922',
      bgLayers: [
        `radial-gradient(75% 65% at 20% 14%, ${hexA(ice, 0.32)} 0%, transparent 70%)`,
        `radial-gradient(60% 65% at 82% 78%, rgba(255,255,255,0.11) 0%, transparent 70%)`,
        `radial-gradient(45% 40% at 60% 30%, rgba(255,255,255,0.08) 0%, transparent 70%)`,
        `linear-gradient(to top, rgba(0,0,0,0.38) 0%, transparent 22%)`,
      ].join(', '),
      gridOpacity: 0.35,
      perspectiveFloor: false,
      panelBg: c.panel ?? 'rgba(255,255,255,0.14)',
      panelBorder: '1px solid rgba(255,255,255,0.35)',
      panelBlurPx: 24,
      radiusPx: 24,
      glowA: ice,
      glowB: '#FFFFFF',
      titleGradient: `linear-gradient(180deg, #FFFFFF 0%, #CFEAFB 90%)`,
      isFlat: false,
      negationHot: '#FF5A5A',
      ghostNumeralOpacity: 0.09,
    };
  }
  if (n === 'simple-claude') {
    return {
      bgBase: c.background ?? '#FAF9F5',
      bgLayers: `radial-gradient(70% 60% at 80% 20%, ${hexA(c.accent ?? '#D97757', 0.10)} 0%, transparent 70%)`,
      gridOpacity: 0,
      perspectiveFloor: false,
      panelBg: c.panel ?? '#FFFFFF',
      panelBorder: '1px solid rgba(31,30,29,0.06)',
      panelBlurPx: 0,
      radiusPx: 20,
      glowA: c.accent ?? '#D97757',
      glowB: c.accent ?? '#D97757',
      titleGradient: null,
      isFlat: true,
      negationHot: '#D9534F',
      ghostNumeralOpacity: 0.06,
    };
  }
  // synthwave
  return {
    bgBase: c.void ?? '#0B0714',
    bgLayers: [
      `radial-gradient(60% 55% at 18% 22%, ${hexA(c.secondary ?? '#5001D6', 0.38)} 0%, transparent 70%)`,
      `radial-gradient(55% 60% at 82% 38%, ${hexA(c.accent ?? '#2600EF', 0.30)} 0%, transparent 70%)`,
      `radial-gradient(45% 45% at 30% 88%, ${hexA(c.cyan ?? '#4DE1FF', 0.16)} 0%, transparent 70%)`,
      `radial-gradient(40% 55% at 0% 55%, ${hexA(c.ember ?? '#FF9E4D', 0.14)} 0%, transparent 70%)`,
      `linear-gradient(to top, rgba(0,0,0,0.4) 0%, transparent 20%)`,
    ].join(', '),
    gridOpacity: 0.65,
    perspectiveFloor: true,
    panelBg: 'rgba(10,7,20,0.62)',
    panelBorder: '1px solid rgba(255,255,255,0.18)',
    panelBlurPx: 8,
    radiusPx: 22,
    glowA: c.cyan ?? '#4DE1FF',
    glowB: c.secondary ?? '#5001D6',
    titleGradient: `linear-gradient(180deg, ${c.secondary ?? '#5001D6'} 0%, #EDE7FF 80%)`,
    isFlat: false,
    negationHot: c.ember ?? '#FF9E4D',
    ghostNumeralOpacity: 0.09,
  };
}
