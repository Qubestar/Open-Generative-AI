#!/usr/bin/env python3
"""
YouTube Transcript Writer
=========================
Turn any local video/audio file into a clean, accurate .srt caption file that
is ready to upload to YouTube (Studio -> Subtitles -> Upload file).

Everything runs 100% locally:
  - ffmpeg            pulls a 16 kHz mono audio track from your file
  - WhisperX          transcribes + force-aligns word-level timestamps
  - (this script)     rebuilds the captions into clean, non-overlapping cues

No API keys. No uploads. Nothing about your video ever leaves your machine.

Why not just use WhisperX's own .srt output? Its writer duplicates the segment
timestamp across every wrapped line, which produces overlapping/duplicate cues
that misbehave on upload. This rebuilds captions from the word-level alignment
so every cue gets a unique, exact start/end.

USAGE
  python transcribe_to_srt.py "my video.mp4"
  python transcribe_to_srt.py "my video.mp4" --model medium --out "captions.srt"

Run with -h for all options.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# ---------------------------------------------------------------------------
# Caption shape (YouTube-friendly defaults). Override via CLI flags.
# ---------------------------------------------------------------------------
DEFAULTS = dict(
    max_chars_per_line=42,   # readable line width
    max_lines=2,             # never more than 2 lines on screen
    max_dur=6.0,             # hard cap on a single cue (seconds)
    max_gap_split=0.8,       # a silence >= this forces a new cue (seconds)
    min_dur=0.7,             # stretch ultra-short cues to at least this
)


# ---------------------------------------------------------------------------
# Tool discovery
# ---------------------------------------------------------------------------
def find_ffmpeg():
    exe = shutil.which("ffmpeg")
    if not exe:
        sys.exit(
            "ERROR: ffmpeg not found on PATH.\n"
            "  macOS:   brew install ffmpeg\n"
            "  Windows: winget install ffmpeg\n"
            "  Linux:   sudo apt install ffmpeg (or your distro's package)"
        )
    return exe


def find_whisperx():
    """Look in common venv locations, then PATH."""
    home = Path.home()
    candidates = []
    for base in (".youtube-transcript-writer", ".perfect-cuts", ".buttercut"):
        candidates.append(home / base / "venv" / "Scripts" / "whisperx.exe")  # Windows
        candidates.append(home / base / "venv" / "bin" / "whisperx")          # mac/linux
    for c in candidates:
        if c.exists():
            return str(c)
    onpath = shutil.which("whisperx")
    if onpath:
        return onpath
    sys.exit(
        "ERROR: WhisperX not found.\n"
        "Install it once (needs Python 3.10-3.12):\n\n"
        "  # macOS / Linux\n"
        "  python3.12 -m venv ~/.youtube-transcript-writer/venv\n"
        "  ~/.youtube-transcript-writer/venv/bin/pip install 'whisperx==3.4.2' \\\n"
        "      'pyannote-audio==3.4.0' 'torch==2.8.0' 'torchaudio==2.8.0'\n\n"
        "  # Windows (PowerShell)\n"
        '  python -m venv "$env:USERPROFILE\\.youtube-transcript-writer\\venv"\n'
        '  & "$env:USERPROFILE\\.youtube-transcript-writer\\venv\\Scripts\\pip.exe" install `\n'
        "      'whisperx==3.4.2' 'pyannote-audio==3.4.0' 'torch==2.8.0' 'torchaudio==2.8.0'\n\n"
        "Versions are pinned on purpose: a known-good combo. Don't let pip upgrade them."
    )


# ---------------------------------------------------------------------------
# Pipeline steps
# ---------------------------------------------------------------------------
def extract_audio(ffmpeg, src, wav_path):
    subprocess.run(
        [ffmpeg, "-nostdin", "-y", "-i", str(src),
         "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav_path)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def run_whisperx(whisperx, wav_path, out_dir, model, language, device):
    env = dict(os.environ)
    env["TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD"] = "1"  # torch >=2.6 weights_only breaks pyannote VAD
    cmd = [whisperx, str(wav_path),
           "--model", model,
           "--compute_type", "float32",   # required on CPU
           "--device", device,
           "--output_format", "json",
           "--output_dir", str(out_dir)]
    if language and language.lower() != "auto":
        cmd += ["--language", language]
    subprocess.run(cmd, check=True, env=env)
    stem = Path(wav_path).stem
    js = Path(out_dir) / f"{stem}.json"
    if not js.exists():
        # whisperx names output after the input stem; find any json as a fallback
        found = list(Path(out_dir).glob("*.json"))
        if not found:
            sys.exit("ERROR: WhisperX produced no JSON output.")
        js = found[0]
    return js


# ---------------------------------------------------------------------------
# Caption builder (rebuild from word-level timestamps)
# ---------------------------------------------------------------------------
def fmt(t):
    if t is None or t < 0:
        t = 0.0
    h = int(t // 3600); t -= h * 3600
    m = int(t // 60); t -= m * 60
    s = int(t)
    ms = int(round((t - s) * 1000))
    if ms == 1000:
        s += 1; ms = 0
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def load_words(path):
    data = json.load(open(path, encoding="utf-8"))
    words = []
    for seg in data.get("segments", []):
        for w in seg.get("words", []):
            txt = (w.get("word") or "").strip()
            if txt:
                words.append({"w": txt, "s": w.get("start"), "e": w.get("end")})
    # backfill missing start/end from neighbours so timing never breaks
    for i, w in enumerate(words):
        if w["s"] is None:
            w["s"] = (words[i - 1]["e"] if i > 0 and words[i - 1]["e"] is not None
                      else (words[i - 1]["s"] if i > 0 else 0.0))
        if w["e"] is None:
            w["e"] = (words[i + 1]["s"] if i + 1 < len(words) and words[i + 1]["s"] is not None
                      else w["s"])
    for w in words:
        if w["s"] is None:
            w["s"] = 0.0
        if w["e"] is None or w["e"] < w["s"]:
            w["e"] = w["s"]
    return words


def wrap(text, cfg):
    out, cur = [], ""
    for wd in text.split():
        cand = (cur + " " + wd).strip()
        if len(cand) <= cfg["max_chars_per_line"] or not cur:
            cur = cand
        else:
            out.append(cur); cur = wd
    if cur:
        out.append(cur)
    return "\n".join(out[:cfg["max_lines"]]) if len(out) <= cfg["max_lines"] else None


def fits(words, cfg):
    return wrap(" ".join(w["w"] for w in words), cfg) is not None


def build_cues(words, cfg):
    cues, cur = [], []
    for w in words:
        if cur:
            gap = w["s"] - cur[-1]["e"]
            dur = w["e"] - cur[0]["s"]
            if gap >= cfg["max_gap_split"] or dur > cfg["max_dur"] or not fits(cur + [w], cfg):
                cues.append(cur); cur = [w]; continue
        cur.append(w)
        if cur[-1]["w"].endswith((".", "!", "?")) and (cur[-1]["e"] - cur[0]["s"]) >= 1.2:
            cues.append(cur); cur = []
    if cur:
        cues.append(cur)
    return cues


def write_srt(words, out_srt, cfg):
    cues = build_cues(words, cfg)
    lines, prev_end = [], 0.0
    for idx, cue in enumerate(cues, 1):
        text = wrap(" ".join(w["w"] for w in cue), cfg) or " ".join(w["w"] for w in cue)
        start, end = cue[0]["s"], cue[-1]["e"]
        if end - start < cfg["min_dur"]:
            end = start + cfg["min_dur"]
        if start < prev_end:
            start = prev_end
        if end <= start:
            end = start + cfg["min_dur"]
        prev_end = end
        lines += [str(idx), f"{fmt(start)} --> {fmt(end)}", text, ""]
    Path(out_srt).write_text("\n".join(lines), encoding="utf-8")
    return len(cues)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(
        description="Turn a local video/audio file into a YouTube-ready .srt (runs 100%% locally).")
    ap.add_argument("input", help="Path to the video or audio file.")
    ap.add_argument("--out", help="Output .srt path (default: alongside the input file).")
    ap.add_argument("--model", default="small",
                    help="Whisper model: tiny/base/small/medium/large-v3 (default: small). "
                         "Bigger = better word accuracy, slower. Timestamps are force-aligned "
                         "either way.")
    ap.add_argument("--language", default="en",
                    help="Language code (default: en). Use 'auto' to detect.")
    ap.add_argument("--device", default="cpu", help="cpu or cuda (default: cpu).")
    ap.add_argument("--max-line-width", type=int, default=DEFAULTS["max_chars_per_line"])
    ap.add_argument("--max-lines", type=int, default=DEFAULTS["max_lines"])
    ap.add_argument("--max-dur", type=float, default=DEFAULTS["max_dur"])
    args = ap.parse_args()

    src = Path(args.input)
    if not src.exists():
        sys.exit(f"ERROR: file not found: {src}")

    cfg = dict(DEFAULTS)
    cfg["max_chars_per_line"] = args.max_line_width
    cfg["max_lines"] = args.max_lines
    cfg["max_dur"] = args.max_dur

    out_srt = Path(args.out) if args.out else src.with_suffix(".srt")

    ffmpeg = find_ffmpeg()
    whisperx = find_whisperx()

    with tempfile.TemporaryDirectory(prefix="ytw-") as tmp:
        wav = Path(tmp) / "audio.wav"
        print(f"[1/3] Extracting audio  ->  {wav.name}")
        extract_audio(ffmpeg, src, wav)

        print(f"[2/3] Transcribing with WhisperX (model={args.model}, device={args.device}) ...")
        js = run_whisperx(whisperx, wav, tmp, args.model, args.language, args.device)

        print("[3/3] Building clean captions ...")
        words = load_words(js)
        n = write_srt(words, out_srt, cfg)

    print(f"\nDone. {n} caption cues written to:\n  {out_srt}")
    print("Upload it in YouTube Studio -> Subtitles -> Add language -> Upload file (with timing).")


if __name__ == "__main__":
    main()
