# Doodle pipeline (vendored)

The deterministic execution layer of Story Studio's first style template —
vendored 2026-07-03 from the production-proven `faceless-doodle-video` agent
skill (Luke's, already shipped a published-ready video). Vidmyo orchestrates
these scripts; it does not reimplement them.

## Stages and owners

| Stage | Owner | Tool |
|---|---|---|
| Script (retention rules, fact-check, 1,400–1,900 words) | agent/LLM + human | `references/master-prompt.txt` |
| Voiceover | `scripts/tts_kokoro.py` | Kokoro TTS, local, free (default voice `am_onyx`) |
| Beat detection (cut on narration pauses) | `scripts/detect_beats.py` | faster-whisper, local — emits `beats.json` with `sNNN` ids |
| Image prompts | core `story.js` (`buildImagePrompt`) | anchor + scene + lock per `references/style-spec.md` |
| Images | provider choice — Google Flow (default, free) / APIs | scene queue via `Project.pendingScenes()` |
| Caption fixes | `scripts/fix_captions.py` | PIL cover+redraw |
| Assembly (Ken-Burns, cuts on beat cues, sync-exact) | `scripts/assemble.py` | ffmpeg — do NOT "simplify" the hold-to-next-cue logic; it prevents desync |
| Finalize (4K upscale + −14 LUFS master) | `scripts/finalize_video.sh` (wraps `master_audio.sh` + `upscale_4k.sh`, script-relative) | ffmpeg two-pass loudnorm; `NO4K=1` env to skip upscale for one run |

## Runtime dependencies (doctor installs these with consent)

`scripts/setup_env.sh` builds a local venv: Kokoro TTS + faster-whisper +
spaCy `en_core_web_sm` + Pillow, plus `espeak-ng` (brew). Everything runs
offline and free after setup. ffmpeg/ffprobe required on PATH.

## Contracts core relies on

- `beats.json`: `{ audio, beats: [{ idx, id: 'sNNN', start, end, dur, text, image_prompt }] }`
- `assemble.py <video_dir>` expects `video_dir/{beats.json, voiceover.wav, images/sNNN.png}` → `output.mp4`
- Each image holds from its cue to the next beat's cue → video length == VO length.

Keep upstream fixes in sync: if the skill's scripts improve, re-vendor deliberately
(diff first), and vice versa.
