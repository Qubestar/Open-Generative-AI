# Translate Video

Local video dubbing inside Vidmyo: take a video (link or file), pick a language
pair, and get back a translated video, translated subtitles, a source transcript
and a translation — all produced on this machine.

It exists **once**. The desktop **Translate** tab and the MCP tools
(`translate_video`, `translate_get_job`, …) both call the same
`TranslateService` → `runTranslateJob` over the same job store and project
manifest. The UI runs no inference; the MCP tool contains no pipeline.

```
Translate tab ─┐
Agents (MCP)  ─┼─→ TranslateService ─→ JobStore (durable) ─→ TranslateProject (artifacts)
CLI / scripts ─┘                              │
                                              └─ heavy governor lease (concurrency 1)
```

## Where it lives

| Piece | Path |
|---|---|
| Contract, options, security, project, service | `packages/core/src/translate.js` |
| Local engines (Whisper, Ollama, voices, FFmpeg, Demucs) | `packages/core/src/translateEngines.js` |
| Resumable stage runner | `packages/core/src/translateRunner.js` |
| Python workers | `packages/core/pipelines/translate/scripts/` |
| MCP surface | `mcp/lib/translateService.js`, `mcp/lib/tools.js` |
| Desktop bridge | `electron/lib/translateBridge.js` (+ `preload.js` → `window.translate`) |
| Tab UI | `packages/studio/src/components/TranslateStudio.jsx`, `packages/studio/src/translateModel.mjs` |
| Navigation entry | `components/StandaloneShell.js` (`translate` tab → `/studio/translate`) |

## Inputs

Both input modes converge on one canonical descriptor
(`{ type: 'url' | 'file' | 'media', uri }`) and one media artifact
(`artifacts/source.<ext>`), so everything downstream is identical.

| Input | Notes |
|---|---|
| **Video URL** | `http(s)` only. Downloaded with `yt-dlp` into the project. Playlists are ignored; the size is capped at 4 GiB. |
| **Local file** | Absolute path, chosen through the desktop file picker (which is what authorizes it). MP4, MOV, MKV, WebM, M4V, AVI, MPG, TS. Up to 8 GiB. |

Rejected before any work starts: non-HTTP schemes (`file:`, `ftp:`,
`javascript:`), embedded credentials, `localhost`/`*.local`/`*.internal`, private,
loopback, link-local and CGNAT literals, cloud metadata hostnames, and any public
hostname that **resolves** into those ranges (checked immediately before the
download).

## Pipeline

Stages are recorded in `manifest.json` inside the project, and each writes its own
artifact. A failure in a late stage never re-runs an earlier one; a retry starts
from the first unfinished stage.

| Stage | Artifact |
|---|---|
| `import` | `artifacts/source.<ext>`, `artifacts/media.json` |
| `analyze` | `artifacts/media-info.json` (FFprobe) |
| `extract_audio` | `artifacts/source.asr.wav` (16 kHz mono), `artifacts/source.audio.wav` |
| `transcribe` | `artifacts/transcript.json` (segments, word timings, detected language) |
| `translate` | `artifacts/translation.json` (per line: source text, translated text, target duration) |
| `synthesize` | `artifacts/voice/<seg>.wav`, `artifacts/voice/index.json` |
| `align` | `artifacts/voice/fitted/<seg>.wav`, `artifacts/alignment.json` (rate, action, adaptations) |
| `mix` | `artifacts/speech.wav`, `artifacts/mixed.wav`, `artifacts/audio_mix.json` |
| `subtitles` | `artifacts/subtitles.<target>.srt`, `artifacts/subtitles.<source>.srt` |
| `lipsync` | optional, experimental — skipped with a warning when unconfigured |
| `render` | `artifacts/video.<target>.mp4` |
| `validate` | `artifacts/processing_report.json` + the output manifest |

`translate_audio: false` plans a subtitles-only job (no voice, no mix).
`lip_sync: true` adds an optional stage that can degrade without failing the job.
The same is true of source separation and subtitle burn-in.

## Options

| Option | Values | Default |
|---|---|---|
| `source_language` | `auto` or an ISO code | `auto` |
| `target_language` | ISO code (`pl`, `es`, `de`, …) | `pl` |
| `translate_audio` | boolean | `true` |
| `clone_voice` | boolean (needs `voice_id`) | `true` |
| `voice_id` | local Voicebox profile id | `null` |
| `preserve_background` | boolean | `true` |
| `background_mode` | `duck`, `separate`, `keep`, `replace` | `duck` |
| `subtitles` / `burn_subtitles` | boolean | `true` / `false` |
| `lip_sync` | boolean (experimental) | `false` |
| `quality` | `fast`, `quality` | `quality` |
| `translation_model` / `transcription_model` | override the local model | `null` |

**Background handling.** `duck` lowers the original track under the dub with a
sidechain compressor (the music is untouched between lines). `separate` runs local
Demucs and mixes the speech-removed stem instead, so the original voice is gone
rather than turned down. `keep` and `replace` are the two extremes. Measured
numbers for each mode are in [PERFORMANCE.md](PERFORMANCE.md).

**Language pairs** are discovered, never hardcoded in the UI:
`GET translate_capabilities` (MCP) / `translate:capabilities` (IPC) reports the
supported source/target languages, the voice-clone languages, and which optional
stages exist on this machine. A target that translation supports but voice cloning
does not is offered with an explicit "standard voice will be used" warning — never
a silent downgrade, and never a silent move to a cloud API.

## Local-only guarantees

- Transcription: `faster-whisper`, run by a local Python worker with an argument
  array (never a shell string).
- Translation: a **local** Ollama (or any loopback OpenAI-compatible) server. If
  no local model is reachable the job fails rather than falling back to a paid API.
- Voice: local Voicebox/Chatterbox profile when cloning is requested, otherwise
  the macOS system voice. Cloning requires a profile the user created.
- Separation: local Demucs (CPU or Metal/MPS).
- The only network access in the whole feature is fetching a video the user
  explicitly supplied by URL. Model downloads happen on first use of a model.

## Voice consent

Voice cloning is offered for legitimate localisation and dubbing of material the
user has the right to translate. The UI shows “Use voice cloning only with
permission from the speaker.” next to the option, and cloning only ever uses a
profile the user created locally.

## Configuration (environment)

| Variable | Purpose |
|---|---|
| `VIDMYO_TRANSLATE_ASR_MODEL` / `_FAST` / `_QUALITY` | Whisper model per quality preset (`base` / `small` by default) |
| `VIDMYO_TRANSLATE_ASR_COMPUTE_TYPE` | `int8` by default |
| `VIDMYO_TRANSLATE_MODEL_DIR` | Whisper model cache |
| `VIDMYO_TRANSLATE_PYTHON` | Python used for the Whisper/Demucs workers |
| `VIDMYO_TRANSLATE_MODEL` / `VIDMYO_TRANSLATE_OLLAMA_URL` | Translation model / server |
| `VIDMYO_VOICEBOX_URL` | Voicebox endpoint (default `http://127.0.0.1:17493`) |
| `VIDMYO_TRANSLATE_DEMUCS` / `_MODEL` / `_DEVICE` | `0` disables separation; model defaults to `htdemucs`, device `auto` (MPS on Apple Silicon) |
| `VIDMYO_TRANSLATE_LIPSYNC` | `1` to enable the experimental stage |
| `VIDMYO_YTDLP_PATH`, `VIDMYO_FFMPEG_PATH`, `VIDMYO_FFPROBE_PATH` | Override binary discovery |

## Resource behaviour

A translate job holds one **heavy** governor lease for its entire run, and heavy
concurrency is 1, so a second translation queues instead of competing for 16 GB.
Children inherit the job's cancellation signal and are killed as a process group;
they never re-acquire (and so can never release) the job's lease.

## Tests

```bash
npm test                                             # all @vidmyo/core suites, incl. translate
node --test packages/core/test/translate.test.js     # pipeline/security contract (mocked engines)
node --test packages/core/test/translateModel.test.js # tab presentation rules
cd mcp && node --test test/translateTools.test.js    # MCP schema + argument mapping
node packages/core/scripts/translate-e2e.mjs         # REAL end-to-end (see E2E.md)
```
