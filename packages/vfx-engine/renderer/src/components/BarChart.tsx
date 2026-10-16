import {spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {sec2f, countUp} from '../motion';
import {hexA, type Style} from '../theme';

// Diagram primitive: staggered bar chart. Each bar springs up from a zero
// baseline while its counter ticks up IN SYNC with the rise; a soft bright
// edge glow rides the top of the bar. Items: {text, value, prefix?, suffix?,
// revealSec?}. Used by Concept75 and ConceptFullscreen when kind = "chart".
export const BarChart = ({evt, style, chartHeightPct = 0.4}: {evt: any; style: Style; chartHeightPct?: number}) => {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const m = style.theme.motion;
  const sF = sec2f(evt.startSec, fps);
  const items: any[] = evt.payload?.items ?? [];
  const maxV = Math.max(...items.map((it) => it.value ?? 1), 1);
  const chartH = height * chartHeightPct;
  const barW = Math.min(width * 0.062, (width * 0.52) / Math.max(items.length, 1));
  const accent = style.colors.accent ?? '#2600EF';
  const secondary = style.colors.secondary ?? accent;
  const cyan = style.colors.cyan ?? '#4DE1FF';

  return (
    <div style={{display: 'flex', alignItems: 'flex-end', gap: barW * 0.5}}>
      {items.map((item, i) => {
        const inF = item.revealSec != null ? sec2f(item.revealSec, fps) : sF + 10 + i * 6;
        const g = spring({
          frame: Math.max(0, frame - inF),
          fps,
          config: m.springs?.enter ?? {damping: 14, stiffness: 170, mass: 0.8},
        });
        const h = Math.max(4, chartH * ((item.value ?? 1) / maxV) * g);
        const v = countUp(frame, inF, fps, item.value ?? 0, 0, 0.9);
        const label = `${item.prefix ?? ''}${v.toLocaleString('en-US')}${item.suffix ?? ''}`;
        return (
          <div key={i} style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12}}>
            <span
              style={{
                fontFamily: style.headlineFamily,
                fontWeight: 700,
                fontSize: height * 0.027,
                color: '#FFFFFF',
                fontVariantNumeric: 'tabular-nums',
                opacity: g,
                textShadow: `0 0 14px ${hexA(cyan, 0.5)}`,
              }}
            >
              {label}
            </span>
            <div
              style={{
                width: barW,
                height: h,
                borderRadius: 9,
                background: `linear-gradient(180deg, ${cyan} 0%, ${accent} 70%, ${hexA(secondary, 0.9)} 100%)`,
                boxShadow: `0 -8px 26px ${hexA(cyan, 0.5)}, 0 0 16px ${hexA(accent, 0.35)}`,
                position: 'relative',
              }}
            >
              {/* bright edge glow riding the top of the bar */}
              <div
                style={{
                  position: 'absolute',
                  top: -3,
                  left: 2,
                  right: 2,
                  height: 7,
                  borderRadius: 8,
                  background: '#FFFFFF',
                  opacity: 0.5 * g,
                  filter: 'blur(4px)',
                }}
              />
            </div>
            <span
              style={{
                fontFamily: style.bodyFamily,
                fontSize: height * 0.019,
                letterSpacing: '0.14em',
                color: 'rgba(255,255,255,0.75)',
                whiteSpace: 'nowrap',
              }}
            >
              {item.text}
            </span>
          </div>
        );
      })}
    </div>
  );
};

