#!/usr/bin/env bash
# One-time environment setup for the faceless-doodle-video pipeline.
# Creates a local venv next to this script and installs everything needed.
# Everything runs offline & free afterward (Kokoro TTS, whisper, Pillow).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="$HERE/.venv"

echo ">>> espeak-ng (Kokoro G2P dependency)"
which espeak-ng >/dev/null 2>&1 || brew install espeak-ng

echo ">>> python venv (3.12 for stable wheels)"
command -v uv >/dev/null 2>&1 && uv venv --python 3.12 "$VENV" || python3 -m venv "$VENV"

PIP="$VENV/bin/pip"; command -v uv >/dev/null 2>&1 && PIP="uv pip install --python $VENV"
echo ">>> installing kokoro + faster-whisper + soundfile + pillow (pulls torch — large)"
$PIP kokoro soundfile faster-whisper pillow

echo ">>> spaCy English model (Kokoro G2P needs this, or it crashes 'No virtual environment found')"
$PIP "en_core_web_sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl"

echo ">>> verify"
"$VENV/bin/python" -c "import kokoro, soundfile, faster_whisper, en_core_web_sm, PIL; print('env OK')"
echo ">>> done. Use: $VENV/bin/python scripts/<tool>.py ..."
