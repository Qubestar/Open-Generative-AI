#!/usr/bin/env bash
# Finalize a Curio video for upload in ONE step (runs on EVERY video by default):
#   1) upscale to 4K (3840x2160) — YouTube gives 4K a higher bitrate so bold text/flat colors stay
#      crisp; flat doodle art upscales cleanly.
#   2) master audio to -14 LUFS (two-pass loudnorm + gentle compression, -1 dBTP).
# Output is the upload-ready MP4 (name it the SEO filename, e.g. why-you-wake-up-at-2am.mp4).
#
# Usage: pipeline/finalize_video.sh <assembled.mp4> <out.mp4>
# Pipeline order: assemble.py -> finalize_video.sh -> thumbnail -> upload_to_drive.sh -> n8n.
#
# To DISABLE 4K for one run (audio-master only): NO4K=1 pipeline/finalize_video.sh in.mp4 out.mp4
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"
HERE="$(cd "$(dirname "$0")" && pwd)"

IN="${1:?usage: finalize_video.sh <in.mp4> <out.mp4>}"
OUT="${2:?usage: finalize_video.sh <in.mp4> <out.mp4>}"

if [ "${NO4K:-0}" = "1" ]; then
  echo ">> [4K skipped via NO4K=1] mastering audio only"
  bash "$HERE/master_audio.sh" "$IN" "$OUT"
else
  TMP="$(dirname "$OUT")/.finalize_4k_tmp.mp4"
  echo ">> [1/2] 4K upscale"
  bash "$HERE/upscale_4k.sh" "$IN" "$TMP"
  echo ">> [2/2] master audio to -14 LUFS"
  bash "$HERE/master_audio.sh" "$TMP" "$OUT"
  rm -f "$TMP"
fi
echo ">> finalized (upload-ready): $OUT"
ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$OUT"
