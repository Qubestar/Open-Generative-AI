# Caption studio and local upscaling

Implemented 2026-09-03. These are local features; no provider/API/subscription calls.

## Using the controls

After Cut previews / Frame vertical, open **Choose a caption look** in Finish settings.
Choose Clean, Impact, Outline, Word highlight, One word, or Editorial. Toggle **Text
background**, choose Higher / Middle / Lower, choose a bundled font, and use a color
preset or custom hex color. The brand sample updates immediately. Close with **Use this look**, then
Finish the selected approved clips. The demo uses sample words and the same Pillow
renderer/fonts as the export; it is not a preview of your transcript. Timed styles
use the actual transcription word timestamps in final video. The video frame itself
is never moved to make room for captions. Earlier OpenCV Clean/Bold artifacts remain
readable. New styles use bundled Barlow Condensed and Anton with readable outlines.
Montserrat is also bundled from the inspected Perfect Clips package under its SIL OFL
notice. Brand variants use distinct deterministic filenames, preserving earlier exports.

## Perfect Cuts / Perfect Clips study

Studied the complete 16:21 demonstration, its 278 native caption segments, 35 scene
frames, 18 focused cue frames, and the supplied Perfect Clips v1 / Perfect Cuts v2
source packages on 2026-09-03. The reference dashboard exposes a one-word colored
caption chip, four color choices (including custom hex), Montserrat or a custom font
path, output aspect mode, and target clip count. Vidmyo keeps its stronger six-look
visual gallery and adds the useful color/font controls without accepting arbitrary
local font paths.

The new **Stack left + right** vertical framing mode is deterministic: it splits a
side-by-side source at its midpoint, crops each half into a 1080×960 panel, and places
left above right. Use it only when the source composition itself is reliably left/right.
Existing **Auto crop** remains better when Vidmyo should follow speakers and can already
create a tracked two-speaker split. The reference video's presenter explicitly says
the skill was tested on a single-speaker video and not yet on two speakers, so its
marketing was not treated as validation of generic two-person detection.

Ideas worth considering later are an optional headline chip and an opt-in hook teaser
with a before/after preview. Automatic background music was not copied: rights,
licensing, speech masking, and mood errors need a separate product decision. Arbitrary
TTF paths were also rejected because a desktop project must remain portable and should
not make its renderer read unvalidated files outside the project/runtime.

For existing finished clips, keep/select the clips you want, choose **Export resolution
→ 4K · 2160 × 3840**, then **Render again with these settings**. Gentle sharpening is
optional. No need to rerun transcription, moments, ranking, or framing just to change
captions/resolution. A matching validated captioned master is reused. 4K filenames
have a separate suffix, so original 1080p files remain on disk. The shelf displays the
latest output dimensions. Earlier exports remain accessible through the project folder.

This is **Lanczos resizing**, optionally followed by low-strength luma sharpening,
not neural/AI restoration. It does not reconstruct missing original detail. It also
does not undo compression, remove blur, or improve topic selection. Expect more
render time and disk use. Encodes keep audio, duration, source frame cadence, H.264/AAC,
progress, cancellation, and validation before final replacement. 4K presets allow
40 Mb/s rather than reusing the 1080p bitrate ceiling.

The test recording is 1920×1080 at 30 fps. A portrait crop necessarily discards much
of its horizontal picture before enlargement. For that material, **Fit full frame**
can retain more source information than a tight portrait crop; neither scaling mode
can invent authentic source detail.

## Research and scope

Primary sources inspected on 2026-09-03:

- [CapCut: types of captions](https://www.capcut.com/resource/types-of-captions)
  describes standard, minimal, aesthetic, highlight, word-synchronized, animated, and
  uppercase treatments. These informed six original Vidmyo presets. This is evidence
  of current supported/common treatments, **not a measured ranking of viral styles**.
- [CapCut: subtitle guide](https://www.capcut.com/resource/add-subtitles-to-video)
  recommends readable type, colored emphasis, outlines or semi-transparent backing,
  and adaptation to the platform. We expose background separately from the style.
- [CapCut: caption templates](https://www.capcut.com/resource/caption-template)
  shows a browse/customize approach; Vidmyo uses rendered swatches and a larger demo.
  No proprietary templates, fonts, graphics, branding, or assets were copied.
- [Remotion captions](https://www.remotion.dev/docs/captions/): evaluated as an
  alternative ecosystem. Not incorporated; retaining the existing local renderer
  avoids adding another video renderer and licensing/deployment complexity.
- [FFmpeg scaling](https://ffmpeg.org/ffmpeg-scaler.html) and
  [unsharp filter](https://ffmpeg.org/ffmpeg-filters.html#unsharp-1): existing open-source
  runtime supplies Lanczos scaling and optional gentle sharpening without model downloads.
- [Real-ESRGAN NCNN](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan) and its
  [MIT license](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/blob/master/LICENSE):
  evaluated for genuine neural restoration. **Not integrated or installed.** It would
  require model/runtime distribution, GPU compatibility checks, video temporal-quality
  evaluation, and separate resource/cancellation handling. Do not label this release
  “AI upscaling” or imply Real-ESRGAN runs underneath it.
- Fonts: [Barlow](https://github.com/google/fonts/tree/main/ofl/barlowcondensed) and
  [Anton](https://github.com/google/fonts/tree/main/ofl/anton), redistributed unchanged
  with their SIL Open Font License notices under the engine's `fonts/` package data.
  [Pillow](https://github.com/python-pillow/Pillow) supplies local text/PNG drawing.

## Maintenance

Run `PYTHONPATH=packages/repurpose-engine/src python3 packages/repurpose-engine/scripts/generate_caption_previews.py`
after changing caption typography. This regenerates the bundled JSON images from the
production renderer, avoiding browser-font/export-font mismatch. Update the captioner
version when render behavior changes. Worker package requires Pillow 11–12 and bundles
the two fonts and license files; no font download occurs during use.

Existing render artifacts without `upscale_mode` mean 1080p. Masters remain 1080×1920;
export dimensions must match the explicit mode. Modes are `off`, `lanczos_4k`, and
`lanczos_4k_sharp`. UI settings restore from the last render artifact on reopening;
unrendered edits remain local UI state.

Design guidance used: frontend-design for the focused dark preview/picker layout,
captions-overlay for overlays without altering the picture layout, karpathy-guidelines
for preserving the existing renderer and limiting dependencies, and Playwright for
browser verification. Embedded-captions was inspected as a referenced production-video
skill; its matting/transcription/scene-effects workflow does not apply to this app feature.
