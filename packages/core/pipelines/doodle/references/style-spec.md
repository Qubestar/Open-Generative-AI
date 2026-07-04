# Doodle Style Spec — Zenn-style faceless channel

Derived from Zenn's "What Did Ancient Humans Do at Night?" + the stickman-workflow tutorial.
This is the look every generated image must match. Goal: 100+ images that all look like the
**same channel** drew them.

## The look
- **Hand-drawn doodle / whiteboard.** Thick, bold, slightly imperfect **black marker outlines**
  (Sharpie sketch feel). Intentionally raw, not polished vector.
- **Flat, saturated solid colors.** No shading, no gradients, no lighting/3D.
- **Backgrounds:** plain **white**, or one or two large flat color blocks (e.g. blue sky band +
  brown ground band). Never busy.
- **Characters:** simple **stick figures with round heads**; personality comes from
  **very expressive faces** (dot eyes, simple eyebrows + mouth conveying the emotion).
- **Literal 1:1 illustration** of the narration. Narrator says "light switch" → draw a light
  switch. Numbers/dates appear as drawn text.
- **No photoreal. No 3D. No anime. No cinematic lighting.** (These are the failure modes.)

## Authoritative prompt format (from reference/master-prompt.txt, Stage 3)
Every image prompt = **style anchor** + **scene** + **style lock**, verbatim:

- **Anchor (start):** `Hand-drawn 2D doodle cartoon animation, flat colors, bold black outlines, slightly imperfect sketchy marker lines,`
- **[SCENE]:** characters + exact expression + objects + background color + any ALL-CAPS on-screen text/labels. ONE clear idea per beat (= one breath of VO). Hold a scene across consecutive beats; only change expression / add one element rather than inventing a new scene every few seconds.
- **Lock (end):** `no gradients, no shadows, no textures, no photorealism, no 3D, 16:9 aspect ratio, educational YouTube explainer doodle style.`

## Exact color palette (hex)
Orange `#F5820D` · Cobalt blue `#2D5FBF` · Grass green `#3A9E3A` · Golden yellow `#F5C518` ·
Red `#D94040` · Brown `#8B5E3C` · Sky blue `#6EB5E8` · Tan `#C4965A` · White `#FFFFFF`

## Background color → mood map
- Ancient / prehistoric → **tan** or **dark blue**
- Danger / threat → stark **white** with red text, or red-tinted sky
- Happy / triumph / discovery → bright **white** or **yellow**
- Underwater / science → solid **blue**
- Outdoor / nature / evolution → flat **green ground + blue sky**
- Fire / night / ancient ritual → solid **orange**

## Proven frame types
Concept-text frame (big object + ALL-CAPS top text) · evolution sequence (left→right + arrow) ·
labeled diagram (yellow diagonal arrow + label) · stick-figure reaction (thought bubble: "?",
"HMMMM", "WAIT...") · villain personified (concept with angry face) · globe + floating creatures.

## Consistency strategy (critical)
- **Lock the style with a reference image.** Generate ONE hero doodle first, approve it, then
  for every subsequent image feed it to **Nano Banana** as a style/character reference
  ("same style and character as the reference, new scene: …"). Nano Banana is best-in-class at
  holding a character/style across many images — this is why it's the primary model.
- Keep a fixed **character sheet** (same stick figure, same proportions) in `reference/`.

## Text / caption frames
- On-screen words are **bold, all-caps, hand-drawn** with **red accents** (underline, circle,
  arrow) for emphasis.
- Two ways to do these:
  1. **GPT Image** — generate the word baked into the doodle (best text rendering of the two), or
  2. add the caption **in the editor / assemble.py** as a clean overlay (more legible, fully
     controllable). Default to editor overlays for anything that must be perfectly readable;
     use GPT Image when the word should look hand-scrawled in-scene.

## Motion (added at assembly, not generated)
- Images are **static**; the video feel comes from **rapid cuts on VO pauses** + a slow
  **Ken Burns zoom** (~5–8% over the beat) + quick crossfades. No character animation needed.

## Aspect / export
- Generate **16:9**. Target **1080p** final. Higher-res source is fine (downscale crisp).
