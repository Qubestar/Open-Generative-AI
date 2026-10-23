#!/usr/bin/env python3
"""analyze_examples.py — example videos in, a style profile the planner can copy.

Custom mode: the user names example videos (or URLs that were already downloaded); this reads them
frame by frame and turns their rhythm and their colour into numbers — no network, no models, no pip.

    python3 analyze_examples.py --out <dir> <video1> [<video2> ...]

Writes
    <out>/style-profile.json   per-example measurements + the aggregate `style` block
                               (cut_median_s, cuts_per_minute, burst_ratio, palette, treatment_mix,
                               caption_size_hint, face_share_hint, sample_count) that the Node planner
                               reads to override the Original defaults
    <out>/contact-sheet.jpg    one frame per detected shot, tiled, max 40 tiles — look at it before
                               trusting the numbers

How the numbers are made
    cuts      consecutive frames are downscaled to 96x54 gray and compared with
              mean(|a-b|)/255. A cut is a jump over --scene-threshold (default 0.12; hard cuts measure
              0.24-0.34, camera motion under 0.01), or a jump over half of it that is also 8x the
              file's own median and 4x its local neighbourhood — that second tier is what catches a
              dark cut inside a dark reel. A frame that jumps out and comes straight back (a one-frame
              flash or insert) is not a shot change and is dropped.
    palette   k-means (cv2, 6 clusters, fixed seed) over every 4th frame, weighted by cluster size.
    treatment_mix  heuristics over that palette and the mean saturation: near-grey clusters count as
              `mono`, cyan/teal hues as `teal`, orange/amber/red as `warm`, everything else `natural`.
    hints     caption_size_hint and face_share_hint are pacing-derived guesses (62 px and 30% at
              median-cut pace), not measurements — the planner treats them as soft overrides.

Exit code is non-zero with a message on stderr when a file is missing, unreadable or has no video
stream. Audio is never required. The last line of stdout is exactly one JSON object:

    {"ok":true,"examples":2,"cuts":9,"median_s":1.0,"contact_sheet":"…/contact-sheet.jpg"}
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path
from typing import NoReturn

import cv2
import numpy as np

DIFF_W, DIFF_H = 96, 54          # the diff canvas: small enough that noise cancels, big enough to see a cut
PAL_EVERY = 4                    # sample one palette frame every 4 decoded frames
MAX_FRAMES = 24000               # per example; longer files are walked with a stride
MAX_TILES = 40
K_CLUSTERS = 6


def die(msg: str, code: int = 2) -> NoReturn:
    print(f'analyze_examples: {msg}', file=sys.stderr)
    raise SystemExit(code)


# ------------------------------------------------------------------ ffprobe
def ratio(s, default=0.0) -> float:
    if not s:
        return default
    if '/' in str(s):
        a, b = str(s).split('/', 1)
        try:
            return float(a) / float(b) if float(b) else default
        except ValueError:
            return default
    try:
        return float(s)
    except ValueError:
        return default


def probe(path: Path) -> dict:
    r = subprocess.run(['ffprobe', '-v', 'error', '-print_format', 'json',
                        '-show_format', '-show_streams', str(path)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        die(f'ffprobe failed on {path}: {r.stderr.strip()[:400]}')
    try:
        j = json.loads(r.stdout or '{}')
    except json.JSONDecodeError:
        die(f'ffprobe returned something that is not JSON for {path}')
    v = next((s for s in j.get('streams', []) if s.get('codec_type') == 'video'), None)
    if v is None:
        die(f'{path}: no video stream')
    w, h = int(v.get('width') or 0), int(v.get('height') or 0)
    for sd in v.get('side_data_list') or []:          # phone footage: a 1080x1920 stream shown as 1920x1080
        if 'rotation' in sd and abs(float(sd['rotation'])) % 180 == 90:
            w, h = h, w
    fps = ratio(v.get('avg_frame_rate'), ratio(v.get('r_frame_rate'), 0.0))
    dur = ratio(j.get('format', {}).get('duration'), ratio(v.get('duration'), 0.0))
    if w <= 0 or h <= 0:
        die(f'{path}: video stream has no usable size ({w}x{h})')
    return {'width': w, 'height': h, 'fps': fps, 'duration': dur, 'codec': v.get('codec_name'),
            'frames': int(v.get('nb_frames') or 0), 'has_audio': any(
                s.get('codec_type') == 'audio' for s in j.get('streams', []))}


def aspect_label(a: float) -> str:
    for name, want in (('16:9', 16 / 9), ('9:16', 9 / 16), ('4:3', 4 / 3), ('3:4', 3 / 4),
                       ('1:1', 1.0), ('21:9', 21 / 9), ('2.39:1', 2.39)):
        if abs(a - want) / want < 0.03:
            return name
    return f'{a:.2f}:1'


# ------------------------------------------------------------------ palette
def palette_of(pixels: np.ndarray) -> list[dict]:
    """top-6 colours of a (N,3) BGR pixel pool, deterministic (fixed k-means seed)"""
    if len(pixels) < K_CLUSTERS * 4:
        return [{'hex': '#%02x%02x%02x' % tuple(int(v) for v in c[::-1]), 'weight': 1.0} for c in pixels[:1]]
    px = pixels.astype(np.float32)
    cv2.setRNGSeed(0)
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1.0)
    _compact, labels, centers = cv2.kmeans(px, K_CLUSTERS, None, crit, 3, cv2.KMEANS_PP_CENTERS)
    labels = labels.ravel()
    counts = np.bincount(labels, minlength=len(centers)).astype(np.float64)
    order = np.argsort(-counts)
    total = counts.sum() or 1.0
    out = []
    for k in order:
        b, g, r = (float(x) for x in centers[k])
        out.append({'hex': '#%02x%02x%02x' % (max(0, min(255, int(round(r)))),
                                              max(0, min(255, int(round(g)))),
                                              max(0, min(255, int(round(b))))),
                    'weight': round(float(counts[k] / total), 4)})
    return out


def hex_to_hsv(hexstr: str):
    h = hexstr.lstrip('#')
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    px = np.array([[[b, g, r]]], dtype=np.uint8)
    hh, ss, vv = cv2.cvtColor(px, cv2.COLOR_BGR2HSV)[0, 0]
    return float(hh), float(ss) / 255.0, float(vv) / 255.0


# ------------------------------------------------------------------ cut detection
def detect_cuts(diffs: list[float], times: list[float], threshold: float, fps: float):
    """Frame-diff shot boundaries. Two tiers, because one threshold cannot cover a bright reel and a
    dark one: a jump over `threshold`, or a jump over half of it that is also 8x the file's own
    median difference and 4x its immediate neighbourhood (a dark cut inside a dark video). A two-frame
    run is a one-frame insert — flash out, flash back — and is dropped: it is not a shot change.

    Returns (kept indices into `diffs`, dropped indices)."""
    a = np.asarray(diffs, dtype=np.float64)
    n = a.size
    if n < 2:
        return [], []
    med = float(np.median(a)) + 1e-6
    weak = max(0.045, threshold * 0.5)
    hits = []
    for i in range(n):
        d = float(a[i])
        if d >= threshold:
            hits.append(i)
            continue
        if d < weak:
            continue
        lo, hi = max(0, i - 3), min(n, i + 4)
        neigh = np.concatenate((a[lo:i], a[i + 1:hi]))
        if d >= 8 * med and (neigh.size == 0 or d >= 4 * float(neigh.mean())):
            hits.append(i)
    kept, dropped = [], []
    for i in hits:
        if kept and (times[i] - times[kept[-1]]) <= 1.5 / max(fps, 1e-6) \
                and (i + 1 >= n or a[i + 1] < weak):
            dropped.append(i)             # went out and came straight back: an insert, not a shot
            kept.pop()
            continue
        kept.append(i)
    return kept, dropped


# ------------------------------------------------------------------ one example
def decode_stats(path: Path, info: dict, threshold: float, keep_frames: bool = False):
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        die(f'{path}: OpenCV cannot open this video')
    fps = info['fps'] or cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = info['frames'] or int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    stride = max(1, int(math.ceil(total / MAX_FRAMES))) if total else 1

    prev = None
    diffs: list[float] = []
    diff_times: list[float] = []
    pix: list[np.ndarray] = []
    sat_sum = bright_sum = contrast_sum = 0.0
    n_used = 0
    i = 0
    while True:
        if stride > 1 and i % stride:
            if not cap.grab():
                break
            i += 1
            continue
        ok, frame = cap.read()
        if not ok:
            break
        t = i / fps
        small = cv2.resize(frame, (DIFF_W, DIFF_H), interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.float32)
        if prev is not None:
            diffs.append(float(np.abs(gray - prev).mean()) / 255.0)
            diff_times.append(t)
        if i % PAL_EVERY == 0:
            pal = cv2.resize(frame, (160, 90), interpolation=cv2.INTER_AREA)
            pix.append(pal.reshape(-1, 3))
            hsv = cv2.cvtColor(pal, cv2.COLOR_BGR2HSV)
            sat_sum += float(hsv[:, :, 1].mean()) / 255.0
            bright_sum += float(hsv[:, :, 2].mean()) / 255.0
            contrast_sum += float(cv2.cvtColor(pal, cv2.COLOR_BGR2GRAY).std()) / 255.0
            n_used += 1
        prev = gray
        i += 1
    cap.release()
    if not diffs:
        die(f'{path}: fewer than two decodable frames')

    # a cut is a jump; a one-frame insert (flash out, flash back) is not a shot change
    cut_idx, dropped_idx = detect_cuts(diffs, diff_times, threshold, fps)
    confirmed = [round(diff_times[i], 3) for i in cut_idx]
    drop = [round(diff_times[i], 3) for i in dropped_idx]

    dur = info['duration'] or i / fps
    bounds = [0.0] + confirmed + [dur]
    shots = []
    for a, b in zip(bounds, bounds[1:]):
        if b - a > 1e-6:
            shots.append({'t0': round(a, 3), 't1': round(b, 3), 'dur': round(b - a, 3)})
    pix_all = np.concatenate(pix, axis=0) if pix else np.zeros((1, 3), np.uint8)
    return {
        'fps': fps, 'duration': dur, 'shots': shots, 'cuts_dropped': drop,
        'motion': float(np.mean(diffs)) if diffs else 0.0,
        'mean_saturation': sat_sum / max(1, n_used), 'mean_brightness': bright_sum / max(1, n_used),
        'mean_contrast': contrast_sum / max(1, n_used),
        'palette': palette_of(pix_all), 'pixels': pix_all if keep_frames else None,
        'frames_analyzed': i,
    }


def length_stats(durs: list[float]) -> dict:
    if not durs:
        return {'median': 0.0, 'p10': 0.0, 'p90': 0.0, 'mean': 0.0, 'min': 0.0, 'max': 0.0, 'n': 0}
    a = np.asarray(durs, dtype=np.float64)
    return {'median': round(float(np.median(a)), 4), 'p10': round(float(np.percentile(a, 10)), 4),
            'p90': round(float(np.percentile(a, 90)), 4), 'mean': round(float(a.mean()), 4),
            'min': round(float(a.min()), 4), 'max': round(float(a.max()), 4), 'n': int(a.size)}


# ------------------------------------------------------------------ contact sheet
def contact_sheet(items, out: Path, aspect: float) -> int:
    """items = [(video path, t)] one frame per shot (already capped); tiles with the shot number"""
    tw = 384
    th = max(120, int(round(tw / max(0.3, min(3.0, aspect)))))
    th += 0 if th % 2 == 0 else 1
    cols = min(6, max(1, int(math.ceil(math.sqrt(len(items))))))
    rows = int(math.ceil(len(items) / cols))
    sheet = np.full((rows * th, cols * tw, 3), 12, np.uint8)
    drawn = 0
    for k, (path, t, label) in enumerate(items):
        cap = cv2.VideoCapture(str(path))
        cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, t) * 1000.0)
        ok, frame = cap.read()
        cap.release()
        if not ok:
            continue
        s = min(tw / frame.shape[1], th / frame.shape[0])
        w, h = max(1, int(frame.shape[1] * s)), max(1, int(frame.shape[0] * s))
        tile = np.zeros((th, tw, 3), np.uint8)
        tile[(th - h) // 2:(th - h) // 2 + h, (tw - w) // 2:(tw - w) // 2 + w] = cv2.resize(
            frame, (w, h), interpolation=cv2.INTER_AREA)
        cv2.putText(tile, label, (8, th - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 3, cv2.LINE_AA)
        cv2.putText(tile, label, (8, th - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (245, 245, 245), 1, cv2.LINE_AA)
        r, c = divmod(k, cols)
        sheet[r * th:(r + 1) * th, c * tw:(c + 1) * tw] = tile
        drawn += 1
    out.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(out), sheet, [int(cv2.IMWRITE_JPEG_QUALITY), 88]):
        die(f'could not write {out}')
    return drawn


# ------------------------------------------------------------------ aggregate
def treatment_mix(palette: list[dict], mean_sat: float) -> dict:
    acc = {'teal': 0.0, 'mono': 0.0, 'warm': 0.0, 'natural': 0.0}
    for c in palette:
        h, s, _v = hex_to_hsv(c['hex'])
        w = float(c.get('weight') or 0.0)
        if s < 0.14:
            acc['mono'] += w
        elif 70 <= h <= 110:                    # 140-220 deg: teal / cyan
            acc['teal'] += w
        elif h <= 40 or h >= 150:               # red-orange .. amber, and the magenta/red wrap
            acc['warm'] += w
        else:
            acc['natural'] += w
    tot = sum(acc.values()) or 1.0
    acc = {k: v / tot for k, v in acc.items()}
    if mean_sat < 0.10:                         # a washed-out profile is a mono profile
        acc['mono'] = max(acc['mono'], 0.55)
    tot = sum(acc.values()) or 1.0
    return {k: round(v / tot, 3) for k, v in acc.items()}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description='example videos -> style-profile.json + contact-sheet.jpg')
    ap.add_argument('--out', required=True, help='directory for style-profile.json and contact-sheet.jpg')
    ap.add_argument('--scene-threshold', type=float, default=0.12,
                    help='mean-abs frame difference (0-1) that counts as a cut (default 0.12)')
    ap.add_argument('videos', nargs='+', help='example video files')
    a = ap.parse_args(argv)

    out = Path(a.out).expanduser().absolute()      # keep the caller's path form (no symlink rewrite)
    paths = []
    for v in a.videos:
        p = Path(v).expanduser().absolute()
        if not p.is_file():
            die(f'no such video: {v}')
        paths.append(p)
    if not paths:
        die('no example videos given')
    out.mkdir(parents=True, exist_ok=True)

    examples, all_shots, all_pix, tiles = [], [], [], []
    for path in paths:
        info = probe(path)
        st = decode_stats(path, info, a.scene_threshold, keep_frames=True)
        durs = [s['dur'] for s in st['shots']]
        aspect = info['width'] / info['height']
        ex = {
            'path': str(path), 'name': path.name,
            'width': info['width'], 'height': info['height'], 'duration': round(st['duration'], 3),
            'fps': round(st['fps'], 3), 'aspect_ratio': round(aspect, 4), 'aspect': aspect_label(aspect),
            'has_audio': info['has_audio'], 'codec': info['codec'],
            'frames_analyzed': st['frames_analyzed'],
            'shots': st['shots'], 'shot_count': len(st['shots']),
            'shot_lengths_s': durs,
            'shot_length': length_stats(durs),
            'cuts_dropped': len(st['cuts_dropped']),
            'cuts_per_minute': round((len(st['shots']) - 1) / st['duration'] * 60, 2) if st['duration'] else 0.0,
            'burst_ratio': round(sum(1 for d in durs if d < 0.2) / len(durs), 3) if durs else 0.0,
            'palette': st['palette'],
            'mean_saturation': round(st['mean_saturation'], 4),
            'mean_brightness': round(st['mean_brightness'], 4),
            'mean_contrast': round(st['mean_contrast'], 4),
            'motion_energy': round(st['motion'], 5),
        }
        examples.append(ex)
        all_shots.extend(durs)
        if st['pixels'] is not None:
            all_pix.append(st['pixels'][::7])
        for s in st['shots'][:MAX_TILES]:
            tiles.append((path, (s['t0'] + s['t1']) / 2.0,
                          f'{len(tiles) + 1}  {s["dur"]:.2f}s'))
        print(f'analyze_examples: {path.name}: {len(st["shots"])} shots, '
              f'{st["duration"]:.2f}s, median {ex["shot_length"]["median"]:.2f}s', file=sys.stderr)

    if not examples:
        die('nothing analysed')

    pooled = length_stats(all_shots)
    total_dur = sum(e['duration'] for e in examples)
    total_cuts = sum(max(0, e['shot_count'] - 1) for e in examples)
    agg_pix = np.concatenate(all_pix, axis=0) if all_pix else np.zeros((1, 3), np.uint8)
    pal = palette_of(agg_pix)
    mean_sat = float(np.mean([e['mean_saturation'] for e in examples]))
    median = pooled['median']
    burst = round(sum(1 for d in all_shots if d < 0.2) / len(all_shots), 3) if all_shots else 0.0

    cap_hint = 56 if median <= 0.6 else 62 if median <= 1.0 else 66 if median <= 1.6 else 70
    face_hint = 0.30
    if median <= 0.7:
        face_hint -= 0.07
    elif median >= 1.4:
        face_hint += 0.04
    face_hint = round(min(0.4, max(0.15, face_hint - 0.05 * burst)), 2)

    style = {
        'name': 'custom (%d example%s)' % (len(examples), '' if len(examples) == 1 else 's'),
        'cut_median_s': median,
        'shot_length_s': {k: pooled[k] for k in ('median', 'p10', 'p90', 'mean', 'min', 'max')},
        'cuts_per_minute': round(total_cuts / total_dur * 60, 2) if total_dur else 0.0,
        'burst_ratio': burst,
        'palette': [c['hex'] for c in pal],
        'palette_weights': pal,
        'treatment_mix': treatment_mix(pal, mean_sat),
        'caption_size_hint': cap_hint,
        'face_share_hint': face_hint,
        'mean_saturation': round(mean_sat, 4),
        'mean_brightness': round(float(np.mean([e['mean_brightness'] for e in examples])), 4),
        'mean_contrast': round(float(np.mean([e['mean_contrast'] for e in examples])), 4),
        'motion_energy': round(float(np.mean([e['motion_energy'] for e in examples])), 5),
        'aspects': sorted({e['aspect'] for e in examples}),
        'sample_count': len(examples),
        'total_duration_s': round(total_dur, 3),
        'total_shots': len(all_shots),
    }
    profile = {'version': 1, 'kind': 'vidmyo.editor.style-profile',
               'contract': 'docs/editor-v1.md §4b / §6', 'style': style, 'examples': examples}
    prof_path = out / 'style-profile.json'
    prof_path.write_text(json.dumps(profile, indent=1) + '\n')

    sheet = out / 'contact-sheet.jpg'
    tiled = contact_sheet(tiles[:MAX_TILES], sheet, examples[0]['width'] / examples[0]['height'])

    print(json.dumps({'ok': True, 'examples': len(examples), 'cuts': total_cuts,
                      'median_s': median, 'contact_sheet': str(sheet)}, separators=(',', ':')))
    print(f'analyze_examples: wrote {prof_path} and {sheet} ({tiled} tiles)', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
