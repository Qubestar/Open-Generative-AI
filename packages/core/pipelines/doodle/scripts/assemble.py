#!/usr/bin/env python3
"""
assemble.py — stitch beat images + voiceover into the final 1080p MP4.

Reads beats.json (start/end per beat) and images/<beat id>.png, renders one Ken-Burns
clip per beat sized to 1920x1080 for that beat's exact duration, hard-cuts on the VO pauses
(Zenn style), then muxes the voiceover. Missing images become a white frame (timing preserved)
and are reported so you can fill the gaps.

Usage:
    pipeline/.venv/bin/python pipeline/assemble.py videos/NN-slug [--fps 30] [--zoom 0.08]
                                                   [--crossfade 0] [--ext png]
Requires: ffmpeg on PATH.
"""
import argparse, json, os, subprocess, sys, tempfile, shutil

W, H = 1920, 1080


def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        sys.stderr.write(p.stderr[-2000:])
        raise SystemExit(f"ffmpeg failed: {' '.join(cmd[:6])} ...")
    return p


def render_beat(img, dur, fps, zoom, zoom_in, out, tmp):
    frames = max(1, round(dur * fps))
    if img and os.path.exists(img):
        src = img
        # upscale wide first so zoompan doesn't jitter on a still image
        pre = ("scale=3840:2160:force_original_aspect_ratio=increase,"
               "crop=3840:2160,setsar=1,")
    else:
        # white placeholder, exact duration
        src = None
        pre = ""
    if zoom_in:
        zexpr = f"min(zoom+{zoom/frames:.6f},{1+zoom:.4f})"
    else:
        zexpr = f"if(eq(on,0),{1+zoom:.4f},max(zoom-{zoom/frames:.6f},1.0))"
    vf = (f"{pre}zoompan=z='{zexpr}':d={frames}:x='iw/2-(iw/zoom/2)':"
          f"y='ih/2-(ih/zoom/2)':s={W}x{H}:fps={fps},format=yuv420p")
    if src:
        cmd = ["ffmpeg", "-y", "-framerate", str(fps), "-loop", "1",
               "-t", f"{dur:.3f}", "-i", src,
               "-vf", vf, "-r", str(fps), "-frames:v", str(frames), "-an",
               "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", out]
    else:
        cmd = ["ffmpeg", "-y", "-f", "lavfi", "-t", f"{dur:.3f}",
               "-i", f"color=c=white:s={W}x{H}:r={fps}",
               "-vf", "format=yuv420p", "-c:v", "libx264", "-pix_fmt", "yuv420p", out]
    run(cmd)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video_dir")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--zoom", type=float, default=0.08, help="Ken Burns zoom amount")
    ap.add_argument("--ext", default="png")
    args = ap.parse_args()

    vd = args.video_dir.rstrip("/")
    beats = json.load(open(f"{vd}/beats.json"))["beats"]
    audio = f"{vd}/voiceover.wav"
    if not os.path.exists(audio):
        sys.exit(f"missing {audio}")

    # exact audio length, so the last image holds to the end and the video == VO length
    audio_dur = float(subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", audio], capture_output=True, text=True).stdout.strip())

    tmp = tempfile.mkdtemp(prefix="assemble_")
    missing = []
    concat_lines = []
    for i, b in enumerate(beats):
        img = f"{vd}/images/{b['id']}.{args.ext}"
        if not os.path.exists(img):
            missing.append(b["id"])
            img = None
        # each image holds from its cue until the NEXT beat's cue (covers the pause),
        # so image changes land on the voiceover pauses and stay in sync to the end
        nxt = beats[i + 1]["start"] if i + 1 < len(beats) else audio_dur
        disp = round(max(0.1, nxt - b["start"]), 3)
        seg = f"{tmp}/{b['id']}.mp4"
        render_beat(img, disp, args.fps, args.zoom, zoom_in=(i % 2 == 0), out=seg, tmp=tmp)
        concat_lines.append(f"file '{seg}'")
        print(f"  {b['id']}  {disp:.2f}s  {'(WHITE - missing)' if img is None else ''}")

    listf = f"{tmp}/concat.txt"
    open(listf, "w").write("\n".join(concat_lines))
    silent = f"{tmp}/video_silent.mp4"
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", listf,
         "-c", "copy", silent])

    out = f"{vd}/output.mp4"
    run(["ffmpeg", "-y", "-i", silent, "-i", audio,
         "-map", "0:v", "-map", "1:a", "-c:v", "copy",
         "-c:a", "aac", "-b:a", "192k", "-shortest", out])

    shutil.rmtree(tmp, ignore_errors=True)
    print(f"\nwrote {out}  ({len(beats)} beats)")
    if missing:
        print(f"WARNING: {len(missing)} beats had no image (white frames): {', '.join(missing)}")


if __name__ == "__main__":
    main()
