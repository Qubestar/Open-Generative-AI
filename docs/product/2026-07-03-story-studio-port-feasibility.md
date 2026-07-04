# Story Studio — Doodle Pipeline Port Feasibility (M3, first task)

**Date:** 2026-07-03 · **Verdict: HIGHLY FEASIBLE — port executed same day for the pure-logic half.**
Evidence: the production skill at `~/.claude/skills/faceless-doodle-video/` (read in full this session).

## Why this is a straight port, not a rewrite

- The entire deterministic layer is **357 lines of Python across 5 scripts**, all clean
  argparse CLIs, **zero hard-coded paths**. Vendored into `packages/core/pipelines/doodle/`.
- `detect_beats.py` already emits **`sNNN` beat ids** — identical to core's `Project` scene
  discipline. `importBeats()` asserts the two never drift.
- `assemble.py` is self-contained ffmpeg (Ken-Burns, hold-to-next-cue sync). Its one landmine
  is documented in the vendored README: never "simplify" the hold logic or audio/video desync.
- All heavy dependencies are local and free: Kokoro TTS, faster-whisper, spaCy, Pillow,
  espeak-ng, ffmpeg. `setup_env.sh` builds the venv — exactly what `vidmyo doctor` will wrap.

## What landed in core now (pure logic, 35/35 tests)

`packages/core/src/story.js`:
- `DOODLE_STYLE` template — verbatim prompt anchor/lock + palette from `style-spec.md`,
  `am_onyx` voice, 1,400-word floor. **Styles are data**; adding cinematic/anime later = new object.
- `buildImagePrompt()` — anchor + scene + lock composition.
- `validateScript()` — enforces the length hard rule *before* any generation spend
  (the "video 1 shipped at 3:40" lesson).
- `importBeats()` — beats.json → one scene per beat with `narrationSpan`, id-drift assertion.
- `scaffoldPrompts()` — fills empty prompts from beat text, never overwrites hand-written ones.
- `stageStatus()` — single source of pipeline progress (script → voiceover → beats → prompts
  → images → assemble → finalize) for UI, CLI, and MCP alike.

## What remains for M3 (execution half)

| Piece | Approach | Risk |
|---|---|---|
| Python runner | core spawns `pipelines/doodle/scripts/*` via child_process against a doctor-built venv | low — CLIs are stable |
| venv/doctor | wrap `setup_env.sh`; consent + size disclosure (Kokoro+whisper models are multi-hundred-MB) | med — first-run UX |
| Image stage | scene queue UI over `Project.pendingScenes()`; default source **Google Flow · Nano Banana 2 (free)**, agent/manual until the Flow provider ships; API providers (fal etc.) as paid in-product alternative | med — Flow is a Labs UI that changes |
| `finalize_video.sh` (4K + −14 LUFS) | lives in the Curio project, not the skill — port it into `pipelines/doodle/scripts/` next session | low — plain ffmpeg |
| Script stage | agent-assisted via master-prompt.txt (vendored); in-app editor + `validateScript()` gate | low |
| Packaging/metadata/thumbnail | agent-side for MVP (skill references stay authoritative); productize later | low |

## Flags for Luke (no action needed now)

1. The skill's house rule says **free Nano Banana 2, never "Nano Banana Pro"** (paid); your
   product direction offers Nano Banana 2 **Pro** as a *choice*. Resolution: default stays the
   free NB2 path; Pro-model choice becomes an explicit paid option in the source picker.
2. The skill forbids the Higgsfield MCP `generate_image` (bills credits) — kept as fallback
   guidance for the product too; Higgsfield stays behind explicit user choice.
3. Publishing (Drive/n8n/tracker/Curio coordination) is Luke's channel infrastructure —
   deliberately NOT vendored. The product's publish stage will be a generic n8n-webhook route.
