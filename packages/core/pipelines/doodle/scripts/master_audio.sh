#!/usr/bin/env bash
# Master a video's audio to YouTube's -14 LUFS reference with a -1 dBTP ceiling,
# using two-pass loudnorm + gentle speech compression. Video stream is copied.
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"

IN="$1"; OUT="$2"
I_TARGET="${3:--14}"          # integrated LUFS target
PRE="highpass=f=80,acompressor=threshold=-20dB:ratio=2.5:attack=5:release=150:makeup=1"

echo ">> pass 1: measure"
JSON=$(ffmpeg -hide_banner -i "$IN" -af "${PRE},loudnorm=I=${I_TARGET}:TP=-1:LRA=11:print_format=json" -f null /dev/null 2>&1 | awk '/^\{/{f=1} f{print} /^\}/{f=0}')
mi=$(echo "$JSON" | jq -r .input_i)
mtp=$(echo "$JSON" | jq -r .input_tp)
mlra=$(echo "$JSON" | jq -r .input_lra)
mthr=$(echo "$JSON" | jq -r .input_thresh)
off=$(echo "$JSON" | jq -r .target_offset)
echo "   measured I=$mi TP=$mtp LRA=$mlra thresh=$mthr offset=$off"

echo ">> pass 2: apply"
ffmpeg -y -hide_banner -loglevel error -i "$IN" -c:v copy \
  -af "${PRE},loudnorm=I=${I_TARGET}:TP=-1:LRA=11:measured_I=${mi}:measured_TP=${mtp}:measured_LRA=${mlra}:measured_thresh=${mthr}:offset=${off}:linear=true" \
  -c:a aac -b:a 192k "$OUT"

echo ">> verify"
ffmpeg -hide_banner -i "$OUT" -af loudnorm=print_format=summary -f null /dev/null 2>&1 | grep -E "Input Integrated|Input True Peak"
ffmpeg -hide_banner -i "$OUT" -af volumedetect -f null /dev/null 2>&1 | grep -E "mean_volume|max_volume"
