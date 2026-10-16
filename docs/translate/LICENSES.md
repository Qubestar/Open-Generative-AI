# Translate Video — dependency licenses

Vidmyo's core is MIT and the project may become commercial, so every component
the Translate Video feature can execute is listed here with its license and
whether it is a **required** or **optional** dependency. Nothing in this list is
a research-only / non-commercial component, and nothing marked optional is needed
for a job to complete.

Verified against the installed versions on the development machine (macOS,
M2 Pro): see the version column.

## Required (a normal job uses these)

| Component | Role | Version seen | License | Commercial use |
|---|---|---|---|---|
| **FFmpeg** | extraction, alignment, mix, render | 9.0.1 (martin-riedl build) | LGPL-2.1+ (this build; the project already probes `configuration` for `--enable-gpl` — see `ffmpegCapabilities.js`) | Yes. Keep using an LGPL build, or accept the GPL terms of a `--enable-gpl` build. Vidmyo already reports `licenseClass` per binary. |
| **FFprobe** | media probing | same build | LGPL-2.1+ | Yes |
| **faster-whisper** | local speech recognition | 1.2.1 | MIT | Yes |
| **CTranslate2** (faster-whisper runtime) | inference backend | pulled by faster-whisper | MIT | Yes |
| **Whisper model weights** (OpenAI) | ASR model | `base` / `small` (env-selectable) | MIT | Yes |
| **Ollama** (client side only — HTTP) | local translation server | user-installed | MIT | Yes |
| **Translation LLM weights** | translation | user's own model (e.g. `llama3.1:8b`) | **Model-dependent.** Llama 3.1 is under the Meta Llama 3.1 Community License (permitted commercially, with the acceptable-use policy and attribution requirements). `gemma` weights use the Gemma Terms of Use. | Yes, but the *user chooses the model*; Vidmyo ships none. |
| **macOS `say`** | standard local TTS (no cloning) | system | Apple system software (used via its documented CLI) | Yes — it is a local OS facility, not a redistributed component. |
| **yt-dlp** | video URL import | user-installed CLI | Unlicense (public domain) | Yes. Note: yt-dlp itself is permissive, but *downloading a given site's media* is governed by that site's terms — the feature only accepts media that can be fetched without bypassing protections. |
| **Python 3** | worker runtime | 3.13.3 | PSF-2.0 | Yes |

## Optional (feature degrades cleanly without them)

| Component | Role | Version seen | License | Commercial use |
|---|---|---|---|---|
| **Demucs** | source separation (`background_mode: separate`) | 4.1.0 | MIT | Yes |
| **htdemucs weights** (Meta) | separation model | bundled with the package / fetched on first run | MIT | Yes |
| **PyTorch** | Demucs runtime (CPU/MPS) | 2.13.0 | BSD-3-Clause | Yes |
| **Voicebox / Chatterbox** | voice cloning (`clone_voice`) | user-installed local service | **Verified at the provider, not vendored here.** Chatterbox's model card at install time governs it; Vidmyo only talks to the local loopback API and never bundles the model. Check the installed Voicebox's own license page before shipping a build that enables it. | Confirm with the installed provider — this is the one component whose terms Vidmyo does not control. |
| **Lip sync backend** | experimental `lip_sync` stage | not configured in this build | n/a | The stage is a no-op that reports "no backend configured"; nothing is bundled. Do not mark it required until a specific backend's license is reviewed. |

## Deliberately not used

- **Cloud ASR/translation/TTS APIs** — no default path sends user media to a
  remote AI service. There is no paid API in the feature, so the expected API cost
  per video is **0**.
- **MLX / mlx-whisper** — evaluated and *not* adopted as the primary path because
  it was not present/stable on the target machine; `faster-whisper` covers CPU on
  Apple Silicon with int8 and needs no extra toolchain. Swapping it in later only
  requires a new transcription engine (the runner is engine-agnostic).

## Audit notes

- `faster-whisper`, `Demucs` and the Whisper weights are all MIT, so a commercial
  build can ship them.
- FFmpeg licensing is per-binary: Vidmyo already classifies it
  (`classifyFfmpegLicense`) and refuses to guess. An LGPL build keeps a commercial
  distribution simple; a `--enable-gpl` build (e.g. with `libx264`) makes the whole
  distribution GPL. The subtitle burn-in path prefers the `libass`/`subtitles`
  filter when present and otherwise exports a separate SRT, so `--enable-gpl` is
  never a hard requirement.
- No component here is marked non-commercial or research-only.
