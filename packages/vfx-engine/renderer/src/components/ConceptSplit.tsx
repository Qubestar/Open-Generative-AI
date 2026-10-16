import {Statement} from './Statement';
import {BarChart} from './BarChart';
import {interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {sec2f, lifecycle, payoffPulse, lastReveal} from '../motion';
import {Icon} from './Icons';
import {hexA, materials, type Style} from '../theme';
import {canvasClass, safeBox, shortSide} from '../layout';

// Split-screen ("the 50"): full-height THEMED panel slides in from the left to
// occupy 50 percent; the footage slides right on the SAME lifecycle (one
// motion, two surfaces). Diagram rows: mark + text + icon chip, vertically
// centered, strikes drawing ON the spoken word. Materials come from the theme.
export const ConceptSplit = ({evt, style, spec}: {evt: any; style: Style; spec: any}) => {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const mo = style.theme.motion;
  const m = materials(style);
  const portrait = canvasClass(width, height) === 'portrait';
  const safe = safeBox(spec, width, height);
  const unit = shortSide(width, height);
  const sF = sec2f(evt.startSec, fps);
  const eF = sec2f(evt.endSec, fps);
  const life = lifecycle(frame, fps, sF, eF, mo.springs, mo.outMs);

  const panelW = width * 0.5;
  // The slab is built WIDER than its 50 percent slot, with the extra hanging
  // off the left of the frame. Only its right edge is meant to be seen moving;
  // the left edge must never come into view, whatever the spring does.
  const OVER = 140;
  const slabW = panelW + OVER;
  // dock (clamped to 1), not p: the right edge lands on panelW and stops,
  // matching the footage clip in PerfectVfx frame for frame. Raw p overshot,
  // so the slab slid past its slot and popped back, and while it was out there
  // its left edge lifted off the frame and showed what was behind it.
  const x = panelW * life.dock - slabW;
  const items: any[] = evt.payload?.items ?? [];
  const eyebrow: string = evt.payload?.eyebrow ?? '';
  // Dense panels (5+ rows) drop to a smaller row scale so a full checklist
  // fits the panel height without overflow.
  const dense = items.length >= 5;
  const rowFont = Math.round(unit * (dense ? 0.036 : 0.046));
  // rowsEnter: "reveal" = each row ENTERS on its revealSec word ("bullet pops
  // up as I explain it"); default keeps the original early-stagger + strike-
  // on-word storytelling (setup rows first, payoff strikes later).
  const syncRows = evt.payload?.rowsEnter === 'reveal';
  const pulse = payoffPulse(frame, lastReveal(items, fps));
  const textColor = m.isFlat ? ((style.colors as any).ink ?? '#1F1E1D') : '#FFFFFF';

  return (
    <div
      style={{
        position: 'absolute',
        left: portrait ? safe.left : 0,
        top: portrait ? height * 0.59 : 0,
        width: portrait ? safe.width : slabW,
        height: portrait ? height * 0.2 : '100%',
        transform: portrait
          ? `translateY(${(1 - life.dock) * height * 0.18}px) scale(${1 + 0.012 * pulse})`
          : `translateX(${x}px) scale(${1 + 0.012 * pulse})`,
        // Same ABSOLUTE pivot as before the slab was widened, so the payoff
        // pulse still scales about the point it always did.
        transformOrigin: portrait ? '50% 100%' : `${((OVER + panelW * 0.3) / slabW) * 100}% 50%`,
        background: m.isFlat
          ? m.bgBase
          : `linear-gradient(160deg, ${hexA(m.glowA, 0.1)} 0%, ${m.panelBg} 45%, ${hexA(m.glowB, 0.1)} 100%)`,
        // NO backdrop-filter. This element is TRANSLATED, and Chrome samples a
        // backdrop-filter's backdrop in the wrong coordinate space when it is:
        // the footage came through as a ghost of the subject roughly 1000px to
        // the left of the real one, drifting with every gesture. It used to be
        // hidden because real footage sat under the panel; once the footage is
        // clipped to the panel edge and the backdrop is a flat brand gradient,
        // the artifact is naked. Blurring a smooth gradient buys nothing, so
        // the filter is simply gone. The glass reads from the panel's own
        // translucent gradient, border and shadow instead.
        borderRight: portrait ? undefined : m.panelBorder,
        borderTop: portrait ? m.panelBorder : undefined,
        borderRadius: portrait ? m.radiusPx : undefined,
        // Shadows scale with dock so they are GONE the moment the slab is.
        // At dock 0 the slab sits fully off-frame but its right edge is at
        // x=0, and a 40px shadow spread kept spilling back into frame as a
        // dark strip down the left border, which then vanished on unmount and
        // read as a click.
        // The inset white light-sweep is also gone: it peaked at enter ~0.96,
        // several frames AFTER the slab had visually parked and exactly as the
        // first row animated in, which is what made the landing look choppy.
        boxShadow: m.isFlat
          ? `6px 0 30px rgba(31,30,29,${0.12 * life.dock})`
          : `6px 0 40px rgba(0,0,0,${0.5 * life.dock}), 2px 0 24px ${hexA(m.glowB, 0.28 * life.dock)}`,
        // Left padding absorbs the off-screen overhang, so content sits at the
        // same screen x it did before the slab was widened.
        padding: portrait
          ? `${unit * 0.045}px ${unit * 0.05}px`
          : `${height * 0.09}px ${panelW * 0.09}px ${height * 0.09}px ${panelW * 0.09 + OVER}px`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* eyebrow */}
      <div style={{display: 'flex', alignItems: 'center', gap: 14, opacity: life.enter}}>
        <div
          style={{
            width: 12,
            height: 12,
            borderRadius: 999,
            background: m.glowA,
            boxShadow: m.isFlat ? 'none' : `0 0 14px ${hexA(m.glowA, 0.8)}`,
            transform: `scale(${spring({frame: Math.max(0, frame - sF - 6), fps, config: {damping: 12, stiffness: 200, mass: 0.6}})})`,
          }}
        />
        <span
          style={{
            fontFamily: style.bodyFamily,
            fontSize: Math.round(unit * 0.021),
            letterSpacing: '0.3em',
            color: m.isFlat ? textColor : 'rgba(255,255,255,0.92)',
          }}
        >
          {eyebrow}
        </span>
      </div>

      {/* rows: vertically centered as a block */}
      <div style={{flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: unit * (dense ? 0.026 : 0.035)}}>
        {evt.payload.kind === 'statement' ? (
          <Statement payload={evt.payload} style={style} m={m} sF={sF} fontPx={unit * (portrait ? 0.09 : 0.09)} maxLinePx={portrait ? safe.width - unit * 0.1 : panelW * 0.78} align={portrait ? "center" : "left"} />
        ) : evt.payload.kind === 'chart' ? (
          <BarChart evt={evt} style={style} chartHeightPct={0.35} />
        ) : items.map((item, i) => {
          const staggerInF = sF + 8 + i * 5;
          const revealF = item.revealSec != null ? sec2f(item.revealSec, fps) : staggerInF + 6;
          const rowInF = syncRows ? Math.max(sF + 8, revealF - 3) : staggerInF;
          const rowIn = interpolate(frame, [rowInF, rowInF + 8], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
          const strikeW = item.negated
            ? interpolate(frame, [revealF, revealF + 10], [0, 100], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              })
            : 0;
          const markS = spring({
            frame: Math.max(0, frame - revealF),
            fps,
            config: {damping: 11, stiffness: 240, mass: 0.6},
          });
          const markRot = interpolate(frame, [revealF, revealF + 12], [-25, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
          const negOn = item.negated && frame >= revealF;
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 20,
                opacity: rowIn * (negOn ? 0.62 : 1),
                filter: negOn ? 'saturate(0.35)' : 'none',
                transform: `translateX(${(1 - rowIn) * -18}px) translateY(${(item.negated ? markS : 0) * 5}px)`,
                background: m.isFlat ? m.panelBg : 'rgba(255,255,255,0.08)',
                border: m.panelBorder,
                borderRadius: m.radiusPx * 0.7,
                padding: `${rowFont * 0.48}px ${rowFont * 0.6}px`,
              }}
            >
              <div
                style={{
                  transform: item.negated ? `scale(${markS}) rotate(${markRot}deg)` : undefined,
                  flexShrink: 0,
                  display: 'flex',
                  filter: m.isFlat ? 'none' : `drop-shadow(0 0 ${7 + 3 * Math.sin(frame / 16)}px ${hexA(m.glowA, 0.45)})`,
                }}
              >
                <Icon
                  name={item.negated ? 'x' : item.icon ?? 'check'}
                  size={rowFont * 0.78}
                  color={item.negated ? m.negationHot : m.glowA}
                  strokeWidth={item.negated ? 3.2 : 2.6}
                />
              </div>
              <span
                style={{
                  position: 'relative',
                  fontFamily: style.headlineFamily,
                  fontWeight: 700,
                  fontSize: rowFont,
                  letterSpacing: 1,
                  color: textColor,
                  whiteSpace: portrait ? 'normal' : 'nowrap',
                  overflowWrap: 'anywhere',
                  flex: 1,
                }}
              >
                {item.text}
                {item.negated ? (
                  <span
                    style={{
                      position: 'absolute',
                      left: '-2%',
                      top: '52%',
                      width: `${Math.min(strikeW, 100) * 1.02}%`,
                      height: Math.max(6, Math.round(rowFont * 0.13)),
                      background: m.negationHot,
                      borderRadius: 4,
                      boxShadow: m.isFlat ? 'none' : `0 0 12px ${hexA(m.negationHot, 0.8)}`,
                      transform: 'translateY(-4px) rotate(-1.2deg)',
                    }}
                  />
                ) : null}
              </span>
              {item.icon && item.negated ? (
                <div style={{flexShrink: 0, display: 'flex', opacity: 0.75}}>
                  <Icon name={item.icon} size={rowFont * 0.66} color={m.isFlat ? textColor : 'rgba(255,255,255,0.8)'} strokeWidth={2} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
};
