# The Director

The Director reads the transcript and timing of a dropped section and decides, beat by beat, what motion graphic treatment each moment gets. It asks ZERO taste questions while deciding: everything below is baked, and the Director always drafts the complete plan itself. The draft then goes through the plan gate (SKILL.md step 5): the user approves, edits, or contributes ideas for specific sections, and accepted direction folds back into the spec with the hard laws still applied. The output is one Edit Decision Spec (`schemas/edit-decision-spec.schema.json`), the single source of truth the renderer consumes; it is DRAFT until the gate approves it.

## Format profile comes first

Before choosing a move, read `intake.source.width`, `intake.source.height`, and `project.format`. Classify the canvas as portrait (width/height <= 0.8), landscape (>= 1.25), or square. The host supplies the destination platform and enforces its UI safe zone. This decision precedes every artistic choice.

**Portrait is a separate composition grammar, not a scaled landscape frame.** Landscape may use left/right divisions and horizontal card rows. Portrait uses vertical hierarchy: full-bleed creator plus a bottom stage, an aspect-preserved creator card above a hero statement, vertically stacked diagram rows, or a full-screen statement. Never describe portrait items as "in one row." Never put the creator into a strip narrower than 40 percent of the frame. Never use more than four diagram items in a portrait frame.

Every event records `intent` (hook, contrast, process, proof, instruction, transition, or conversion) and `visualThesis` (one sentence stating what the viewer should notice and why the chosen composition communicates it). Choose the visual form from the meaning of the beat. A spoken list is not automatically a card row, and a claim is not automatically a split. If clean footage communicates the beat more strongly, leave it clean.

## Non-negotiable principles

1. **The script is the boss.** Every graphic anchors to the spoken beat that earns it. There are NO fixed positions in time for any move. Absolute placements exist only as fallbacks when the footage never speaks a triggering line, and each fallback is marked `"placement": "fallback"` in the spec.
2. **Conversion tier wins.** SUBSCRIBE_CTA and CTA_BANNER are conversion graphics. They win any contested beat and they HOLD screen time past their anchor beat (until the next conversion beat or a natural release point). Decorative treatments never interrupt, overlap, or crowd them.
3. **Never cover the face.** Creator shots are often tight. Overlays live low and small, or the LAYOUT changes to make room (split variants move the footage instead of covering it). A graphic over a crisp centered face is always a bug.
4. **Density cap.** Maximum one graphic event start per 3 to 4 seconds. When rules collide, drop the lowest-tier event. Never crowd the frame.
5. **TALKING_HEAD is the default state, not a failure.** Breathing room between graphics is a retention tool. Do not decorate connective or emotional lines.

## Step 1: Beat segmentation

- Input: the force-aligned SRT from intake (word-accurate timing).
- A beat = one semantic unit: a claim, a list, an aside, a promise, an ask. Usually 1 to 3 SRT cues.
- Segment the WHOLE section into beats first. Assign moves second. Never assign moves cue-by-cue.

## Step 2: Move assignment

| Move | Tier | Fires when the beat is... | Payload |
|---|---|---|---|
| TALKING_HEAD | default | first-person, emotional, connective, transitional | none (absence of an event) |
| CONCEPT_GRAPHIC | content | a list, comparison, steps, negations, OR a single big claim (hook lines, value promises, standout numbers) via the statement kind | variant + kind + payload with reveal times synced to speech |
| SUBSCRIBE_CTA | conversion | an explicit subscribe / notification ask | label + bell |
| CTA_BANNER | conversion | a named offer: link, freebie, resource, download, comment ask | short offer text + icon |

(SCREENSHOT_SHOWCASE was removed from the product 2026-07-15: asset-gated proof shots sit outside the natural drop-a-section workflow and complicated the skill for no reason. Beats that point at on-screen proof stay TALKING_HEAD or take an overlay statement; the footage usually IS the proof.)

**There is NO small-text move.** (TEXT_ON_SCREEN was removed from the product 2026-07-15: small bottom text reads cheap.) Content beats either go BIG via a CONCEPT_GRAPHIC in one of the three layout variants, or stay clean talking head. The compact bottom pill format survives ONLY for the conversion pair (CTA_BANNER, SUBSCRIBE_CTA).

**kind = "statement"** is the big-claim treatment that replaces small text: the spoken claim rendered in display type filling the layout's content zone. 2 to 7 words, verbatim spoken order, emphasis words in the pop color, words staggering in. Counter rule: metric quantities (money, subs, views, percentages) render as a `{COUNT}` count-up inside the statement (`countTo` + optional `countFrom`/`countPrefix`/`countSuffix`); small scalars ("30 days") stay static; counting to 30 is padding, counting to 100,000 is proof.

**SUBSCRIBE_CTA is small, low, platform-colored, and rides the WHOLE build-up.** A compact YouTube-red button reading SUBSCRIBE with a themed glass bell chip beside it, bottom-center around 90 percent frame height. YouTube red is a functional color and overrides the theme accent; the chip material stays themed. Anchoring: it enters at the START of the subscribe build-up, the moment the creator begins pitching the channel ("if you want to see more of...", "this channel is about..."), NOT on the literal word "subscribe". It holds through the ask to the end of the section or a natural release; never a sub-2-second flash; aim for 4+ seconds whenever the material allows. The cursor CLICK still lands word-synced on the spoken ask via `payload.clickSec`. Exactly once per section (fallback for intros that never ask: quietly after the hook lands).

### CONCEPT_GRAPHIC variants (pick exactly one per event)

| Variant | Layout | Use when |
|---|---|---|
| **split-screen ("the 50")** | Footage slides right into the RIGHT HALF (~50/50) with a clean vertical edge; a full-height themed panel opens on the LEFT holding an eyebrow label + diagram rows | Spoken lists and comparisons while the creator keeps talking and needs to stay big on screen |
| **75-split** | Footage shrinks into a rounded portrait card on the RIGHT ~25 percent (with margin); the other ~75 percent becomes a themed textured field holding the eyebrow + LARGE diagram rows or tables | The intro workhorse: frameworks, steps, tables, hero reveals. Reach for this often |
| **full-screen** | Footage fully replaced visually by a themed TEXTURED BACKGROUND comp (title + numbered icon cards); creator audio continues underneath | Chapter cards, always. Big self-contained moments, and the FIRST concept beat of an intro whenever it can carry it. Legal on ANY shot type |
| **overlay** | NO field, NO panel, NO footage transform: a transparent-background display-size statement over a directional scrim (zone: top / center / bottom, picked by LOOKING for the least-busy pocket) | Screen-share and B-roll beats where the screen content must stay predominant (dashboards, proof, demos) |

### Portrait mappings

| Semantic variant | Portrait composition |
|---|---|
| **split-screen** | Keep footage full-bleed. A rounded bottom stage enters inside the platform safe zone. Use for one statement or up to three short comparison/list rows. |
| **75-split** | Aspect-preserved creator card centered in the upper field; statement centered below it. Statement only. Diagrams automatically become full-screen vertical stacks. |
| **full-screen** | Vertical stack or sequential cards inside the platform safe zone. Three steps stack; they never sit in a horizontal row. |
| **overlay** | Text surface occupies a low-detail pocket and remains inside the destination UI safe zone. |

**Typography capacity law:** portrait titles are at most 42 characters and diagram labels at most 34 characters. Shorten the copy or sequence it; never shrink a paragraph into a card. Main statements remain 2 to 7 words. Variable labels wrap and retain a clear hierarchy.

**Shot-aware layout gating (LAW):** 75-split and split-screen ("the 50") fire ONLY on `talking-head` shots; they transform the footage, and docking a screen-share into a card reads broken. On `screen-share` / `b-roll` beats the content stays predominant: use **overlay** (default) or **full-screen** (when the graphic needs structure: cards, chart, steps). Conversion pills (CTA_BANNER, SUBSCRIBE_CTA) are shot-agnostic. Every event records `anchor.shot`.

- **Concept graphics are DIAGRAMS, not text lists.** Every item carries an `icon` keyword (pencil, person, trash, gear, doc, chart, funnel, rocket, money, link, check, x). Full-screen renders numbered icon cards; 75-split renders large icon rows or tables; split-screen renders icon rows. Plain text rows are the fallback, never the default. Flashy and impactful beats subtle, especially early.
- **kind = "chart"** when the beat compares quantities ("went from X to Y", rankings, growth): items carry `value` (+ optional `prefix`/`suffix`) and render as staggered glowing bars with counters ticking up in sync with each bar's rise. **kind = "steps"** when the beat is a sequence: fullscreen cards get connector segments drawing between them. Steps caps at 3 items (one horizontal row in landscape, one vertical stack in portrait; the fullscreen grid wraps 4+ into 2x2 where connector geometry breaks); a 4+ item sequence uses icon-cards instead. Every concept graphic follows the storyline principle: setup, build, payoff punctuation on the final reveal (see MOTION.md).
- The footage transform IS the transition: the video layer slides/scales into its slot as the panel or card opens, and returns on release.
- Full-screen comps NEVER sit directly over the face; they stand on the theme's textured background (see each theme's `fullscreenBackground` tokens).
- Item reveals sync to speech: each item's `revealSec` lands on the word that names it. Negated items get `"negated": true` (strike treatment).

## The cut-sync law (boundaries)

Graphics live and die ON the footage's cuts. An enter or exit animation that straddles a cut reads as two unrelated accidents; an exit that completes exactly on the cut frame reads as one edited moment. This law refines event BOUNDARIES only; it never creates, deletes, or re-anchors an event (the script still decides what fires and where).

Windows, at the theme's declared timing: exit window = [endSec - outMs, endSec]; enter window = [startSec, startSec + inMs].

1. **No straddle, ever.** No cut may fall inside any event's enter or exit window. The renderer completes every exit EXACTLY at endSec (p = 0 on the end frame, zero bleed), so endSec ON a cut means the graphic's last sliver dies with the outgoing shot and the incoming shot starts clean.
2. **Exits die on the cut.** A cut within 1.0s AFTER a beat's natural end: EXTEND endSec to the cut frame. A cut up to 0.35s BEFORE the natural end: pull endSec back onto it ONLY when nothing anchored (last revealSec, clickSec plus its landing) gets orphaned past the cut; conversion holds treat a cut as a natural release point and prefer it. No cut within either window: keep the natural end (a mid-shot exit in clear footage is fine; the law is about cuts, not about forcing every boundary somewhere).
3. **Enters respect cuts.** A cut inside the enter window: move startSec onto the cut (graphics may lead their anchor word slightly; reveals stay word-synced) or push the start past the cut with a breath. A start within 0.35s after a cut MAY pull back onto the cut for a motivated pop; quiet fallback placements (e.g. the subscribe fallback slot) keep their deliberate offset.
4. **Mid-hold cuts.** overlay, full-screen, and the conversion pills may hold across cuts (the footage swaps under or behind them naturally). The docking variants (75-split, the 50) may hold across SAME-CLASS jump cuts only; a class-change cut mid-hold would dock the wrong shot into the card, so the event MUST end on that cut (or not fire at all). This extends the shot-gating law to every frame of the hold, not just the anchor beat.
5. **Shared cuts are legal.** One event may exit ON the same cut another enters on: the exit completes at that frame before the enter peaks, so they read as a single edited handoff.
6. **Order:** anchors first (the script is the boss), cut sync second, density and variety checks unchanged after. Record every boundary decision in the run log beat map: `end -> 10.500 (cut)` or `natural (no cut within window)`.

## Step 3: Collision precedence

When one beat triggers multiple moves:

```
SUBSCRIBE_CTA / CTA_BANNER  (conversion tier, wins)
        > CONCEPT_GRAPHIC
        > TALKING_HEAD
```

- **Number-in-beat rule:** a metric-worthy number in an UNCLAIMED beat earns a statement concept (variant per the layout rules). A number inside a conversion beat folds into that conversion graphic or is dropped entirely. Never spawn a second simultaneous event.
- Conversion moves rarely contest each other because they anchor to different spoken lines. If they ever do, the move whose trigger phrase is literally spoken in that beat wins.
- **Variety ledger (anti-template law):** track zone, variant+kind, and alignment across consecutive events. Never two consecutive events in the same anchor zone (conversion pills are exempt; they own bottom-center), never two consecutive CONCEPT_GRAPHICs with the same variant+kind, never two consecutive statements with the same alignment. Record the ledger as a column in run-log.md so it is auditable. Alternation is what makes a full video feel edited by a human instead of stamped from one template.

## Step 4: Segment-type profiles

### intro
- Open on a BIG hook treatment when it strengthens the promise. Variant BY SHOT AND FORMAT: landscape talking-head open may use **75-split**; portrait talking-head open uses the portrait 75 composition only for a short hero statement, otherwise a subject-safe overlay or a clean creator beat followed by full-screen type. Screen-share open = **overlay**; pure B-roll open = overlay or full-screen. Never dock a screen-share into a card.
- **Rhythm target: creator, BIG concept moment, creator, another big one.** Preserve clean holds; one element owns attention at a time. Landscape can lean on 75-split and the 50. Portrait alternates full-bleed creator, vertical stage, and full-screen moments so it does not feel like a narrow desktop template.
- Max one SUBSCRIBE_CTA, anchored to the build-up start per the rule above.
- Number rule active in unclaimed beats.

### chapter-card
- The clip IS one composition moment: a full-screen concept graphic (textured background treatment), 2 to 5 seconds.
- Title text comes from the spoken line, or from the filename if the card has no speech.
- No conversion moves by default. Mid-video is not the place to beg.

### custom ("describe what you want")
- The user says in a sentence what this section is and what they want emphasized. The Director still runs every rule above; the description sets emphasis and variant bias, it does not unlock manual art direction.
- Density cap relaxes to one event per 2 to 3 seconds only if the user's description asks for a graphics-heavy treatment.
- **If the user says it's an outro:** YouTube endscreen elements occupy the final 20 seconds (right half and lower-right). During that window, overlays live ONLY in the upper-left third, and SUBSCRIBE_CTA fires only before the window opens; inside it, the platform's own elements do that job.

## Step 5: Spec emission

- Events sorted by `startSec`, ids `evt-01`, `evt-02`, ...
- Timing comes from cue boundaries; refine to word-level times where the SRT wording makes the anchor word obvious. Boundaries are emitted AFTER the cut-sync law has been applied; the run log's beat map carries the boundary-sync column.
- Conversion holds: extend `endSec` past the anchor beat to the next conversion beat, a natural topic release, or the end of the section.
- Every event carries `anchor.transcript` (the words that earned it) and `notes` (why). The run log gets the full beat map INCLUDING the TALKING_HEAD beats, so the human can audit every decision.
- `brand` block: merge `brand-kit.json` over the chosen theme's defaults; record `kitSource`. No kit = `simple-claude` defaults.

## Intake checks (run BEFORE any Director pass)

1. **Probe:** ffprobe duration, resolution, fps. If duration > 180s, stop: "This looks like a full video. Perfect VFX works on sections (intro, chapter card, custom section). Export just the section and drop it back."
2. **Audio:** ffmpeg volumedetect. If `max_volume` < -30 dB, stop: "This export has no usable audio. Muted track on export? Re-export with audio and drop it back." (Real case: a muted export measured -91 dB across the board.)
3. **CUT LIST + SHOT MAP (mandatory: the boundary gate and the layout gate):**
   a. **Cuts (frame-exact):** `ffmpeg -i "<clip>" -vf "select='gte(scene,0.08)',metadata=print" -an -f null -` and collect every `pts_time` + `scene_score` pair from stderr. Scores >= 0.2 are near-certain hard cuts; 0.08 to 0.2 are candidates only (graph animation, scrolling screen content, and fast gestures all live there). VERIFY by eye: extract the frame pair (t - 1/fps, t) per candidate, LOOK, keep real discontinuities, drop animation/scroll noise. Ignore the first-frame artifact near t=0. Record the verified cuts (seconds, frame-exact multiples of 1/fps) and mark each one same-class (jump cut) or class-change.
   b. **Shots:** the segments between consecutive cuts are the shot units. Extract one frame per segment midpoint into a single tiled grid (`ffmpeg tile=3x3`, timestamps drawn on), LOOK at it, and classify every segment:
      - `talking-head`: the creator's face is the shot (big, clean)
      - `screen-share`: screen content with or without a creator PiP (dashboards, apps, browsers, slides)
      - `b-roll`: anything else without the creator
   Record cuts + segment classes in the run log; every event records its anchor segment's class as `anchor.shot`. NEVER assign a layout variant without this map, and never build it from cue midpoints alone: an eyeballed cue-based map on real footage was off by more than a second in four places, and cue boundaries do not align with cuts. (Real miss: a 75-split docked a screen-share composite into the portrait card; screen-in-a-card reads broken.)
4. **Transcribe:** run the bundled force-aligned transcriber (a copy of the youtube-transcript-writer script, shipped with this skill):
   `python "<skill root>/scripts/transcribe_to_srt.py" "<clip>" --out "<run folder>/transcript.srt"`
   `<skill root>` is this skill's own folder (the one containing SKILL.md); resolve it to an absolute path before running. Use `python3` where `python` is not on PATH (typical on macOS). First run on a machine: the script self-diagnoses; if WhisperX is not installed it prints the exact pinned-version install commands, relay them to the user and stop until installed. Never fall back to cloud transcription.
