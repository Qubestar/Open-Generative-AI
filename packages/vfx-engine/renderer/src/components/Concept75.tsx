import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {sec2f, lifecycle, payoffPulse, lastReveal} from '../motion';
import {Icon} from './Icons';
import {BarChart} from './BarChart';
import {Statement} from './Statement';
import {hexA, materials, type Style} from '../theme';
import {canvasClass, safeBox, shortSide} from '../layout';

// 75-split FIELD layer: themed textured background + big content on the left
// ~65 percent. Renders UNDER the footage layer; PerfectVfx's layout engine
// shrinks the footage into the rounded portrait card on the right.
// Kinds: statement (big claim), icon rows, chart, table.
export const Concept75 = ({evt, style, spec}: {evt: any; style: Style; spec: any}) => {
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

  const items: any[] = evt.payload?.items ?? [];
  const eyebrow: string = evt.payload?.eyebrow ?? '';
  const kind: string = evt.payload?.kind ?? 'list';
  const isChart = kind === 'chart';
  const isStatement = kind === 'statement';
  const rowFont = unit * (portrait ? 0.043 : 0.048);
  const pulse = payoffPulse(frame, lastReveal(items, fps));

  return (
    <AbsoluteFill style={{opacity: life.p}}>
      {/* themed field */}
      <AbsoluteFill style={{backgroundColor: m.bgBase}} />
      <AbsoluteFill style={{background: m.bgLayers}} />
      {m.gridOpacity > 0 ? (
        <AbsoluteFill
          style={{
            backgroundImage: `repeating-linear-gradient(90deg, rgba(255,255,255,0.035) 0 1px, transparent 1px 110px), repeating-linear-gradient(0deg, rgba(255,255,255,0.035) 0 1px, transparent 1px 110px)`,
            opacity: m.gridOpacity,
          }}
        />
      ) : null}

      {/* content column, left ~65 percent, vertically centered */}
      <div
        style={{
          position: 'absolute',
          left: portrait ? safe.left : width * 0.055,
          top: portrait ? height * 0.54 : 0,
          width: portrait ? safe.width : width * 0.62,
          height: portrait ? height * 0.24 : '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: unit * (portrait ? 0.026 : 0.05),
          transform: `scale(${1 + 0.012 * pulse})`,
          transformOrigin: portrait ? '50% 50%' : '40% 50%',
        }}
      >
        {eyebrow ? (
          <div style={{display: 'flex', alignItems: 'center', gap: 16, opacity: life.enter}}>
            <div
              style={{
                width: 13,
                height: 13,
                borderRadius: 999,
                background: m.glowA,
                boxShadow: m.isFlat ? 'none' : `0 0 14px ${hexA(m.glowA, 0.8)}`,
              }}
            />
            <span
              style={{
                fontFamily: style.bodyFamily,
                fontSize: unit * 0.022,
                letterSpacing: '0.32em',
                color: m.isFlat ? ((style.colors as any).ink ?? '#1F1E1D') : 'rgba(255,255,255,0.92)',
              }}
            >
              {eyebrow}
            </span>
          </div>
        ) : null}

        {isStatement ? (
          <Statement payload={evt.payload} style={style} m={m} sF={sF} fontPx={unit * (portrait ? 0.105 : 0.096)} maxLinePx={portrait ? safe.width : width * 0.62} align={portrait ? "center" : "left"} />
        ) : null}

        {isChart ? (
          <div style={{display: 'flex', alignItems: 'flex-end'}}>
            <BarChart evt={evt} style={style} chartHeightPct={0.42} />
          </div>
        ) : null}

        {isStatement || isChart
          ? null
          : items.map((item, i) => {
              const isSteps = kind === 'steps';
              const baseInF = sF + 8 + i * 5;
              const revealFDefault = item.revealSec != null ? sec2f(item.revealSec, fps) : baseInF + 6;
              // Steps rows enter ON their word (revealSec), not on a fixed
              // stagger: "item reveals sync to speech" applies to the row
              // itself here, so the sequence pays off step by step.
              const inF = isSteps ? Math.max(sF, revealFDefault - 3) : baseInF;
              const rowIn = spring({
                frame: Math.max(0, frame - inF),
                fps,
                config: mo.springs?.enter ?? {damping: 14, stiffness: 170, mass: 0.8},
              });
              const revealF = revealFDefault;
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
              const negOn = item.negated && frame >= revealF;
              const glassRow = (
                <div
                  key={isSteps ? undefined : i}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 26,
                    flex: isSteps ? 1 : undefined,
                    opacity: rowIn * (negOn ? 0.62 : 1),
                    filter: negOn ? 'saturate(0.35)' : 'none',
                    transform: `translateX(${(1 - rowIn) * -30}px) translateY(${(item.negated ? markS : 0) * 5}px) rotate(${(item.negated ? markS : 0) * 1.2}deg)`,
                    background: m.panelBg,
                    border: m.panelBorder,
                    borderRadius: m.radiusPx * 0.75,
                    padding: `${rowFont * 0.42}px ${rowFont * 0.6}px`,
                    backdropFilter: m.panelBlurPx ? `blur(${Math.min(m.panelBlurPx, 10)}px)` : undefined,
                    WebkitBackdropFilter: m.panelBlurPx ? `blur(${Math.min(m.panelBlurPx, 10)}px)` : undefined,
                    boxShadow: m.isFlat
                      ? '0 4px 18px rgba(31,30,29,0.08)'
                      : `0 0 24px ${hexA(i % 2 === 0 ? m.glowB : m.glowA, 0.14)}`,
                  }}
                >
                  <div
                    style={{
                      transform: `scale(${item.negated ? markS : 1})`,
                      flexShrink: 0,
                      display: 'flex',
                      filter: m.isFlat ? 'none' : `drop-shadow(0 0 ${7 + 3 * Math.sin(frame / 16)}px ${hexA(m.glowA, 0.45)})`,
                    }}
                  >
                    <Icon
                      name={item.negated ? 'x' : item.icon ?? 'check'}
                      size={rowFont * 0.75}
                      color={item.negated ? m.negationHot : m.glowA}
                      strokeWidth={item.negated ? 2.8 : 2.4}
                    />
                  </div>
                  <span
                    style={{
                      position: 'relative',
                      fontFamily: style.headlineFamily,
                      fontWeight: 700,
                      fontSize: rowFont,
                      letterSpacing: 1,
                      color: m.isFlat ? ((style.colors as any).ink ?? '#1F1E1D') : '#FFFFFF',
                      whiteSpace: portrait ? 'normal' : 'nowrap',
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {item.text}
                    {item.negated ? (
                      <span
                        style={{
                          position: 'absolute',
                          left: '-2%',
                          top: '50%',
                          width: `${strikeW * 1.04}%`,
                          height: Math.max(6, rowFont * 0.13),
                          background: m.negationHot,
                          borderRadius: 4,
                          boxShadow: m.isFlat ? 'none' : `0 0 14px ${hexA(m.negationHot, 0.8)}`,
                          transform: 'translateY(-50%) rotate(-1.2deg)',
                        }}
                      />
                    ) : null}
                  </span>
                </div>
              );
              if (!isSteps) return glassRow;

              // Steps upgrade: ghost index numeral lane + glowing connector
              // spine drawing down toward the next step as its word approaches.
              // Purely additive; list/list-strike rows are untouched.
              const ink = (style.colors as any).ink ?? '#1F1E1D';
              const numeralPx = rowFont * 2.1;
              const nextRevealF =
                items[i + 1] != null
                  ? items[i + 1].revealSec != null
                    ? sec2f(items[i + 1].revealSec, fps)
                    : sF + 8 + (i + 1) * 5 + 6
                  : null;
              const segGrow =
                nextRevealF != null
                  ? interpolate(frame, [nextRevealF - 14, nextRevealF - 2], [0, 1], {
                      extrapolateLeft: 'clamp',
                      extrapolateRight: 'clamp',
                    })
                  : 0;
              return (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: rowFont * 0.55,
                    position: 'relative',
                  }}
                >
                  {nextRevealF != null ? (
                    <div
                      style={{
                        position: 'absolute',
                        left: rowFont * 0.85 - 2,
                        top: '50%',
                        width: 4,
                        height: numeralPx + height * 0.05,
                        transform: `scaleY(${segGrow})`,
                        transformOrigin: 'top',
                        background: `linear-gradient(180deg, ${hexA(m.glowA, 0.75)}, ${hexA(m.glowB, 0.45)})`,
                        borderRadius: 3,
                        boxShadow: m.isFlat ? 'none' : `0 0 12px ${hexA(m.glowA, 0.5)}`,
                        opacity: 0.85,
                        zIndex: 0,
                      }}
                    />
                  ) : null}
                  <div
                    style={{
                      width: rowFont * 1.7,
                      flexShrink: 0,
                      textAlign: 'center',
                      fontFamily: style.headlineFamily,
                      fontWeight: 700,
                      fontSize: numeralPx,
                      lineHeight: 1,
                      color: m.isFlat ? hexA(ink, 0.15) : hexA(m.glowA, 0.32),
                      textShadow: m.isFlat ? 'none' : `0 0 18px ${hexA(m.glowA, 0.35)}`,
                      opacity: rowIn,
                      transform: `scale(${0.7 + 0.3 * rowIn})`,
                      zIndex: 1,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {String(i + 1).padStart(2, '0')}
                  </div>
                  {glassRow}
                </div>
              );
            })}
      </div>
    </AbsoluteFill>
  );
};
