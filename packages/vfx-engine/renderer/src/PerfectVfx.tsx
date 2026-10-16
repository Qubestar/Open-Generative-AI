import {AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {resolveStyle} from './theme';
import {sec2f, lifecycle} from './motion';
import {CtaBanner} from './components/CtaBanner';
import {SubscribeCta} from './components/SubscribeCta';
import {ConceptSplit} from './components/ConceptSplit';
import {Concept75} from './components/Concept75';
import {ConceptFullscreen} from './components/ConceptFullscreen';
import {ConceptOverlay} from './components/ConceptOverlay';
import {Grain} from './components/Grain';
import {canvasClass} from './layout';

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// Main composition. The spec (Edit Decision Spec JSON) arrives as input props.
// The footage is a layer driven by the LAYOUT ENGINE:
//  - split-screen: footage slides right into the 50 percent slot (panel covers the left)
//  - 75-split: footage shrinks into a rounded portrait card on the right (field renders UNDER it)
//  - full-screen: footage stays put; the opaque themed comp blooms over it (audio continues)
// One spring drives footage + panel together so they read as one surface.
export const PerfectVfx = (spec: any) => {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const style = resolveStyle(spec);
  const portrait = canvasClass(width, height) === 'portrait';
  const events: any[] = spec.events ?? [];

  const active = (e: any) => {
    const sF = sec2f(e.startSec, fps);
    const eF = sec2f(e.endSec, fps);
    return frame >= sF - 1 && frame <= eF; // exit completes AT eF (cut-synced); nothing may bleed past it
  };

  // ---- footage camera: sub-perceptual life + push-in during graphic holds
  // + a 2-frame impact dip on every graphic ENTER. Static-on-static is the
  // amateur tell WHILE a graphic is on; between events the footage is
  // BIT-EXACT source pixels (parity law: the section must drop back onto the
  // user's timeline frame-perfect, and the PSNR gate measures ~45dB+ on
  // no-overlay segments). Everything is gated by the events' own lifecycle p,
  // so camera life fades in/out with the graphics and never pops on a cut.
  let excess = 0;
  let pMax = 0;
  for (const e of events) {
    const sF = sec2f(e.startSec, fps);
    const eF = sec2f(e.endSec, fps);
    if (eF <= sF) continue;
    const life = lifecycle(frame, fps, sF, eF, style.theme.motion.springs, style.theme.motion.outMs);
    pMax = Math.max(pMax, life.p);
    if (frame >= sF && frame <= eF) {
      excess += 0.02 * ((frame - sF) / (eF - sF)) * life.p; // slow Ken Burns push across the hold, fading with the exit
      const dip =
        frame <= sF + 6
          ? 0.005 * (frame <= sF + 2 ? (frame - sF) / 2 : 1 - (frame - sF - 2) / 4)
          : 0;
      excess -= dip;
    }
  }
  const cam = 1 + pMax * (0.008 + 0.004 * Math.sin(frame / 240)) + excess;

  // ---- layout engine: compute the footage container + inner video transform
  // splitP drives the backdrop plate (see below); 0 whenever no split-screen
  // is docking, which keeps clean stretches bit-exact.
  let splitP = 0;
  let containerStyle: React.CSSProperties = {left: 0, top: 0, width, height};
  let innerStyle: React.CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 0,
    width,
    height,
    // Identity transform is omitted entirely so clean stretches stay bit-exact
    // (no resample pass on the source pixels).
    transform: cam === 1 ? undefined : `scale(${cam})`,
    transformOrigin: '50% 50%',
  };

  const layoutEvt = events.find(
    (e) =>
      e.move === 'CONCEPT_GRAPHIC' &&
      (e.payload?.variant === 'split-screen' || e.payload?.variant === '75-split') &&
      active(e)
  );

  if (layoutEvt) {
    const sF = sec2f(layoutEvt.startSec, fps);
    const eF = sec2f(layoutEvt.endSec, fps);
    const life = lifecycle(frame, fps, sF, eF, style.theme.motion.springs, style.theme.motion.outMs);
    const p = life.p;

    if (layoutEvt.payload.variant === 'split-screen') {
      if (portrait) {
        // Portrait keeps the creator full-bleed. The composition becomes a
        // bottom stage instead of squeezing a face into half a narrow canvas.
        // ConceptSplit owns that stage and applies the platform safe zone.
        containerStyle = {left: 0, top: 0, width, height};
        innerStyle = {position: 'absolute', left: 0, top: 0, width, height};
      } else {
      // Footage slides right so the subject centers in the right HALF (50/50).
      // The container is ALSO clipped to the panel's moving right edge
      // (ConceptSplit puts it at width*0.5*p, so these are the same x at every
      // p and meet with no gap). Without the clip the footage kept bleeding on
      // under the translucent panel while the vacated strip stayed empty, so
      // the glass sampled sharp footage on one side and bare background on the
      // other: one surface, two backdrops, with a hard seam between them.
      // dock, not p: the clip edge must land exactly on its target and stay
      // there. ConceptSplit puts the panel's right edge on the same number.
      splitP = life.dock;
      const clipL = width * 0.5 * life.dock;
      containerStyle = {left: clipL, top: 0, width: width - clipL, height};
      // Inner left cancels the container offset, so the video's ABSOLUTE
      // position is exactly what it was before the clip existed.
      innerStyle = {
        position: 'absolute',
        left: -clipL,
        top: 0,
        width,
        height,
        transform: `translateX(${width * 0.25 * life.dock}px)`,
      };
      }
    } else {
      // 75-split: full frame shrinks into a rounded portrait card, right side.
      // A portrait source stays a portrait card with its aspect ratio intact,
      // centered above a bottom content stage. Landscape retains the original
      // right-side 75/25 composition.
      // Keep portrait cards below the top platform chrome and leave a clean
      // lower stage for the thesis. Because the source and canvas share the
      // same aspect ratio, equal width/height factors preserve the source
      // crop exactly.
      const cw = width * (portrait ? 0.38 : 0.225);
      const ch = height * (portrait ? 0.38 : 0.66);
      const cx = width * (portrait ? 0.31 : 0.72);
      const cy = height * (portrait ? 0.13 : 0.17);
      const cW = lerp(width, cw, p);
      const cH = lerp(height, ch, p);
      const cX = lerp(0, cx, p);
      const cY = lerp(0, cy, p);
      const scale = Math.max(cW / width, cH / height); // cover-fit, no distortion
      const vw = width * scale;
      const vh = height * scale;
      containerStyle = {
        left: cX,
        top: cY,
        width: cW,
        height: cH,
        borderRadius: 26 * p,
        border: p > 0.4 ? `1.5px solid rgba(255,255,255,${0.35 * p})` : 'none',
        boxShadow: p > 0.4 ? `0 0 34px rgba(0,0,0,${0.55 * p}), 0 0 22px ${p * 0.25 > 0 ? 'rgba(77,225,255,0.22)' : 'transparent'}` : 'none',
      };
      innerStyle = {position: 'absolute', left: (cW - vw) / 2, top: (cH - vh) / 2, width: vw, height: vh};
    }
  }

  const render = (e: any) => {
    switch (e.move) {
      case 'CTA_BANNER':
        return <CtaBanner key={e.id} evt={e} style={style} spec={spec} />;
      case 'SUBSCRIBE_CTA':
        return <SubscribeCta key={e.id} evt={e} style={style} spec={spec} />;
      case 'CONCEPT_GRAPHIC':
        if (e.payload?.variant === 'split-screen') return <ConceptSplit key={e.id} evt={e} style={style} spec={spec} />;
        if (e.payload?.variant === 'full-screen') return <ConceptFullscreen key={e.id} evt={e} style={style} spec={spec} />;
        if (e.payload?.variant === 'overlay') return <ConceptOverlay key={e.id} evt={e} style={style} spec={spec} />;
        return null; // 75-split renders below the footage, handled separately
      default:
        return null;
    }
  };

  const activeEvents = events.filter(active);
  const under = activeEvents.filter((e) => e.move === 'CONCEPT_GRAPHIC' && e.payload?.variant === '75-split');
  const over = activeEvents.filter((e) => !(e.move === 'CONCEPT_GRAPHIC' && e.payload?.variant === '75-split'));

  return (
    <AbsoluteFill style={{backgroundColor: style.colors.void ?? '#000000'}}>
      {/* BACKDROP FIELD (split-screen only): a STATIC brand gradient behind the
          docked panel. The panel is translucent, and the footage is clipped to
          its right edge, so without this the vacated strip fell through to the
          flat void colour and read as a black slab with a seam.

          This was a live blurred copy of the footage at first, which is the
          obvious "glass refracts the real scene" answer. It is WRONG here: a
          second OffthreadVideo means two independent decoders on one file, and
          they drop and mis-deliver frames against each other. On playback the
          panel visibly flickered as the plate lost frames, and the contention
          made the main footage skip. A single still always resolves, so it
          only showed up in motion. One decoder per composition: if a surface
          needs the footage behind it, derive it from the ONE video element,
          never open a second. */}
      {splitP > 0.001 ? (
        <AbsoluteFill
          style={{
            background: `linear-gradient(155deg, ${style.colors.secondary ?? style.colors.accent ?? '#101018'} 0%, ${
              style.colors.void ?? '#000000'
            } 58%, ${style.colors.accent ?? style.colors.secondary ?? '#101018'} 100%)`,
          }}
        />
      ) : null}

      {/* 75-split fields live UNDER the footage card */}
      {under.map((e) => (
        <Concept75 key={e.id} evt={e} style={style} spec={spec} />
      ))}

      <div style={{position: 'absolute', overflow: 'hidden', ...containerStyle}}>
        {/* toneMapped=false: pass source pixels through without Chrome's display
            color transform (default true adds a midtone gamma lift, ~2 luma
            codes, caught by the PSNR parity gate). */}
        <OffthreadVideo src={staticFile('src.mp4')} toneMapped={false} style={innerStyle as any} />
      </div>

      {over.map(render)}

      {style.theme.atmosphere?.grain ? <Grain /> : null}
    </AbsoluteFill>
  );
};
