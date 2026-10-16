# Translate Video — measured performance

All numbers below are from a real run of
`packages/core/scripts/translate-e2e.mjs` on the target machine. Nothing here is
estimated.

## Machine

| | |
|---|---|
| CPU / RAM | Apple Silicon M2 Pro, 16 GB unified |
| OS | macOS 26.5 |
| FFmpeg | 9.0.1 (LGPL build, `libx264`, `libass`, `sidechaincompress`, `loudnorm`) |
| Python | 3.13.3 · faster-whisper 1.2.1 (CTranslate2, `int8`, CPU) |
| Translation | Ollama, `llama3.1:8b`, local HTTP |
| Voice | macOS `say` (Zosia, `pl_PL`) — no cloning profile configured in this run |
| Separation | Demucs 4.1.0 / `htdemucs` on Metal (MPS), PyTorch 2.13.0 |

## Fixture

Deliberately small and measurable: 30 s 1280×720 H.264 video, a two-tone music bed
for the full duration, and ~9.2 s of English speech with a 900 ms pause in the
middle. The music-only measurement window is 12–20 s, where nothing but the bed
exists.

## End-to-end results

Source duration 30.0 s → output duration 30.0 s for all three legs.
Output: H.264 + AAC 48 kHz stereo, ~1.1 MB.

| Stage | `duck` (local file) | `duck` (URL) | `separate` (Demucs) |
|---|---|---|---|
| import | 2 ms | 14 ms | 3 ms |
| analyze (FFprobe) | 30 ms | 92 ms | 70 ms |
| extract audio | 124 ms | 123 ms | 119 ms |
| **transcribe** (faster-whisper `base`, int8) | 9 655 ms | 11 521 ms | 8 354 ms |
| **translate** (Ollama `llama3.1:8b`, 3 lines) | 3 618 ms | 3 683 ms | 3 457 ms |
| **synthesize** (macOS `say`, 3 lines) | 4 379 ms | 4 930 ms | 3 278 ms |
| align (atempo / adaptation) | 2 664 ms | 3 393 ms | 2 548 ms |
| **mix** (sidechain duck) | 834 ms | 885 ms | — |
| **mix** (Demucs + mix) | — | — | 10 913 ms |
| subtitles (SRT) | 3 ms | 1 ms | 4 ms |
| render (mux / re-encode) | 550 ms | 506 ms | 433 ms |
| validate (FFprobe) | 39 ms | 29 ms | 31 ms |
| **total** | **21.9 s** | **25.2 s** | **29.2 s** |

Roughly 0.7–1.0× real time for a video whose audio is mostly speech, with
transcription and translation dominating. Cost: **$0** — every stage is local, and
there is no paid API in the feature.

## Background handling (the number that matters)

Bed level in the dialogue window and in the music-only window, measured with
FFmpeg `volumedetect` (mean volume, dB).

| Leg | source bed (dialogue) | output (dialogue) | source bed (music) | output (music) | music preserved | source speech removed |
|---|---|---|---|---|---|---|
| `duck` (local) | −19.5 | −18.3 | −30.2 | −30.2 | **0.00 dB** | ~13 dB duck under the dub |
| `duck` (URL) | −19.5 | −19.1 | −30.2 | −30.2 | **0.00 dB** | ~13 dB duck under the dub |
| `separate` | −19.5 | −20.0 | −30.2 | −30.8 | **−0.6 dB** | stem: −29.2 (9.7 dB below the source), vocals stem −20.1 |

Demucs stems from the `separate` run:

- `background` (speech removed): dialogue −29.2 dB, music −30.3 dB → the bed
  survives untouched while the source speech is gone.
- `vocals` (speech): dialogue −20.1 dB, music **−82.5 dB** → pure speech, no music
  bleed.

**Honest conclusion.** `duck` preserves music *perfectly* but only lowers the
original voice; on a source that is mostly speech, an independent
re-transcription of the finished dub still recovers source words (it did so in one
of the two duck runs, and not in the other — the residue sits close to the
detection threshold). `separate` costs ~10 s more per 30 s of audio and needs
Demucs installed, but it is the mode that actually removes the source voice:
re-transcription of the separated output found **zero** source words. That is why
the desktop tab starts from `separate` whenever capability discovery reports it is
available, and falls back to `duck` when it is not.

## Model and package disk usage

| Item | Size |
|---|---|
| `faster-whisper` `base` model | 141 MB |
| `faster-whisper` `small` model (the `quality` preset) | 464 MB |
| `faster-whisper` `medium` (optional) | 1.4 GB |
| PyTorch (CPU/MPS) | 492 MB |
| Demucs + `htdemucs` weights | ~20 MB cache + package |
| Translation LLM | **user-chosen** — `llama3.1:8b` ≈ 4.9 GB in Ollama |
| Voice cloning (Voicebox/Chatterbox) | provider's own footprint; not bundled |

Only the ASR model and the translation LLM are needed for a `duck` job; Demucs is
optional and installed on demand.

## Memory

Sampled every 500 ms during the run: system total 16 GB, minimum free
**0.09 GB**, reported peak used **15.91 GB**. On macOS "free" excludes reclaimable
cache, so read this as a ceiling rather than a resident-set figure — the run
completed with no swap thrash and no governor admission failure.

Concurrency behaviour that produced these numbers: a translate job holds one
**heavy** governor lease for its whole run, and heavy concurrency is 1, so a second
translation queues rather than competing for memory. Stages run sequentially and
each child process exits before the next stage starts, so Whisper, the translation
LLM, Demucs and FFmpeg are never resident at the same time.

## Model on-demand performance notes

- `htdemucs` on MPS separated 17.5 s of audio in **3.98 s** (~4.4× real time) in
  an isolated measurement; inside a job the `mix` stage took 10.9 s for 30 s of
  audio including the one-time model load. Set `VIDMYO_TRANSLATE_DEMUCS_DEVICE=cpu`
  to fall back to CPU.
- Transcription scales with the model: `base` processes this fixture in ~8–11 s.
  The `quality` preset uses `small`; set `VIDMYO_TRANSLATE_ASR_MODEL` to trade
  accuracy for time.
- Translation cost is one LLM call per 25 lines of dialogue, so it grows with line
  count, not video length.

## Environment findings worth knowing

Two FFmpeg builds exist on this machine and **they are not equivalent**:

| Build | Version | libass (subtitle burn-in) | Everything else Translate needs |
|---|---|---|---|
| `/opt/homebrew/bin/ffmpeg` (the default this pipeline resolves) | 8.1.1, `--enable-gpl`, `--enable-libx264` | **absent** | present — `sidechaincompress`, `loudnorm`, `atempo`, `amix`, `apad`, `asplit`, `atrim`, `volumedetect` |
| `~/.hermes/tools/ffmpeg-9.0.1-darwin-arm64/ffmpeg` | 9.0.1 | present | present |

Consequence: on the default build, `translate_capabilities` reports
`burn_subtitles: false`, the tab explains that a separate SRT will be produced
instead, and the renderer skips burn-in with a warning rather than failing. Set
`VIDMYO_FFMPEG_PATH` to a libass build (or install `ffmpeg` with `--enable-libass`)
and burn-in becomes available with no code change — capability discovery picks it
up per binary.

`resolveFfmpegBinary()` chooses the binary (`VIDMYO_FFMPEG_PATH` →
managed package → `which ffmpeg`), and the capability probe is cached per
(path, mtime, size), so switching builds takes effect immediately.

## Reproducing

```bash
node packages/core/scripts/translate-e2e.mjs            # writes e2e-report.json
```

See [E2E.md](E2E.md) for what the harness measures and where it substitutes the
transport for the URL leg.
