# Translate Video — real end-to-end run

`packages/core/scripts/translate-e2e.mjs` runs the **production** engines — not
fakes — against a fixture it builds itself. It is the check that catches things a
mocked suite cannot: FFmpeg filter-graph mistakes, a duck that is too shallow, a
bed that gets truncated, a TTS voice that is missing.

## What it does

1. Builds a reference fixture with the macOS system voice: an English script with
   a deliberate 900 ms pause, laid over a two-tone music bed, muxed into a
   1280×720 H.264 MP4.
2. Runs three legs through the same `TranslateService` + `createTranslateEngines`
   the tab and the MCP tools use:
   - **local-file** — `background_mode: duck` (default)
   - **url** — the same pipeline through the URL ingest path
   - **separate** — real Demucs source separation
3. Verifies each result independently:
   - FFprobe on the output (streams, duration vs source),
   - the translated SRT,
   - **re-transcribes the finished audio** to confirm the dub is really there and
     the source speech is no longer dominant (a shallow duck is invisible to a
     duration check and obvious to a human),
   - measures the bed level in a dialogue window and a music-only window for the
     source, the output and the separated stems.
4. Writes `e2e-report.json` with measured stage timings and memory sampling.

## Run it

```bash
node packages/core/scripts/translate-e2e.mjs                     # default: EN → PL
node packages/core/scripts/translate-e2e.mjs --target es --model small
VIDMYO_E2E_DIR=/tmp/translate-run node packages/core/scripts/translate-e2e.mjs
```

Requirements: FFmpeg/FFprobe on `PATH` (or `VIDMYO_FFMPEG_PATH`), Python with
`faster-whisper`, a running local Ollama with a multilingual model, and — for the
separate leg — Demucs (`python3 -m pip install demucs`). Missing Demucs does not
fail the run: the leg degrades to ducking and records why.

First run downloads the Whisper model and the Demucs weights; later runs reuse the
caches.

## Honest limitations of this harness

- The **URL leg substitutes the transport only.** `yt-dlp` cannot be pointed at an
  unroutable test hostname, so the leg fetches the fixture from a loopback HTTP
  server started by the script (`e2e-http-import`). Input validation, SSRF
  rejection, input normalization, and every downstream stage are the production
  ones. The real `yt-dlp` invocation is exercised when a genuine public URL is
  translated from the app or an agent.
- The fixture is synthetic (system voice + tones). It is designed for
  *measurability*, not for judging translation quality; listen to the output
  before shipping a real video.
- Memory is sampled from `os.freemem()`; on macOS that includes reclaimable cache,
  so treat `peakUsedGb` as a ceiling rather than a resident-set figure.

## Results

Measured numbers, per-stage timings and the background-handling measurements from
the last real run live in [PERFORMANCE.md](PERFORMANCE.md).
