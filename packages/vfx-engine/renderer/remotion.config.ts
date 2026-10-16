import {Config} from '@remotion/cli/config';

Config.setOverwriteOutput(true);
// PNG intermediate frames: LOSSLESS handoff to the encoder. The previous
// jpeg@95 intermediate quantized every frame before x264 ever saw it
// (~30dB y-PSNR on dark grainy footage vs ~48dB for a straight CRF16
// re-encode; soft blob artifacts + chroma damage from JPEG's internal
// BT.601 roundtrip). Caught by the PSNR parity gate 2026-07-16. Slower
// per frame, but this skill is quality-first: CRF16 is only "visually
// transparent" if the frames feeding it are clean.
Config.setVideoImageFormat('png');
// Errors only by default so renders never stream progress spam; a CLI
// --log=<level> flag overrides this when debugging is needed.
Config.setLevel('error');
