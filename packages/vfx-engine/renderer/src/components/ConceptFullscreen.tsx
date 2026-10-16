import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {sec2f, lifecycle, payoffPulse, lastReveal} from '../motion';
import {Icon} from './Icons';
import {BarChart} from './BarChart';
import {Statement} from './Statement';
import {hexA, materials, type Style} from '../theme';
import {canvasClass, safeBox, shortSide} from '../layout';

// Full-screen concept comp. Enters via a corner-anchored soft WIPE (not a
// crossfade), fills 70-80 percent of the safe area with an adaptive grid,
// ghost numerals, duotone icon chips, a designed negation state, and a glow
// hierarchy where exactly ONE element blooms at a time (the live reveal).
export const ConceptFullscreen = ({evt, style, spec}: {evt: any; style: Style; spec: any}) => {
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
  const title: string = evt.payload?.title ?? '';
  const eyebrow: string = evt.payload?.eyebrow ?? '';
  const kind: string = evt.payload?.kind ?? 'icon-cards';
  const isChart = kind === 'chart';
  const isSteps = kind === 'steps';
  const isStatement = kind === 'statement';
  const pulse = payoffPulse(frame, lastReveal(items, fps));
  const drift = Math.sin((frame - sF) / 240) * 22;

  // corner-anchored soft wipe from the theme's light corner (top-left)
  const wipeStop = interpolate(life.enter, [0, 1], [0, 170]);
  const mask = `linear-gradient(115deg, rgba(0,0,0,1) 0%, rgba(0,0,0,1) ${Math.max(0, wipeStop - 22)}%, rgba(0,0,0,0) ${wipeStop}%)`;

  // glow hierarchy: the bloom follows the live reveal; everything else rests
  const inFs = items.map((_, i) => sF + 10 + i * 5);
  const revealFs = items.map((it, i) => (it.revealSec != null ? sec2f(it.revealSec, fps) : inFs[i] + 6));
  let activeIdx = -1;
  revealFs.forEach((rf, i) => {
    if (frame >= rf) activeIdx = i;
  });
  if (activeIdx === -1) inFs.forEach((f, i) => {
    if (frame >= f) activeIdx = i;
  });
  const glowMul = (i: number) => (i === activeIdx ? 1 : 0.3);

  const n = Math.max(items.length, 1);
  const cardPct = n === 2 ? 0.3 : n === 3 ? 0.26 : 0.3; // landscape: 4+ wraps 2x2
  const gapPct = 0.025;

  return (
    <AbsoluteFill
      style={{
        opacity: 1 - life.exit,
        maskImage: mask,
        WebkitMaskImage: mask,
      }}
    >
      {/* themed textured background */}
      <AbsoluteFill style={{backgroundColor: m.bgBase}} />
      <AbsoluteFill style={{transform: `translateX(${drift}px)`, background: m.bgLayers}} />
      {m.gridOpacity > 0 && !m.perspectiveFloor ? (
        <AbsoluteFill
          style={{
            backgroundImage: `repeating-linear-gradient(90deg, rgba(255,255,255,0.05) 0 1px, transparent 1px 120px), repeating-linear-gradient(0deg, rgba(255,255,255,0.05) 0 1px, transparent 1px 120px)`,
            opacity: m.gridOpacity,
          }}
        />
      ) : null}
      {m.perspectiveFloor ? (
        <div
          style={{
            position: 'absolute',
            left: '-20%',
            right: '-20%',
            bottom: '-14%',
            height: '46%',
            transform: 'perspective(700px) rotateX(62deg)',
            transformOrigin: '50% 100%',
            backgroundImage: `repeating-linear-gradient(90deg, rgba(255,255,255,0.09) 0 1.5px, transparent 1.5px 90px), repeating-linear-gradient(0deg, rgba(255,255,255,0.09) 0 1.5px, transparent 1.5px 70px)`,
            maskImage: 'linear-gradient(to top, rgba(0,0,0,0.75), transparent 85%)',
            WebkitMaskImage: 'linear-gradient(to top, rgba(0,0,0,0.75), transparent 85%)',
            opacity: m.gridOpacity,
          }}
        />
      ) : null}

      {isStatement ? (
        <AbsoluteFill
          style={{
            alignItems: 'center',
            justifyContent: 'center',
            padding: `${safe.top}px ${safe.right}px ${safe.bottom}px ${safe.left}px`,
            transform: `scale(${1 + 0.012 * pulse})`,
          }}
        >
          <Statement payload={evt.payload} style={style} m={m} sF={sF} fontPx={unit * 0.105} maxLinePx={safe.width} align="center" />
        </AbsoluteFill>
      ) : (
        <AbsoluteFill
          style={{
            alignItems: 'center',
            justifyContent: 'center',
            gap: unit * (portrait ? 0.028 : 0.045),
            transform: `scale(${1 + 0.012 * pulse})`,
            flexDirection: 'column',
            padding: `${safe.top}px ${safe.right}px ${safe.bottom}px ${safe.left}px`,
          }}
        >
          {eyebrow ? (
            <span
              style={{
                fontFamily: style.bodyFamily,
                fontSize: unit * 0.022,
                letterSpacing: '0.32em',
                color: m.isFlat ? ((style.colors as any).ink ?? '#1F1E1D') : 'rgba(255,255,255,0.8)',
                opacity: interpolate(frame, [sF + 2, sF + 10], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}),
              }}
            >
              {eyebrow}
            </span>
          ) : null}
          {title ? (
            <div style={{filter: m.isFlat ? 'none' : `drop-shadow(0 0 30px ${hexA(m.glowB, activeIdx === -1 ? 0.5 : 0.2)})`}}>
              <span
                style={{
                  fontFamily: style.headlineFamily,
                  fontWeight: 700,
                  fontSize: unit * (portrait ? 0.1 : 0.115),
                  letterSpacing: 3,
                  lineHeight: 1,
                  display: 'block',
                  maxWidth: safe.width,
                  textAlign: 'center',
                  overflowWrap: 'anywhere',
                  ...(m.titleGradient
                    ? {backgroundImage: m.titleGradient, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent'}
                    : {color: (style.colors as any).ink ?? '#1F1E1D'}),
                  opacity: interpolate(frame, [sF + 4, sF + 12], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}),
                }}
              >
                {title}
              </span>
            </div>
          ) : null}

          {isChart ? <BarChart evt={evt} style={style} chartHeightPct={0.4} /> : null}

          {isChart ? null : (
            <div
              style={{
                display: 'flex',
                flexWrap: portrait ? 'nowrap' : 'wrap',
                flexDirection: portrait ? 'column' : 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: portrait ? unit * 0.024 : width * gapPct,
                maxWidth: safe.width,
                width: safe.width,
                paddingTop: unit * 0.01,
              }}
            >
              {items.map((item, i) => {
                const s = spring({frame: Math.max(0, frame - inFs[i]), fps, config: mo.springs?.enter ?? {damping: 14, stiffness: 170, mass: 0.8}});
                const revealF = revealFs[i];
                const negOn = item.negated && frame >= revealF;
                const ns = item.negated
                  ? spring({frame: Math.max(0, frame - revealF), fps, config: {damping: 12, stiffness: 220, mass: 0.7}})
                  : 0;
                const strikeW = item.negated
                  ? interpolate(frame, [revealF, revealF + 10], [0, 100], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})
                  : 0;
                const keptPulse =
                  !item.negated && item.revealSec != null
                    ? 1 + 0.04 * Math.sin(Math.min(Math.max((frame - revealF) / 10, 0), 1) * Math.PI)
                    : 1;
                const g = glowMul(i);
                return (
                  <div
                    key={i}
                    style={{
                      width: portrait ? safe.width * 0.9 : width * cardPct,
                      minHeight: portrait ? unit * 0.19 : undefined,
                      padding: portrait
                        ? `${unit * 0.025}px ${unit * 0.035}px`
                        : `${height * 0.055}px ${width * 0.014}px ${height * 0.045}px`,
                      transform: `translateY(${(1 - s) * 46 + ns * 6}px) rotate(${ns * 1.5}deg) scale(${keptPulse})`,
                      opacity: s * (negOn ? 0.62 : 1),
                      filter: negOn ? 'saturate(0.35)' : 'none',
                      background: m.panelBg,
                      border: m.panelBorder,
                      borderRadius: m.radiusPx,
                      backdropFilter: m.panelBlurPx ? `blur(${m.panelBlurPx}px)` : undefined,
                      WebkitBackdropFilter: m.panelBlurPx ? `blur(${m.panelBlurPx}px)` : undefined,
                      boxShadow: m.isFlat
                        ? '0 6px 24px rgba(31,30,29,0.10)'
                        : `0 0 ${30 * g}px ${hexA(i % 2 === 0 ? m.glowB : m.glowA, 0.26 * g)}, 0 18px 50px rgba(0,0,0,0.5)`,
                      display: 'flex',
                      flexDirection: portrait ? 'row' : 'column',
                      alignItems: 'center',
                      gap: unit * (portrait ? 0.035 : 0.032),
                      position: 'relative',
                      overflow: 'hidden',
                    }}
                  >
                    {/* ghost numeral */}
                    <span
                      style={{
                        position: 'absolute',
                        top: portrait ? -unit * 0.02 : -height * 0.045,
                        right: portrait ? unit * 0.012 : -width * 0.004,
                        fontFamily: style.headlineFamily,
                        fontWeight: 700,
                        fontSize: unit * (portrait ? 0.14 : 0.21),
                        lineHeight: 1,
                        color: m.isFlat ? ((style.colors as any).ink ?? '#1F1E1D') : '#FFFFFF',
                        opacity: m.ghostNumeralOpacity,
                        pointerEvents: 'none',
                      }}
                    >
                      {i + 1}
                    </span>
                    {/* duotone icon chip; the X lands ON the icon when negated */}
                    <div
                      style={{
                        position: 'relative',
                        background: hexA(m.glowA, negOn ? 0.07 : 0.14),
                        borderRadius: 20,
                        padding: unit * 0.024,
                        display: 'flex',
                        filter: !m.isFlat && g === 1 && !negOn ? `drop-shadow(0 0 12px ${hexA(m.glowA, 0.55)})` : 'none',
                      }}
                    >
                      <Icon name={item.icon} size={unit * (portrait ? 0.07 : 0.095)} color={negOn ? 'rgba(255,255,255,0.4)' : m.glowA} />
                      {item.negated ? (
                        <div style={{position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `scale(${ns})`}}>
                          <Icon name="x" size={unit * (portrait ? 0.065 : 0.085)} color={m.negationHot} strokeWidth={3.4} />
                        </div>
                      ) : null}
                    </div>
                    <span
                      style={{
                        position: 'relative',
                        fontFamily: style.headlineFamily,
                        fontWeight: 700,
                        fontSize: unit * (portrait ? 0.036 : 0.034),
                        letterSpacing: 1,
                        color: m.isFlat ? ((style.colors as any).ink ?? '#1F1E1D') : '#FFFFFF',
                        textAlign: 'center',
                        whiteSpace: portrait ? 'normal' : 'nowrap',
                        overflowWrap: 'anywhere',
                      }}
                    >
                      {item.text}
                      {item.negated ? (
                        <span
                          style={{
                            position: 'absolute',
                            left: '-3%',
                            top: '50%',
                            width: `${strikeW * 1.06}%`,
                            height: Math.max(6, height * 0.007),
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
              })}
            </div>
          )}
        </AbsoluteFill>
      )}

      {/* steps connectors */}
      {isSteps && items.length > 1 && !portrait ? (
        <AbsoluteFill style={{pointerEvents: 'none'}}>
          {items.slice(0, -1).map((_, i) => {
            const cardW = cardPct * 100;
            const gapW = gapPct * 100;
            const startPct = (100 - (n * cardW + (n - 1) * gapW)) / 2;
            const drawF = inFs[i + 1] - 4;
            const w = interpolate(frame, [drawF, drawF + 8], [0, gapW], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
            return (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  top: '58%',
                  left: `${startPct + cardW + i * (cardW + gapW)}%`,
                  width: `${w}%`,
                  height: 3.5,
                  borderRadius: 4,
                  background: m.glowA,
                  boxShadow: m.isFlat ? 'none' : `0 0 12px ${hexA(m.glowA, 0.8)}`,
                }}
              />
            );
          })}
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
};
