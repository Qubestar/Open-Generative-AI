# Editor engine — vendored `editor-v1` kit

This package is **not** a workspace package: it holds the vendored style engine that the
`editor` capability (`packages/core/src/editor*.js`) drives as a child process.

```
skill/            the editor-v1 kit, unchanged except for the additions listed below
  SKILL.md        the kit's own documentation (directive layer)
  reference/      measured numbers: devices, look, rhythm, sound, sourcing
  components/     ev1_devices.py + ev1_more.py — the device library and the `Comp` class
  scripts/        env.sh, transcribe.py, ev1_treat.py, ev1_clip.py, matte.py, bed-mix.py, mix-sfx.py, …
  template/       build.py + PLAN.md (a hand-authored composition) + example/
  assets/         tokens.css, fonts (Inter, Playfair, Bodoni, Arimo, JetBrains Mono — SIL OFL)
  assets/vendor/  gsap.min.js 3.14.2 (GSAP standard licence; NOT shipped in the upstream zip)
  sfx/            the synthesised sound kit
driver/           Vidmyo-owned deterministic drivers (not part of the upstream kit)
  build_from_plan.py    plan.json → comp/index.html + sfx-cues.txt + work/shots.json
  analyze_examples.py   example videos → style-profile.json + contact-sheet.jpg
```

## Proven runtime (this machine)

- HyperFrames **0.8.72** via `node_modules/.bin/hyperframes` (the kit's `env.sh` pins 0.8.181 and
  calls `npx`; Vidmyo calls the local binary instead — do not use `npx`).
- Python 3.13 with numpy, opencv-python, soundfile, faster-whisper 1.2.1.
- ffmpeg 9.0.1 / ffprobe on PATH (or `VIDMYO_FFMPEG_PATH`).
- Smoke test: the kit's own `scripts/preview.py` renders a 7 s composition with 0 lint errors and
  11 device-written sound cues on the stack above.

## Licence

The kit ships with `LICENSE-NOTES.md`. Fonts are SIL OFL (licences beside them), GSAP is used under
the GSAP standard "no charge" licence, the sound kit is synthesised in code. Nothing here is uploaded
anywhere; every render happens locally.
