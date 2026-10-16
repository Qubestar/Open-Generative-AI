import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig, Easing} from 'remotion';
import {sec2f, lifecycle, wiggle} from '../motion';
import {hexA, type Style} from '../theme';
import {safeInsets, shortSide} from '../layout';

// The impact showcase: red button pops in with overshoot, cursor arcs onto the
// bell, click compresses + snaps back, ripple rings out, bell wiggles.
// YouTube red is functional and overrides the theme accent; chip stays themed.
export const SubscribeCta = ({evt, style, spec}: {evt: any; style: Style; spec: any}) => {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const m = style.theme.motion;
  const safe = safeInsets(spec, width, height);
  const unit = shortSide(width, height);
  const sF = sec2f(evt.startSec, fps);
  const eF = sec2f(evt.endSec, fps);
  const life = lifecycle(frame, fps, sF, eF, m.springs, m.outMs);

  // Click lands on the spoken ask (word-anchored via payload.clickSec);
  // fallback: shortly after enter. The button itself can hold much longer.
  const clickF = evt.payload?.clickSec != null ? sec2f(evt.payload.clickSec, fps) : sF + 15;
  const fontSize = Math.round(unit * 0.026);
  const chip = Math.round(fontSize * 1.9);
  const RED = '#FF0032';

  // press: compress to 0.94 then snap back
  const press = interpolate(frame, [clickF, clickF + 3, clickF + 10], [1, 0.94, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });

  // cursor arc: slides in from lower right, arriving right before the click
  const cT = interpolate(frame, [clickF - 11, clickF - 1], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  const cursorX = interpolate(cT, [0, 1], [width * 0.13, 0]);
  const cursorY = interpolate(cT, [0, 1], [height * 0.12, 0]) - Math.sin(cT * Math.PI) * 26;
  const cursorOut = interpolate(frame, [eF - 12, eF - 4], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // ripple from the click point
  const rippleS = interpolate(frame, [clickF, clickF + 15], [0, 1.7], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.quad),
  });
  const rippleO = interpolate(frame, [clickF, clickF + 15], [0.6, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // red glow flash on the click
  const flash = interpolate(frame, [clickF, clickF + 2, clickF + 10], [0, 0.8, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // the click has a CONSEQUENCE: the button flips to its subscribed state
  const subscribed = frame >= clickF + 4;
  const burstColors = [style.colors.pop ?? '#FFFFFF', style.colors.accent ?? '#FFFFFF'];

  const bellRot = wiggle(frame - clickF);
  const pop = spring({frame: Math.max(0, frame - sF), fps, config: m.springs?.enter ?? {damping: 14, stiffness: 170, mass: 0.8}});

  return (
    <AbsoluteFill
      style={{
        alignItems: 'center',
        justifyContent: 'flex-end',
        paddingBottom: safe.bottom,
        paddingLeft: safe.left,
        paddingRight: safe.right,
        opacity: 1 - life.exit,
      }}
    >
      <div style={{position: 'relative', display: 'flex', alignItems: 'center', gap: 14, transform: `scale(${pop})`}}>
        {/* red button */}
        <div
          style={{
            transform: `scale(${press})`,
            background: subscribed ? 'rgba(255,255,255,0.12)' : RED,
            border: subscribed ? '1.5px solid rgba(255,255,255,0.55)' : '1.5px solid rgba(255,255,255,0)',
            backdropFilter: subscribed ? 'blur(8px)' : undefined,
            WebkitBackdropFilter: subscribed ? 'blur(8px)' : undefined,
            borderRadius: 12,
            padding: `${fontSize * 0.5}px ${fontSize * 1.15}px`,
            boxShadow: `0 6px 22px rgba(0,0,0,0.45), 0 0 ${18 + flash * 30}px rgba(255,0,50,${0.25 + flash * 0.55})`,
          }}
        >
          <span
            style={{
              fontFamily: style.bodyFamily,
              fontWeight: 700,
              fontSize,
              letterSpacing: 2,
              color: '#FFFFFF',
            }}
          >
            {subscribed ? 'SUBSCRIBED' : 'SUBSCRIBE'}
          </span>
        </div>
        {/* themed bell chip */}
        <div
          style={{
            transform: `scale(${press})`,
            width: chip,
            height: chip,
            borderRadius: 12,
            background: style.colors.panel ?? 'rgba(10,7,20,0.72)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            border: '1px solid rgba(255,255,255,0.14)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: `0 0 16px ${hexA(style.colors.secondary ?? style.colors.accent, 0.35)}`,
            position: 'relative',
          }}
        >
          <svg
            width={chip * 0.58}
            height={chip * 0.58}
            viewBox="0 0 24 24"
            style={{transform: `rotate(${bellRot}deg)`, transformOrigin: '50% 15%'}}
          >
            <path
              d="M12 3a6 6 0 00-6 6v3.2L4.4 15a1 1 0 00.8 1.6h13.6a1 1 0 00.8-1.6L18 12.2V9a6 6 0 00-6-6z"
              fill="#FFFFFF"
            />
            <path d="M10 19a2 2 0 004 0" stroke="#FFFFFF" strokeWidth="1.8" fill="none" strokeLinecap="round" />
          </svg>
          {/* ripple */}
          <div
            style={{
              position: 'absolute',
              right: -chip * 0.18,
              bottom: -chip * 0.18,
              width: chip,
              height: chip,
              borderRadius: 999,
              border: '2.5px solid rgba(255,255,255,0.9)',
              transform: `scale(${rippleS})`,
              opacity: rippleO,
            }}
          />
          {/* particle micro-burst on the click (payoff punctuation) */}
          {Array.from({length: 7}, (_, i) => {
            const ang = (i / 7) * Math.PI * 2 + 0.4;
            const r = interpolate(frame, [clickF, clickF + 15], [6, 54], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
              easing: Easing.out(Easing.quad),
            });
            const op = interpolate(frame, [clickF, clickF + 15], [0.95, 0], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            });
            return (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  left: '50%',
                  top: '50%',
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: burstColors[i % 2],
                  opacity: frame >= clickF ? op : 0,
                  transform: `translate(-50%, -50%) translate(${Math.cos(ang) * r}px, ${Math.sin(ang) * r}px)`,
                }}
              />
            );
          })}
          {/* cursor */}
          <svg
            width={chip * 0.95}
            height={chip * 0.95}
            viewBox="0 0 24 24"
            style={{
              position: 'absolute',
              right: -chip * 0.34 + -cursorX * 0.0 - cursorX,
              bottom: -chip * 0.34 - cursorY,
              opacity: cursorOut,
              filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.6))',
            }}
          >
            <path d="M5 3l14 8.5-6.2 1.2L16 19l-2.8 1.4-3.2-6.4L5 18z" fill="#FFFFFF" stroke="#111" strokeWidth="1.1" />
          </svg>
        </div>
      </div>
    </AbsoluteFill>
  );
};
