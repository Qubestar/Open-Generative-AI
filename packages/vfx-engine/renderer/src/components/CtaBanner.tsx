import {AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {sec2f, lifecycle} from '../motion';
import {hexA, type Style} from '../theme';
import {safeInsets, shortSide} from '../layout';

// Slim conversion banner: slides in from its edge, holds long with a subtle
// glow pulse and one shimmer sweep, slides away fast.
// payload.icon: download | link | calendar | comment | none
// payload.hero: true = the "look at this one" treatment (brighter accent
//   border, layered aurora glow, faster brighter shimmer, gentle scale pulse).
// evt.position: bottom-center (default) | lower-third (== bottom) | lower-left
//   | upper-left (endscreen-safe corner for outro windows).
export const CtaBanner = ({evt, style, spec}: {evt: any; style: Style; spec: any}) => {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const m = style.theme.motion;
  const safe = safeInsets(spec, width, height);
  const unit = shortSide(width, height);
  const sF = sec2f(evt.startSec, fps);
  const eF = sec2f(evt.endSec, fps);
  const life = lifecycle(frame, fps, sF, eF, m.springs, m.outMs);

  const accent = style.colors.accent ?? '#4DE1FF';
  const glow = style.colors.secondary ?? accent;
  const hero: boolean = evt.payload?.hero === true;
  const pos: string = evt.position ?? 'bottom-center';
  const isUpper = pos === 'upper-left';
  const isLeft = pos === 'upper-left' || pos === 'lower-left';
  // Endscreen-safe corner pills read smaller; hero reads a touch bigger.
  const fontSize = Math.round(unit * (isUpper ? 0.026 : hero ? 0.034 : 0.03));

  // hero pulses stronger and a hair faster; standard is the original subtle glow
  const restPulse = hero
    ? 0.6 + 0.32 * Math.sin((frame - sF) / 13)
    : 0.42 + 0.12 * Math.sin((frame - sF) / 16);
  const heroScale = hero ? 1 + 0.014 * Math.sin((frame - sF) / 15) : 1;

  // shimmer sweep: hero repeats every ~2.2s and is brighter; standard = one pass
  const shimmerPeriod = 66;
  const shimmerLocal = hero
    ? (frame - sF) % shimmerPeriod
    : Math.min(frame - sF - 60, shimmerPeriod);
  const shimmerX = interpolate(shimmerLocal, [0, 30], [-120, 240], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const shimmerAlpha = hero ? 0.28 : 0.16;

  const enterSign = isUpper ? -1 : 1;

  const heroBorder = hero ? `1.6px solid ${hexA(accent, 0.7)}` : '1px solid rgba(255,255,255,0.12)';
  const heroShadow = hero
    ? `0 0 ${26 + 16 * (restPulse - 0.6)}px ${hexA(accent, restPulse)}, 0 0 60px ${hexA(glow, restPulse * 0.6)}, 0 12px 40px rgba(0,0,0,0.55)`
    : `0 0 22px ${hexA(glow, restPulse)}, 0 10px 34px rgba(0,0,0,0.5)`;

  return (
    <AbsoluteFill
      style={{
        alignItems: isLeft ? 'flex-start' : 'center',
        justifyContent: isUpper ? 'flex-start' : 'flex-end',
        paddingBottom: isUpper ? undefined : safe.bottom,
        paddingTop: isUpper ? safe.top : undefined,
        paddingLeft: isLeft ? safe.left : undefined,
        paddingRight: safe.right,
        opacity: 1 - life.exit,
      }}
    >
      <div
        style={{
          transform: `translateY(${enterSign * (1 - life.enter) * 140}px) scale(${heroScale})`,
          position: 'relative',
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          gap: fontSize * 0.6,
          background: style.colors.panel ?? 'rgba(10,7,20,0.72)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          border: heroBorder,
          borderRadius: 999,
          padding: `${fontSize * 0.5}px ${fontSize * 1.2}px`,
          boxShadow: heroShadow,
        }}
      >
        <BannerIcon name={evt.payload?.icon ?? 'download'} size={fontSize * 1.05} color={accent} />
        <span
          style={{
            fontFamily: style.headlineFamily,
            fontWeight: 700,
            fontSize,
            letterSpacing: 1.5,
            color: style.colors.panelText ?? '#FFF',
            whiteSpace: 'normal',
            overflowWrap: 'anywhere',
            maxWidth: width - safe.left - safe.right - fontSize * 4,
          }}
        >
          {evt.payload?.text ?? ''}
        </span>
        {/* shimmer sweep */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${shimmerX}%`,
            width: '18%',
            background: `linear-gradient(105deg, transparent, rgba(255,255,255,${shimmerAlpha}), transparent)`,
            pointerEvents: 'none',
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

const BannerIcon = ({name, size, color}: {name: string; size: number; color: string}) => {
  if (name === 'none') return null;
  const common = {
    stroke: color,
    strokeWidth: 2.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none',
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{flexShrink: 0}}>
      {name === 'download' ? (
        <>
          <path d="M12 3v10m0 0l-4-4m4 4l4-4" {...common} />
          <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" {...common} />
        </>
      ) : null}
      {name === 'link' ? (
        <>
          <path d="M9 15l6-6" {...common} />
          <path d="M8.5 11.5l-2 2a3.5 3.5 0 005 5l2-2" {...common} />
          <path d="M15.5 12.5l2-2a3.5 3.5 0 00-5-5l-2 2" {...common} />
        </>
      ) : null}
      {name === 'calendar' ? (
        <>
          <rect x="3.5" y="5" width="17" height="15" rx="2.5" {...common} />
          <path d="M3.5 9.5h17M8 3v4M16 3v4M8.5 14l2.5 2.5L16 12" {...common} />
        </>
      ) : null}
      {name === 'comment' ? (
        <path d="M4 5h16v11H9l-4 3v-3H4z" {...common} />
      ) : null}
    </svg>
  );
};
