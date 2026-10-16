import {interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {countUp} from '../motion';
import {hexA, type Style, type Materials} from '../theme';

// BIG statement type: the replacement for small text pills. A single spoken
// claim rendered at display scale inside a layout variant. Words stagger in,
// emphasis words take the pop/glow color, {COUNT} renders as an eased counter.
export const Statement = ({
  payload,
  style,
  m,
  sF,
  fontPx,
  maxLinePx,
  align = 'center',
  textColor,
}: {
  payload: any;
  style: Style;
  m: Materials;
  sF: number;
  fontPx: number;
  maxLinePx?: number;
  align?: 'center' | 'left';
  textColor?: string;
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const emphasis: string[] = payload?.emphasis ?? [];
  // Emphasis phrases are UNBREAKABLE: join them with non-breaking spaces so a
  // line wrap can never split "30 DAYS" across lines.
  let text: string = payload?.text ?? '';
  const emphJoined = emphasis.map((p) => p.split(/\s+/).join(' '));
  emphasis.forEach((p, i) => {
    text = text.split(p).join(emphJoined[i]);
  });
  const emphWords = new Set(emphJoined.map((p) => p.toUpperCase()));
  // The Director caps statements at 7 words; the stacking search below grows
  // ~1.8^n, so never let an over-long spec text past 12.
  const words = text.split(/ +/).slice(0, 12);
  const staggerF = ((style.theme.motion?.wordStaggerMs ?? 50) / 1000) * fps;
  const pop = (style.colors as any).pop ?? m.glowA;
  const baseColor = textColor ?? (m.isFlat ? ((style.colors as any).ink ?? '#1F1E1D') : '#FFFFFF');

  // Display type stacks: max 3 words per line, intentional ragged lines.
  // A statement that fits on one small line is a bug, not a graphic.
  // Among stackings with the minimal line count, take the one whose longest
  // line is shortest: wide fonts (Inter) must fit the same fields that
  // condensed fonts (Anton) do.
  const stackings = (ws: string[]): string[][][] => {
    if (!ws.length) return [[]];
    const out: string[][][] = [];
    for (let take = 1; take <= Math.min(3, ws.length); take += 1) {
      for (const rest of stackings(ws.slice(take))) out.push([ws.slice(0, take), ...rest]);
    }
    return out;
  };
  const lineLen = (l: string[]) => l.join(' ').length;
  const options = stackings(words);
  const fitsAtDisplay = (candidate: string[][]) => !maxLinePx || candidate.every((line) => lineLen(line) * fontPx * 0.62 <= maxLinePx);
  const fitting = options.filter(fitsAtDisplay);
  const pool = fitting.length ? fitting : options;
  const minCount = Math.min(...pool.map((p) => p.length));
  const lines =
    pool
      .filter((p) => p.length === minCount)
      .sort((a, b) => Math.max(...a.map(lineLen)) - Math.max(...b.map(lineLen)))[0] ?? [words];
  // Width fit (wide-font safety net): shrink from display size ONLY as far as
  // the longest line physically requires, est. 0.62em average glyph width.
  const longest = Math.max(...lines.map(lineLen), 1);
  const px = maxLinePx ? Math.min(fontPx, maxLinePx / (longest * 0.62)) : fontPx;
  let wordIdx = -1;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: align === 'center' ? 'center' : 'flex-start',
        rowGap: px * 0.08,
        maxWidth: '100%',
      }}
    >
      {lines.map((line, li) => (
        <div
          key={li}
          style={{
            display: 'flex',
            justifyContent: align === 'center' ? 'center' : 'flex-start',
            columnGap: px * 0.28,
            whiteSpace: 'nowrap',
          }}
        >
          {line.map((w) => {
            wordIdx += 1;
            const i = wordIdx;
            const wF = sF + 6 + i * staggerF;
        const wIn = interpolate(frame, [wF, wF + 7], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
        const isCount = w === '{COUNT}' && payload?.countTo != null;
        const display = isCount
          ? `${payload.countPrefix ?? ''}${countUp(frame, wF, fps, payload.countTo, payload.countFrom ?? 0, 1.0).toLocaleString('en-US')}${payload.countSuffix ?? ''}`
          : w;
        const isEmph = emphWords.has(w.toUpperCase()) || isCount;
        const pulseT = interpolate(frame, [wF, wF + 10], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
        const pulse = isEmph ? 1 + 0.06 * Math.sin(pulseT * Math.PI) : 1;
        return (
          <span
            key={i}
            style={{
              fontFamily: style.headlineFamily,
              fontWeight: 700,
              fontSize: px,
              lineHeight: 1.08,
              letterSpacing: 1.5,
              color: isEmph ? pop : baseColor,
              opacity: wIn,
              transform: `translateY(${(1 - wIn) * px * 0.25}px) scale(${pulse})`,
              display: 'inline-block',
              textShadow: isEmph && !m.isFlat ? `0 0 ${px * 0.45}px ${hexA(pop, 0.55)}` : 'none',
              fontVariantNumeric: isCount ? 'tabular-nums' : undefined,
            }}
          >
            {display}
          </span>
            );
          })}
        </div>
      ))}
    </div>
  );
};
