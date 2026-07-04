#!/usr/bin/env bash
# Upscale a finished doodle video to 4K (3840x2160). Two reasons this helps our channel:
#   1) YouTube gives >=1440p/4K uploads a much higher bitrate + better codec (VP9/AV1), so our bold
#      text / flat colors / hard outlines stay crisp instead of getting smeared by 1080p compression.
#   2) Flat doodle art upscales cleanly (hard edges, no photographic noise) — best case for upscaling.
#
# Usage:
#   pipeline/upscale_4k.sh <in.mp4> <out.mp4>
# Order in the pipeline: assemble.py -> [this, optional] -> master_audio.sh -> thumbnail -> upload.
# (master_audio copies the video stream, so it won't undo the 4K.)
#
# NOTE ON REAL DETAIL: this lanczos+unsharp pass unlocks YouTube's 4K bitrate and sharpens edges, but
# adds no *new* detail (source frames are ~1376x768). For genuine source detail, upscale the ~50
# doodle stills BEFORE assembling — that's far fewer images than video frames and gives real crispness:
#   realesrgan-ncnn-vulkan -n realesrgan-x4plus-anime -s 4 -i images/ -o images_4k/   # if installed
#   (then run assemble.py on images_4k/ and skip this script). Install: brew install realesrgan  (or
#   the ncnn-vulkan release binary). Anime/line-art model is ideal for doodles.

set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"

IN="${1:?usage: upscale_4k.sh <in.mp4> <out.mp4>}"
OUT="${2:?usage: upscale_4k.sh <in.mp4> <out.mp4>}"

echo ">> upscaling to 3840x2160 (lanczos + light edge sharpen)…"
ffmpeg -y -hide_banner -loglevel error -i "$IN" \
  -vf "scale=3840:2160:flags=lanczos,unsharp=5:5:0.6:5:5:0.0,format=yuv420p" \
  -c:v libx264 -preset medium -crf 18 -movflags +faststart \
  -c:a copy "$OUT"

echo ">> done: $OUT"
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,codec_name -of default=nk=1:nw=1 "$OUT" | paste -sd' ' -
