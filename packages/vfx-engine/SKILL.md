---
name: perfect-vfx
description: Apply retention-focused motion graphic overlays and simple VFX to a pre-edited video SECTION (YouTube intro, chapter card, or a custom described section). Sister skill to perfect-cuts. Use when the user drops a short pre-edited clip and says "perfect vfx this", "add graphics to this intro", "motion graphics pass", "vfx this section", "overlay pass", or invokes /perfect-vfx. The user uploads only the section (never the whole video), gets one quality-first baked MP4 back with source parity, and patches it onto their own timeline. All creative logic is baked in; after full up-front analysis the Director presents its plan and real renderer storyboard for review before the full render.
---

# Perfect VFX

Drop a pre-edited section, get it motion-graphic'd. The Director analyzes the actual words spoken and drafts every treatment itself; the creator's brand kit (or a theme default) decides how it looks. The user reviews the beat plan, then a real-frame storyboard with platform safe zones before the expensive full render.

**Build status: Director + spec LIVE. Renderer LIVE (baked MP4), all components implemented:** CONCEPT_GRAPHIC (statement / icon-cards / chart / steps across overlay, split-screen 50/50, 75-split, full-screen), CTA_BANNER, SUBSCRIBE_CTA (build-up anchored, word-synced click). NO small-text move: content beats go big or stay clean; compact pills exist only for the conversion pair. All surfaces resolve from theme materials (theme.ts materials()). Parity passing since 2026-07-15. Cut-sync boundary law live 2026-07-15: exits complete frame-exact ON footage cuts, never across them.

**Split-screen backdrop + dock law live 2026-08-05.** The 50/50 docks the footage into the right half, which leaves the left half with nothing behind the translucent panel. Three defects, all fixed in shared code, so every theme's 50/50 benefits, liquid-glass included:

1. **Footage CLIPS to the panel's right edge** (`width*0.5*dock`, the same x the panel uses) instead of bleeding under it, and a **static brand-gradient field** fills behind the panel. Before this the panel had two different things behind it, bare background on one side and sharp footage on the other, so the vacated strip fell through to the flat void colour and the midpoint read as a hard seam.
2. **`ConceptSplit` has NO `backdrop-filter`.** Chrome samples a backdrop-filter's backdrop in the wrong coordinate space on a TRANSLATED element. The panel picked up the footage as a blurred warm wash that moved with the creator's hands: the panel visibly pulsed light and dark through the hold. Measured on a static gradient it should be one colour; with the filter the same region swung `(12,3,43)` to `(46,26,47)`. Blurring a static gradient buys nothing, so the filter is gone; the glass reads from the panel's own translucent gradient, border and shadow.
3. **`motion.ts` exports `dock`** (`p` clamped to [0,1] AND saturated at `p/0.97`) for geometry two surfaces share, and the slab is built 140px WIDER than its slot with the overhang off-frame left. The enter spring is underdamped on purpose, so raw `p` sails past 1: driving position off it made the slab overshoot its slot, snap back, and lift its own left edge off x=0 mid-move. The 0.97 saturation exists because the spring approaches 1 asymptotically — the last ~3 percent was a slow sub-pixel crawl still running when the first row animated in, and the two together read as a bump on the landing. Decorative motion keeps raw `p`. Never drive shared geometry off `p`.
4. **Panel shadows scale with `dock`, and the inset white light-sweep is DELETED.** At `dock=0` the slab sits off-frame but its right edge lands exactly on x=0, so a fixed 40px `boxShadow` spread spilled back into frame as a dark strip down the left border after the exit completed — then vanished on unmount, which read as a click. Multiply every shadow alpha by `life.dock`. The light-sweep was keyed to raw `enter` and peaked at ~0.96, several frames AFTER the slab visually parked and exactly as the first row entered: a flash where the eye expects stillness. Landing punctuation belongs at the START of the landing, or nowhere.

**ONE decoder per composition.** A blurred live copy of the footage behind the panel was tried first and is WRONG: a second `OffthreadVideo` means two independent decoders on one file, they drop and mis-deliver frames against each other, and the result is a flickering panel plus skipping footage. A single still always resolves, so it only appears in motion. If a surface needs the footage behind it, derive it from the ONE video element or use a static fill.

**Reviewing a split-screen render (learned the hard way):**
- **Measure the render, never `remotion still`, and never a single frame.** Stills were stable while the render flickered. Sample a panel region with `scale=1:1:flags=area` (plain `scale=1:1` resamples and invents differences) across EVERY frame; in the docked window frame-to-frame delta should be <= 1.
- **Never pipe `remotion render` into `tail`/`head`.** The pipe returns the pager's exit code, so a failed render reports success. Two renders here failed with `Permission denied` because the output MP4 was open in a player, and the "verified" file was a stale build the whole time. Check the exit code and the output file's mtime.
- **Do not diff frames with `eq=gamma=<1`** — that CRUSHES small differences instead of boosting them. Use `blend=difference` plus `lutrgb=val*N`, or compute per-cell means in raw pixels.
- Track the panel's right edge per frame (must rise to `width*0.5` and hold), and scan the panel interior for `R>B` skin contamination.
- **The numeric gate is necessary, not sufficient.** Three defects (landing bump, post-exit shadow strip, sweep flash) passed every parity/PSNR/flicker check and were only caught by a human WATCHING the render. When the user reports a motion artifact, believe them and measure the exact frames they name; do not re-run the passing gate as a rebuttal.

## The menu (ask exactly one question on open)

"What are we treating?"
1. **YouTube intro** (the usual)
2. **Chapter card** (a full-screen concept treatment)
3. **Custom** (describe what you want in a sentence; if it's an outro, endscreen safe zones apply automatically)

If the user already said it ("vfx this intro"), skip the menu. Never ask anything else about style, placement, or taste during intake or the Director pass; the only other interaction points are the plan gate (step 5) and first-run onboarding.

## Requirements (first run on a new machine)

- **Node.js 18+** (current LTS from nodejs.org). `setup.mjs` checks the version but cannot run without Node itself; if `node` is not on PATH, tell the user to install the LTS and reopen the terminal.
- **ffmpeg + ffprobe** on PATH. `setup.mjs` prints the one-line installer per OS if missing.
- **Python 3.10-3.12 + WhisperX** for transcription. The bundled `scripts/transcribe_to_srt.py` prints exact pinned install commands if WhisperX is missing.
- **Disk + network:** first-time setup downloads roughly 500MB (npm dependencies + the Remotion headless browser); WhisperX adds ~2GB more if not already installed. Renders also need internet for Google Fonts (font files are fetched at render time, everything else is local).
- **Remotion licensing:** the render engine is Remotion, installed from npm on the user's machine. Remotion is free for individuals and companies of 3 or fewer people; larger companies need a Remotion company license (remotion.pro). That obligation belongs to the end user; mention it if the user says they are rendering for a company.

## Workflow

### 1. Intake
- Run the intake checks in `director/DIRECTOR.md` (probe, audio volumedetect, length warning, frame-exact cut list + shot map), then transcribe with the bundled `scripts/transcribe_to_srt.py` into the run folder (see DIRECTOR.md intake step 4). If ffprobe/ffmpeg are missing, run the renderer bootstrap first (`node setup.mjs` from `renderer/`, see Render step 0).

### 2. Brand kit
- Look for `<user home>/Documents/Perfect VFX/brand-kit.json` (Windows: `%USERPROFILE%\Documents\Perfect VFX\`; macOS: `~/Documents/Perfect VFX/`).
- **Found:** load it, say nothing, move on. Zero questions.
- **Missing:** run the ONE-TIME onboarding (this is the only time Perfect VFX ever asks about style):
  1. What color or colors match your brand? (hex if they have it)
  2. Primary and secondary fonts? (any Google Fonts family by name, or the name of a font already installed on this machine, e.g. Adobe CC fonts. A font file path is not enough by itself: have the user install the file, then reference it by name as a local font with a Google fallback)
  3. Which theme: simple-claude (clean editorial, the default), liquid-glass (frosted premium), or synthwave (cinematic 80s)?
  4. Any vibe words? (free text; flavors concept graphics only)
  - Skippable at any point; skipped fields fall back to theme defaults, full skip = simple-claude.
  - Validate against `schemas/brand-kit.schema.json`, write the file, confirm the path. Never ask again.

### 3. Output folders
- Root: `<user home>/Documents/Perfect VFX/`
- Project folder: derived from the source clip's path by walking UP past generic folder names (`Renders`, `Exports`, `Final`, `v1`/`v2`/`vN`) to the first meaningful folder name. Example: `.../June 29 2026 - My Launch Video/v2/Renders/clip.mp4` becomes project `June 29 2026 - My Launch Video`. If nothing meaningful is found, ask once for a project name.
- Run folder inside the project: `<segment-type>-<NN>` (first free number): `intro-01`, `intro-02`, `chapter-card-01`.
- Never copy the source clip; reference its absolute path in the spec.

### 4. Director pass
- Follow `director/DIRECTOR.md` exactly: segment beats, assign moves, resolve collisions, emit `spec.json` (validate against `schemas/edit-decision-spec.schema.json`).
- Detect landscape, square or portrait before choosing a treatment. Preserve portrait footage aspect ratio, stack diagram items vertically and use the selected Shorts, TikTok or Reels safe-zone profile. Every event must state its intent and one-sentence visual thesis.
- Write `run-log.md`: the full beat map table (every beat including TALKING_HEAD, with timing, move, anchor words, reasoning), intake check results, and the brand/theme resolution.

### 5. Plan gate
- ALL analysis happens before this point: probe, audio, cut list, shot map, transcription, and the complete Director draft. The user never waits through a render to discover a weird placement.
- Present the FULL plan in chat as a compact beat chart, one row per beat INCLUDING deliberate talking-head stretches, then STOP:

| # | Time | Line (short) | Shot | Treatment |
|---|---|---|---|---|
| 1 | 0.0-6.1 | "So I cloned my brain..." | screen-share | Overlay statement "I CLONED MY BRAIN", bottom, exit dies on the 6.07 cut |
| 2 | 6.1-10.5 | (connective) | talking-head | Clean on purpose + SUBSCRIBE pill fallback, exits on the 10.50 cut |

  Treatment = move + variant + kind, the on-screen text verbatim, and the boundary/cut-sync notes. Keep rows one line each.
- Ask exactly ONE question: "Good to render, or any changes? If you have creative ideas for a specific section, drop them here."
- "go" / "approve" / "looks good" = generate the storyboard from the approved plan.
- Edits and ideas fold back into the spec: honor the user's direction wherever it is renderable, keeping the hard laws (source parity, shot gating, cut-sync, statement limits, endscreen safe zones). If an idea breaks a law, say why in one line and offer the closest legal version. Show only the changed rows, get one confirmation, render.
- The gate catches wrong editorial decisions before renderer work. It is an approval checkpoint, not a style interview: the Director never asks how things should look.

### 6. Storyboard gate
- Render entrance, hold and exit stills for every event with the real renderer, source, fonts and theme. Draw the selected platform safe zone over the previews.
- Check hierarchy, text wrapping, subject framing, graphic meaning and the transition between clean footage and the treatment. Plan edits invalidate every storyboard frame.
- The full render remains unavailable until the user explicitly marks the current storyboard reviewed. Approval applies only to the exact spec digest used to make those frames.

### 7. Render
- ONE export: `<run>-baked.mp4`, graphics burned in. (Alpha mode was removed 2026-07-15: quality-first single export; the layout variants only exist baked anyway.)
- **PARITY CONTRACT (law):** output matches the source exactly: width, height, fps, frame count, duration, audio. Verify with ffprobe after EVERY render, report the comparison in the run log. The section must drop back onto the user's timeline frame-perfect, no gaps, no missing frames.
- Quality: h264 CRF 16 (visually transparent), source audio passed through. If the user ever reports degradation, switch to ProRes 422 (`--codec=prores`).
- Engine: Remotion project at `renderer/`. Steps:
  0. `node setup.mjs` (run from `renderer/`). Silent, idempotent, self-healing: safe to run every time. Checks Node 18+ and ffmpeg/ffprobe on PATH (prints one install line per missing tool and stops), installs npm dependencies only when missing or stale, and pre-downloads the Remotion headless browser so the first render never stalls. Prints exactly `Perfect VFX renderer ready.` on success.
  1. Hardlink the source clip to `renderer/public/src.mp4`; if linking fails (e.g. source on a different drive), fall back to a plain copy. Windows (PowerShell): `New-Item -ItemType HardLink -Path public\src.mp4 -Target "<clip>" -Force`. macOS/Linux: `ln -f "<clip>" public/src.mp4`.
  2. `cd renderer && npx remotion render src/index.ts PerfectVfx "<run folder>/<run>-baked.mp4" --props="<run folder>/spec.json" --crf=16 --color-space=bt709 --log=error`
     (`--color-space=bt709` is MANDATORY: it encodes limited-range BT.709 matching standard camera/NLE footage. Without it Remotion outputs full-range BT.601 (`yuvj420p`/`pc`/`bt470bg`), which reads as crushed blacks and cranked contrast: a real reported bug, caught by pixel diff.)
     (`--log=error` is also mandatory: without it Remotion streams ~1850 progress lines. Run the render as a background task and check the result when it exits; never tail its progress.)
  3. ffprobe parity check vs source; append results to run-log.md. Parity now INCLUDES color: `pix_fmt` must be `yuv420p` (not `yuvj420p`), `color_range` tv/limited or matching source, matrix bt709. Also PSNR-check a no-overlay segment vs source. Calibrated pass bars (2026-07-16, remotion 4.0.489/490): **~35dB = PASS** (the compositor applies a small fixed decode transform, so the ffmpeg-only ~48dB ceiling is unreachable through the engine); ~30dB with soft blob artifacts = jpeg-intermediate regression; edge ghosting in frame diffs = camera-zoom regression; hue shifts (blues toward cyan) = real color-pipeline failure (601-vs-709 class). PSNR-gate hygiene (both traps have produced false 10dB drops): (a) re-probe `public/src.mp4` (`nb_frames`, duration) immediately before gating and confirm it matches the intake probe: it is a shared hardlink another run may have swapped; (b) fence the trim so render and source windows hold the SAME frame count (61 frames 480-540 = `-ss 16 -to 18.033`, never 18.034), and check the per-frame stats file: one <30dB frame with a ~45dB interior is trim misalignment, not color. Engine truth (verified 2026-07-16, remotion 4.0.489/490): compositor decode, Chrome raster, and 709 encode are all correct; the only engine loss is a uniform ~-1 code rounding, so a real color-pipeline failure shows as hue shifts (blues toward cyan = 601-vs-709 class), never as a uniform offset.
  4. **Verification loop (mandatory):** extract a frame at each event's midpoint plus the subscribe click frame, LOOK at them, and compare against the theme's board in `themes/boards/` (shipped with the skill; the ONLY reference imagery). Wrong position, covered face, garbled text, or off-brand color = fix the spec/tokens and re-render before delivering. Never ship the first render unseen.
  5. **Cut-sync check (mandatory):** for every cut-synced boundary, extract the frame pair (cut frame - 1, cut frame) from the RENDER and confirm the graphic's last sliver dies on the outgoing shot and the cut frame itself is clean (or, for a synced enter, that the graphic begins ON the cut). A graphic mid-fade across a cut is a defect: fix the spec and re-render.
- Fast iteration: `npx remotion studio` in `renderer/` opens a live-scrubbing preview in the browser (pass the spec via `--props`); use it to check timing feel before committing to a full render.
- Theme tokens come from `themes/<theme>.json`; brand kit values overlay them; motion obeys `director/MOTION.md`. The boards in `themes/boards/` are the canonical look targets.
- Fonts: ANY Google Fonts family loads automatically by name (theme.ts resolves it dynamically, case insensitive); "local" fonts (e.g. Adobe CC) resolve when installed on the machine, else the declared fallback renders. Font fetching is the one network dependency at render time.
- Preserve native source resolution, including 4K and higher. Never downscale the finished section merely to meet a Full HD ceiling.

### 8. Report
- Paths to everything in the run folder, the beat map summary, and one line per conversion graphic explaining where it landed and why.

## Rules

- Section in, section out. If the clip smells like a full video (> 3 min), stop and say so.
- The script is the boss. No graphic without an anchor (or an explicitly marked fallback).
- Zero taste questions outside first-run onboarding; the plan gate is an approval checkpoint, never a style interview.
- No em-dashes or en-dashes in any generated text, including text INSIDE rendered graphics.
- Local-first: transcription never leaves the machine. The only network fetches are one-time setup (npm packages + the Remotion headless browser via `setup.mjs`) and Google Fonts when a theme or brand kit needs one. No third-party account dependencies, ever.
- **Never generate reference imagery at runtime.** The boards in `themes/boards/` are the complete reference set and ship with the skill. Do not create boards, mockups, or comparison images with image-gen skills or APIs (media-gen, Fal, or anything else), even if they are installed; if a board file is somehow missing, verify against the theme JSON's tokens and vibe text instead.
- Themes are extensible: a new theme = a new JSON in `themes/` + a board image. No engine changes.

## Layout

```
perfect-vfx/
  SKILL.md                              this file
  scripts/transcribe_to_srt.py          bundled force-aligned transcriber (local WhisperX)
  director/DIRECTOR.md                  the baked creative brain
  schemas/edit-decision-spec.schema.json
  schemas/brand-kit.schema.json
  themes/simple-claude.json             default
  themes/liquid-glass.json
  themes/synthwave.json
  themes/boards/*-board.png             approved landscape references
  themes/boards/*-portrait-board.svg    approved portrait references
  renderer/                             Remotion render engine
    package.json / remotion.config.ts
    setup.mjs                           silent self-installing bootstrap (Render step 0)
    public/                             TRANSIENT per-run input (src.mp4 hardlink/copy); safe to delete between runs, gitignored
    src/Root.tsx                        composition + source-parity metadata
    src/PerfectVfx.tsx                  main comp: footage layout engine + event router
    src/theme.ts / motion.ts            token + spring resolution
    src/components/*.tsx                Statement, ConceptSplit/75/Fullscreen/Overlay, CtaBanner, SubscribeCta, Grain
```
