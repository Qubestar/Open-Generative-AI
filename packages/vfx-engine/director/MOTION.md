# Motion System

How Perfect VFX moves. This is the choreography contract: the renderer implements exactly this, themes only change the FEEL (timing, springs, materials), never the choreography. Written against Remotion; the `remotion-best-practices` skill is the API reference.

## How motion works in Remotion (the 60-second version)

Remotion renders React frame by frame. There are no CSS transitions; every animated value is COMPUTED from the current frame number, which makes output deterministic (same spec in, same pixels out, every render).

Three primitives cover everything we do:

1. **`interpolate(frame, [start, end], [from, to], {easing})`** maps time to a value with an easing curve. Used for: strike lines drawing, ripples expanding, opacity, drifts.
2. **`spring({frame, fps, config})`** is a physics spring: mass, stiffness, damping. This is where FEEL comes from. Low damping = overshoot and punch (impact). High damping = smooth luxury glide (no bounce). Springs drive every entrance, exit, and press.
3. **`<Sequence from={frame}>`** places a component in time. The spec's `startSec`/`endSec`/`revealSec` convert to frames (x fps) and become Sequence offsets. WhisperX word timestamps mean reveals land ON the spoken word, not near it.

The footage itself is a layer (`<OffthreadVideo>`) and can be animated like anything else: translate, scale, corner radius. That is the whole trick behind the split variants: the FOOTAGE MOVING IS THE TRANSITION. No cuts, no wipes; the video slides into its slot while the panel opens in the same spring, so they read as one connected surface.

## Fidelity pass (2026-07-15, senior-motion-designer review, all implemented)

- **Responsive scale uses the short side:** display type, labels, icons and padding derive from `min(width, height)`, then fit their actual content box. Canvas height alone is forbidden because it makes portrait typography enormous while the available width stays narrow.
- **Platform safe zones are layout inputs:** key text, faces, CTA controls and diagram labels stay inside the destination profile. Background textures and wipes may bleed to the edge.
- **Portrait choreography is vertical:** the 50 becomes a bottom stage over full-bleed footage; the 75 becomes an aspect-preserved creator card above a statement; full-screen cards stack. Horizontal rows and left/right halves remain landscape-only.

- **Statements are display type:** minimum ~9 percent of frame height, max 3 words per line, stacked lines. A statement that fits on one small line is a bug. Overlay statements ride the theme's PANEL material (glass/card), never bare outlined caps. Lines stack BALANCED (minimal line count, then the stacking whose longest line is shortest) and the type shrinks below display size only as far as the longest line physically requires for the layout's width (wide-font fit: Inter needs what Anton never did). Overflow into the footage card is always a bug.
- **The footage has a camera:** constant sub-perceptual life (~1 percent), a slow push-in (to ~+2 percent) across every graphic hold, and a 2-frame 0.5 percent impact dip on every graphic ENTER. Suspended while the layout engine is moving the footage.
- **Negation is a designed state:** on the spoken reveal, struck items desaturate (~35 percent), drop to ~62 percent opacity, take a small drop + tilt, the X lands ON the icon, and the strike is thick (6px+) in the theme's HOT color (negationHot), never the accent. Kept items pulse +4 percent as their reveal lands.
- **One bloom owner:** exactly one element glows at full intensity at a time (the live reveal); everything else rests at ~30 percent. The bloom follows the word-synced reveal.
- **Fullscreen comps enter via a corner-anchored soft WIPE** (from the theme's light corner), not a crossfade; split panels get a 1-frame contact flash on arrival.
- **Fullscreen composition:** content fills 70-80 percent of safe area. Landscape uses 2-up / 3-up / 2x2 grids. Portrait uses a vertical stack or sequential emphasis with one dominant live item, never a three-card row.
- **Atmosphere above the crush floor:** light pools, grain (~6 percent), grids, and floor vignettes are authored strong enough to survive h264 + YouTube's re-encode; the verification loop compares background ENERGY against the boards, not just element positions.
- **Subscribe click has a consequence:** button flips SUBSCRIBE to SUBSCRIBED (red to glass outline), large custom cursor, 7-particle micro-burst, bell wiggle.

## The lifecycle (every event, no exceptions)

```
ENTER (spring)  ->  HOLD (rest micro-motion)  ->  REVEALS (word-synced)  ->  EXIT (spring, faster than enter)
```

- Exits are always ~15 percent faster than enters. Leaving slow feels broken.
- **Exits complete EXACTLY at endSec.** The exit spring is time-normalized (`durationInFrames` = outMs worth of frames), so p reaches 0 on the end frame itself with zero bleed past it. The Director cut-syncs endSec to footage cuts (DIRECTOR.md, the cut-sync law): when a graphic ends near a cut, its end frame IS the cut frame, the last fade sliver dies on the outgoing shot, and the incoming shot arrives clean. Never re-add a settle grace past endSec; anything visible after endSec will eventually cross a cut somewhere.
- Nothing pops in at full size from nowhere: everything arrives via spring from a direction or a scale.
- HOLD is never dead: each theme defines a rest micro-motion so long-held graphics stay alive (see theme feel table).
- Two events never animate simultaneously in opposite directions (one finishes its exit before the next enter peaks; the Director's density cap makes this cheap to guarantee).

## Spring presets (per theme, stored in each theme JSON under motion.springs)

| Preset | simple-claude | liquid-glass | synthwave |
|---|---|---|---|
| `enter` | quick, zero overshoot (damping 200, stiffness 130) | slow luxury glide, zero overshoot (damping 34, stiffness 40, mass 1.2) | punchy, slight overshoot (damping 14, stiffness 170, mass 0.8) |
| `exit` | same, faster | same, faster | same, faster |
| `press` | n/a (minimal brand) | soft compress (damping 18, stiffness 220) | hard compress + snapback (damping 10, stiffness 300) |
| Rest motion | none (stillness IS the brand) | 2px parallax drift, 8s loop | glow pulse + slow haze drift |
| Signature | fade + 12px rise | scale from 96 percent + blur-in, specular sweep on entry | glow bloom LEADS the panel by ~6 frames (light arrives first), grain constant |

## Narrative pacing (the storyline principle)

A concept graphic is a tiny STORY, not a synchronized slideshow: setup, build, payoff. Extracted from studying pro Remotion/Claude-Design motion work (2026-07-15):

- **Reveals accelerate toward the payoff.** Early items can breathe; the pacing tightens as the list closes.
- **The FINAL reveal gets punctuation:** a comp-wide micro-pulse (scale 1.0 to ~1.012 and back over ~16 frames) plus a glow flash on the landing item. Implemented as `payoffPulse()`; fires automatically on the last word-synced reveal.
- **Counters over static numbers.** Metric quantities (money, subs, views, percentages) render as eased count-ups that finish in about a second, fast start, soft landing, tabular numerals so digits don't jitter. Statements support a `{COUNT}` token; bar charts count each bar's value IN SYNC with its rise.
- **Bars are the premium chart move:** staggered spring growth from a zero baseline, one by one in a wave, with a soft bright glow riding the TOP EDGE of each bar and a vertical dark-to-bright gradient fill.
- **Steps connect.** In steps-kind fullscreen comps, glowing connector segments DRAW between cards as each lands, so the diagram reads as a pipeline, not four floating boxes.
- **Idle elements stay alive:** leading icons carry a slow glow breathing (sine, ~2s period), so held graphics never look frozen.

## Choreography per component

### STATEMENT (the big-claim treatment; small text pills are gone from content beats)
- Lives inside a layout variant: 75-split by default (footage docks into the card while the claim goes display-size on the field), full-screen when the creator is not the shot.
- ENTER: the layout opens on its shared spring; words stagger in at display scale (staggerMs apart, or word-timestamp synced when obvious).
- EMPHASIS: pop-color words (e.g. "30 DAYS") glow and pulse scale 1.0 -> 1.06 -> 1.0 as they land. A {COUNT} token ticks up over ~1s with tabular numerals.
- EXIT: with the layout, faster than enter, as always.

### CONCEPT_GRAPHIC: split-screen ("the 50")
- PORTRAIT: footage remains full-bleed and unscaled. A rounded bottom stage rises inside the platform safe zone, preserving the face and using the lower body/background as the supporting surface.
- ENTER: one shared spring drives BOTH surfaces: footage slides right into the right HALF WHILE the panel slides in from the left edge (50/50). One motion, two surfaces, zero disconnect.
- Eyebrow dot pulses once when the label lands.
- ROWS: cascade in with stagger (each row slides 16px from left + fade).
- STRIKE: at each item's `revealSec`, the strikethrough line DRAWS left to right across the word (interpolate width over ~10 frames) and the X mark springs in from scale 0 with a small rotation settle. The strike lands on the spoken word. This is the retention moment; it must feel surgical.
- EXIT: reverse the shared spring; footage glides back to full frame.

### CONCEPT_GRAPHIC: 75-split
- PORTRAIT: the source stays at its native aspect inside a centered upper card, with the short hero statement centered below it. Non-statement diagrams are promoted to a full-screen vertical stack.
- ENTER: footage shrinks INTO the rounded portrait card (one spring animating scale + translate + border radius 0 -> 24px simultaneously) while the textured field blooms in beneath it.
- Field texture (grid/haze per theme) drifts almost imperceptibly during HOLD.
- ROWS/TABLE: enter with heavier stagger than split-screen (bigger surfaces, more presence), reveals word-synced same as above.
- EXIT: card expands back to full frame; field fades under it.

### CONCEPT_GRAPHIC: overlay (screen stays predominant)
- No footage transform, no field: a directional scrim fades in with the lifecycle (strongest behind the text zone, transparent elsewhere) and the display-size statement staggers in over it.
- The screen content underneath remains the star; the scrim only buys legibility. Zone (top/center/bottom) is chosen per frame for the least-busy pocket.
- EXIT: scrim and type fade together, faster than enter.

### CONCEPT_GRAPHIC: full-screen
- ENTER: footage dips (fade + slight scale down) as the themed textured background blooms up THROUGH it; title enters with the theme signature (synthwave: scanline-fade title with glow bloom; liquid-glass: glass shine sweep; simple-claude: plain confident fade-rise).
- CARDS: rise in sequence (stagger), icons draw on, strikes/checks land on their `revealSec`.
- Creator audio continues untouched underneath; the audience never loses him, only sees the concept.
- EXIT: comp fades as footage blooms back to full.

### CTA_BANNER
- ENTER: pill slides up from just below the bottom edge + expands slightly; icon pops in a beat later (one small spring).
- HOLD: conversion events hold LONG (spec-driven); rest micro-motion keeps it alive; a single subtle shimmer sweep is allowed once per hold, never looping.
- EXIT: slide down + fade, quick.

### SUBSCRIBE_CTA (the impact showcase)
0. The button ENTERS at the start of the subscribe build-up and rides the whole channel pitch (4s+ holds are normal); the click is a separate, word-synced moment.
1. Button pops in with the theme's punchiest enter spring (visible overshoot).
2. Cursor slides in from off-screen bottom-right on an eased arc, timed to arrive just before `payload.clickSec` (the spoken ask verb), decelerating onto the bell.
3. CLICK: button/chip compresses to scale 0.94 (press spring), snaps back with overshoot; a ripple ring expands from the cursor tip (interpolate scale 0 -> 1.6, opacity 0.6 -> 0); the bell wiggles (rotation spring oscillating +-14 degrees, settling over ~20 frames); the red gets a single glow flash frame.
4. Cursor eases out; button holds to section end.
- YouTube red is functional and constant across themes; only the chip material and glow obey the theme.

## Timing conversion

- Spec times are seconds; renderer converts to frames at source fps (1080p30 default: x30).
- `revealSec` values refine to word-level timestamps at render time (WhisperX JSON has them; the SRT is the human-readable form).
- All durations come from theme tokens (`motion.inMs`, `motion.outMs`, `motion.wordStaggerMs`); nothing is hardcoded in components. `motion.outMs` is the EXACT exit duration (the exit spring is normalized to finish in it), not a minimum.

## Render output and motion

- ONE export: the baked MP4 with the full choreography above. (Alpha mode was removed 2026-07-15: the layout variants only work baked, and one quality-first export beats two compromised ones. Compression is handled by render settings: h264 CRF 16, ProRes 422 available on request.)
- Source parity is law: the render matches the source's width, height, fps, frame count, duration, and audio exactly, so it drops back onto the editing timeline frame-perfect.
- Sound effects (click, whoosh) are OFF by default; they would fight the creator's voice track. Possible later as an opt-in.
