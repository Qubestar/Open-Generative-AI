#!/usr/bin/env python3
"""build_from_plan.py — the EDL (artifacts/plan.json) turned into a renderable Editor V1 comp.

The Node planner writes the plan; this driver is the only thing that turns it into pictures. It
imports the vendored kit device library and calls one device per beat, so the look, the frame
snapping, the z-order, the sound cues and the composition contract all stay owned by the kit
(`packages/editor-engine/skill/components/ev1_*.py`) instead of being re-implemented here.

    python3 build_from_plan.py <projectDir> [--final]

Reads   <projectDir>/artifacts/plan.json      (contract: docs/editor-v1.md §4b, 30 fps frame grid)
Writes  <projectDir>/comp/index.html          (HyperFrames composition, root #root[data-composition-id])
        <projectDir>/comp/sfx-cues.txt        (written by the devices through Comp.write_cues)
        <projectDir>/work/shots.json          (sorted shot list, for the filmstrip / validate stage)
        <projectDir>/comp/assets/ev1/…        (tokens.css + fonts + gsap, copied from the kit)
        <projectDir>/comp/<plan asset paths>  (hard-linked from the project so paths are root-relative)

Then, from the Vidmyo repo root (never npx — the local CLI is the proven one):

    node_modules/.bin/hyperframes lint <projectDir>/comp        # 0 errors required
    node_modules/.bin/hyperframes render <projectDir>/comp -q high -f 30 -o <projectDir>/out/render.mp4

Why the assets are staged instead of referenced with "../": HyperFrames serves the composition
directory as its root, and lint fails a composition whose asset paths traverse above that root
(`invalid_parent_traversal_in_asset_path` / `missing_local_asset`); a symlink out of the root is
refused the same way, so each plan asset is hard-linked into comp/ at its project-relative path
(falling back to a copy across filesystems). A plan asset that does not exist is a hard error that
names the beat and the path — the driver never renders a blank frame silently.

Supported devices: tile_reveal, still, broll, face, seq, strobe, wall3d, pop_collage (anything
else degrades to `still`, loudly). `face` is broll() on the plan's face.source (the kit's rule:
the speaker's camera is RAW), `keyword.kind` mega degrades to shock because v1 has no matte.
--final refuses to write anything when a beat was degraded (unknown device, mega keyword, unknown
keyword kind): a final build is the plan, not an approximation of it. Warnings go to stderr, so
stdout stays a machine-readable contract.

The last line of stdout is exactly one JSON object:
    {"ok":true,"duration":6.0,"beats":6,"cues":12,"shots":6,"out":"comp/index.html"}
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path
from typing import NoReturn

SKILL = Path(__file__).resolve().parents[1] / 'skill'
sys.path.insert(0, str(SKILL / 'components'))
from ev1_more import *          # noqa: F401,F403,E402  (every device: ev1_devices + ev1_more)

FPS_EXPECTED = 30
KIT_W, KIT_H = 1920, 1080       # the devices' geometry is baked at 1080p
DEVICES = ('tile_reveal', 'still', 'broll', 'face', 'seq', 'strobe', 'wall3d', 'pop_collage')
KINDS = ('key', 'title', 'shock')
BLACK = '<div class="ev1-layer ev1-black"></div>'

WARNINGS: list[str] = []
DEGRADED: set[str] = set()        # beats whose look differs from the plan (--final refuses these)


def warn(msg: str) -> None:
    WARNINGS.append(msg)
    print(f'build_from_plan: warn: {msg}', file=sys.stderr)


def degrade(beat_id: str, msg: str) -> None:
    DEGRADED.add(beat_id)
    warn(msg)


def die(msg: str, code: int = 2) -> NoReturn:
    print(f'build_from_plan: {msg}', file=sys.stderr)
    raise SystemExit(code)


def num(v, what: str, beat_id: str = '?') -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        die(f'beat {beat_id}: {what} is not a number ({v!r})')
    return 0.0


# ------------------------------------------------------------------ plan
def load_plan(proj: Path) -> dict:
    path = proj / 'artifacts' / 'plan.json'
    if not path.is_file():
        die(f'no plan: {path} does not exist (the planner stage writes it)')
    try:
        plan = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        die(f'{path} is not valid JSON: {e}')
    if not isinstance(plan, dict):
        die(f'{path}: the plan must be a JSON object')
    if int(plan.get('fps') or FPS_EXPECTED) != FPS_EXPECTED:
        die(f'{path}: fps {plan.get("fps")!r} — the kit renders on a {FPS_EXPECTED} fps frame grid')
    for k, want in (('width', KIT_W), ('height', KIT_H)):
        if plan.get(k) is not None and int(plan[k]) != want:
            die(f'{path}: {k} {plan[k]} — Editor V1 devices are laid out for {KIT_W}x{KIT_H}')
    beats = plan.get('beats')
    if not isinstance(beats, list) or not beats:
        die(f'{path}: beats[] is missing or empty')
    for i, b in enumerate(beats):
        if not isinstance(b, dict):
            die(f'{path}: beats[{i}] is not an object')
        bid = str(b.get('id') or f'b{i + 1}')
        for k in ('t0', 't1'):
            if b.get(k) is None:
                die(f'beat {bid}: {k} is required')
            num(b[k], k, bid)
        if num(b['t1'], 't1', bid) <= num(b['t0'], 't0', bid):
            die(f'beat {bid}: t1 {b["t1"]} is not after t0 {b["t0"]}')
    return plan


# ------------------------------------------------------------------ assets
_STAGED: dict[str, str] = {}


def stage(proj: Path, comp: Path, rel, beat_id: str) -> str:
    """Put `rel` (project-relative) inside comp/ under the same path and return the root-relative
    path the composition must use. Missing files are fatal: no silent black frames."""
    key = str(rel)
    if key in _STAGED:
        return _STAGED[key]
    src = Path(key)
    if not src.is_absolute():
        src = proj / key
    src = Path(os.path.normpath(str(src)))
    if not src.is_file():
        die(f'beat {beat_id}: asset not found: {key} (looked at {src}) — refusing to render a blank frame')
    try:
        inside = src.resolve().relative_to(proj.resolve()).as_posix()
    except ValueError:                       # outside the project: park it in comp/assets/ext/
        inside = f'assets/ext/{hashlib.sha1(str(src).encode()).hexdigest()[:8]}-{src.name}'
    dest = comp / inside
    dest.parent.mkdir(parents=True, exist_ok=True)
    same = dest.is_file() and dest.stat().st_size == src.stat().st_size \
        and int(dest.stat().st_mtime) >= int(src.stat().st_mtime)
    if not same:
        if dest.exists() or dest.is_symlink():
            dest.unlink()
        try:
            os.link(src, dest)               # hard link: same bytes, no traversal above the comp root
        except OSError:
            shutil.copy2(src, dest)
    _STAGED[key] = inside
    return inside


def asset_of(proj: Path, comp: Path, beat: dict, bid: str, key: str = 'asset', required: bool = True):
    rel = beat.get(key)
    if not rel:
        if required:
            die(f'beat {bid}: device {beat.get("device")!r} needs `{key}`')
        return None
    return stage(proj, comp, rel, bid)


def src_list_of(proj: Path, comp: Path, beat: dict, bid: str) -> list[str]:
    raw = beat.get('assets') or beat.get('tiles') or []
    if isinstance(raw, str):
        raw = [raw]
    out = []
    for k, it in enumerate(raw):
        rel = it.get('asset') if isinstance(it, dict) else it
        if not rel:
            die(f'beat {bid}: assets[{k}] has no asset path')
        out.append(stage(proj, comp, rel, bid))
    if not out:
        a = asset_of(proj, comp, beat, bid, required=False)
        if a:
            out = [a]
    if not out:
        die(f'beat {bid}: device {beat.get("device")!r} needs assets[]')
    return out


def media_len(path: Path):
    """best-effort clip length via cv2 (None when cv2 cannot read it) — only used for warnings"""
    try:
        import cv2  # noqa
        cap = cv2.VideoCapture(str(path))
        n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        f = float(cap.get(cv2.CAP_PROP_FPS) or 0)
        cap.release()
        return n / f if n > 0 and f > 0 else None
    except Exception:
        return None


# ------------------------------------------------------------------ kit assets
def install_kit_assets(comp: Path) -> None:
    dst = comp / 'assets' / 'ev1'
    dst.mkdir(parents=True, exist_ok=True)
    for name in ('tokens.css',):
        s = SKILL / 'assets' / name
        if not s.is_file():
            die(f'kit incomplete: {s} is missing')
        shutil.copy2(s, dst / name)
    for d in ('fonts', 'vendor'):
        s = SKILL / 'assets' / d
        if not s.is_dir():
            die(f'kit incomplete: {s} is missing')
        shutil.copytree(s, dst / d, dirs_exist_ok=True)
    if not (dst / 'vendor' / 'gsap.min.js').is_file():
        die(f'kit incomplete: {dst / "vendor" / "gsap.min.js"} is missing')


# ------------------------------------------------------------------ captions / keyword
def caption_words(beat: dict, bid: str, t0: float, t1: float, note: bool = False):
    raw = beat.get('caption') or beat.get('captions') or []
    if isinstance(raw, dict):
        raw = raw.get('words') or []
    words, moved = [], 0
    for k, w in enumerate(raw):
        if isinstance(w, dict):
            text, on = w.get('w') or w.get('text'), w.get('s') if 's' in w else w.get('t')
        elif isinstance(w, (list, tuple)) and len(w) >= 2:
            text, on = w[0], w[1]
        else:
            die(f'beat {bid}: caption[{k}] must be [word, onset] (got {w!r})')
        if text is None or on is None:
            die(f'beat {bid}: caption[{k}] is missing the word or its onset')
        on = num(on, f'caption[{k}] onset', bid)
        if on < t1 - 1e-6:                     # a word that starts after the beat is not its caption
            if on < t0 - 1e-6:
                moved += 1
            words.append((str(text), max(t0, on)))
    if moved and note:
        warn(f'beat {bid}: {moved} caption word(s) start before the beat and are held from {t0:.2f}s')
    words.sort(key=lambda p: p[1])
    return words


def keyword_call(c, beat: dict, bid: str, t0: float, t1: float) -> None:
    kw = beat.get('keyword')
    if not kw:
        return
    if isinstance(kw, str):
        kw = {'text': kw}
    text = kw.get('text')
    if not text:
        die(f'beat {bid}: keyword has no text')
    kind = str(kw.get('kind') or 'key').lower()
    if kind == 'mega':
        degrade(bid, f'beat {bid}: keyword kind "mega" needs the speaker matte (not produced in v1) — using "shock"')
        kind = 'shock'
    if kind not in KINDS:
        degrade(bid, f'beat {bid}: unknown keyword kind {kind!r} — using "key"')
        kind = 'key'
    at = max(t0, num(kw.get('at', t0), 'keyword.at', bid))
    end = min(t1, at + num(kw.get('dur', t1 - at), 'keyword.dur', bid))
    end = max(end, at + 2 / FPS_EXPECTED)
    sound = kw.get('sound', 'hit' if kind == 'shock' else 'swish' if kind == 'title' else None)
    keyword(c, at, end, text, z=12, x=kw.get('x', 960), y=kw.get('y', 540), kind=kind,
            size=kw.get('size'), sound=sound or None)


def ensure_cue(c, t0: float, since: int) -> None:
    """every cut gets a sound: if the device wrote nothing on the beat's first frame, add a soft click"""
    for ct, _s, _g in c.cues[since:]:
        if abs(ct - t0) <= 0.08:
            return
    sfx(c, t0, 'click_soft')


# ------------------------------------------------------------------ devices
def build_beat(c, plan: dict, beat: dict, proj: Path, comp: Path, bid: str) -> dict:
    t0, t1 = fr(num(beat['t0'], 't0', bid)), fr(num(beat['t1'], 't1', bid))
    dev = str(beat.get('device') or 'still').lower()
    face = plan.get('face') or {}
    face_src = face.get('source')
    shot_asset, name = None, dev

    if dev == 'face':
        src = beat.get('asset') or face_src
        if not src:
            die(f'beat {bid}: device "face" needs plan.face.source or beat.asset')
        rel = stage(proj, comp, src, bid)
        punch = beat.get('punch')
        punches = ()
        if punch:
            if not isinstance(punch, (list, tuple)) or len(punch) != 2:
                die(f'beat {bid}: punch must be [t, scale] (got {punch!r})')
            punches = ((fr(num(punch[0], 'punch[0]', bid)), num(punch[1], 'punch[1]', bid)),)
        broll(c, t0, t1, rel, z=1, rate=num(beat.get('rate', 0.012), 'rate', bid),
              media_start=fr(num(beat.get('media_start', t0), 'media_start', bid)),
              punches=punches, focus_in=int(beat.get('focus_in', 0) or 0))
        shot_asset = rel

    elif dev == 'still':
        rel = asset_of(proj, comp, beat, bid)
        still(c, t0, t1, rel, z=1, push=num(beat.get('push', 1.06), 'push', bid))
        shot_asset = rel

    elif dev == 'broll':
        rel = asset_of(proj, comp, beat, bid)
        ms = fr(num(beat.get('media_start', 0.0), 'media_start', bid))
        broll(c, t0, t1, rel, z=1, rate=num(beat.get('rate', 0.055), 'rate', bid),
              direction=str(beat.get('direction') or 'in'), media_start=ms,
              focus_in=int(beat.get('focus_in', 0) or 0))
        n = media_len(Path(rel) if Path(rel).is_absolute() else comp / rel)
        if n is not None and n - ms < (t1 - t0) - 1 / FPS_EXPECTED:
            warn(f'beat {bid}: clip {rel} has {n - ms:.2f}s from media_start {ms:.2f}s, beat needs '
                 f'{t1 - t0:.2f}s — the tail will hold on the last frame')
        shot_asset = rel

    elif dev == 'tile_reveal':
        rel = asset_of(proj, comp, beat, bid)
        still(c, t0, t1, rel, z=1, push=num(beat.get('push', 1.04), 'push', bid))
        tend = tile_reveal(c, t0, rel, z=2, cols=int(beat.get('cols', 3)), rows=int(beat.get('rows', 3)),
                           frames_n=int(beat.get('frames', 10)), seed=int(beat.get('seed', 3)),
                           size=(KIT_W, KIT_H))
        if tend > t1:
            warn(f'beat {bid}: tile_reveal runs to {tend:.2f}s past the beat end {t1:.2f}s')
        shot_asset = rel

    elif dev == 'seq':
        srcs = src_list_of(proj, comp, beat, bid)
        items_raw = beat.get('items') or []
        if items_raw:
            items = []
            for k, it in enumerate(items_raw):
                rel = it.get('asset') if isinstance(it, dict) else it
                if not rel:
                    die(f'beat {bid}: items[{k}] has no asset')
                ton = it.get('t', it.get('t0')) if isinstance(it, dict) else None
                ton = t0 + k * (t1 - t0) / len(items_raw) if ton is None else num(ton, f'items[{k}].t', bid)
                items.append((stage(proj, comp, rel, bid), fr(max(t0, min(ton, t1 - 1 / FPS_EXPECTED)))))
            items.sort(key=lambda p: p[1])
            if items[0][1] > t0:
                items.insert(0, (items[0][0], t0))
            srcs = [s for s, _ in items]
            seq(c, items, z=1, t_end=t1, click=beat.get('click', 'click'),
                push=num(beat.get('push', 0.05), 'push', bid), seed=int(beat.get('seed', 1)))
        else:
            n = len(srcs)
            items = [(s, fr(t0 + k * (t1 - t0) / n)) for k, s in enumerate(srcs)]
            seq(c, items, z=1, t_end=t1, click=beat.get('click', 'click'),
                push=num(beat.get('push', 0.05), 'push', bid), seed=int(beat.get('seed', 1)))
        shot_asset = srcs[0]

    elif dev == 'strobe':
        srcs = src_list_of(proj, comp, beat, bid)
        strobe(c, t0, t1, srcs, z=1, step_frames=int(beat.get('step_frames', 3)),
               tracker=bool(beat.get('tracker', True)), seed=int(beat.get('seed', 4)))
        if len(srcs) == 1:
            warn(f'beat {bid}: strobe with one image is a flicker, not a shape-matched burst')
        shot_asset = srcs[0]

    elif dev == 'wall3d':
        srcs = src_list_of(proj, comp, beat, bid)
        wall3d(c, t0, t1, srcs, z=1, cols=int(beat.get('cols', 4)),
               sound=bool(beat.get('sound', False)))
        shot_asset = srcs[0]

    elif dev == 'pop_collage':
        srcs = src_list_of(proj, comp, beat, bid)
        cards_raw = beat.get('cards') or []
        words = caption_words(beat, bid, t0, t1)
        cards = []
        if cards_raw:
            for k, cd in enumerate(cards_raw):
                rel = stage(proj, comp, cd.get('asset'), bid)
                cards.append((rel, cd.get('x', 960), cd.get('y', 540), cd.get('w', 620),
                              cd.get('rot', 0), fr(num(cd.get('t', t0 + k * 0.2), 'cards.t', bid))))
        else:
            n = len(srcs)
            cols = min(3, n)
            rows = (n + cols - 1) // cols
            for k, s in enumerate(srcs):
                cx, cy = k % cols, k // cols
                x = 960 + (cx - (cols - 1) / 2) * 620
                y = 540 + (cy - (rows - 1) / 2) * 360
                tp = words[k][1] if k < len(words) else t0 + (k + 0.4) * (t1 - t0) / max(1, n)
                cards.append((s, int(x), int(y), 600, 0, fr(min(max(tp, t0), t1 - 1 / FPS_EXPECTED))))
        pop_collage(c, t0, t1, cards, z=1)
        shot_asset = cards[0][0]

    else:                                     # unknown device: a held still, loudly
        degrade(bid, f'beat {bid}: device {dev!r} is not implemented by this driver '
                     f'(supported: {", ".join(DEVICES)}) — degrading to "still"')
        first = beat.get('asset')
        if not first and beat.get('assets'):
            f0 = beat['assets'][0]
            first = f0.get('asset') if isinstance(f0, dict) else f0
        if not first:
            die(f'beat {bid}: device {dev!r} has no asset to fall back to')
        rel = stage(proj, comp, first, bid)
        still(c, t0, t1, rel, z=1)
        shot_asset, name = rel, f'{dev}->still'

    # ---- layers above the picture: the words, then the finish, then the clicks
    words = caption_words(beat, bid, t0, t1, note=True)
    if words:
        mode = beat.get('caption_mode')
        captions(c, [(words, t1)] + ([mode] if mode else []))
    keyword_call(c, beat, bid, t0, t1)
    vignette = bool(beat.get('vignette', dev != 'face'))     # the speaker's camera stays RAW
    grid = bool(beat.get('grid', dev != 'face'))
    finish(c, t0, t1, z=80, grid=grid, vignette=vignette)

    return {'t0': t0, 't1': t1, 'device': name, 'beat': bid, 'asset': shot_asset}


# ------------------------------------------------------------------ main
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description='plan.json -> Editor V1 comp (HyperFrames)')
    ap.add_argument('project', help='project directory (holds artifacts/plan.json)')
    ap.add_argument('--final', action='store_true',
                    help='refuse to write if any beat was degraded (no silent fallbacks)')
    a = ap.parse_args(argv)

    proj = Path(a.project).expanduser().absolute()     # keep the caller's path form in messages
    if not proj.is_dir():
        die(f'{proj} is not a directory')
    plan = load_plan(proj)
    comp = proj / 'comp'
    (proj / 'work').mkdir(parents=True, exist_ok=True)
    comp.mkdir(parents=True, exist_ok=True)
    install_kit_assets(comp)

    beats = plan['beats']
    t_end_plan = num(plan.get('duration') or max(num(b['t1'], 't1', str(b.get('id', '?'))) for b in beats),
                     'duration')
    dur = fr(max(t_end_plan, max(fr(num(b['t1'], 't1')) for b in beats)))
    if dur <= 0:
        die('plan duration is 0')

    c = Comp(dur)
    style = plan.get('style') or {}
    cap_size = style.get('caption_size') or plan.get('caption_size') or style.get('caption_size_hint')
    if cap_size:
        c.css.append(f':root{{--ev1-cap-size:{int(cap_size)}px;}}')

    # base: beats in time order; the gaps are black (never an unpainted frame)
    order = sorted(beats, key=lambda b: (num(b['t0'], 't0'), num(b['t1'], 't1')))
    cover, shots = [], []
    for i, b in enumerate(order):
        bid = str(b.get('id') or f'b{i + 1}')
        t0 = fr(num(b['t0'], 't0', bid))
        if cover and t0 < cover[-1][1] - 1e-6:
            warn(f'beat {bid} starts at {t0:.3f}s, inside the previous beat (ends {cover[-1][1]:.3f}s) — overlapping')
        since = len(c.cues)
        shot = build_beat(c, plan, b, proj, comp, bid)
        ensure_cue(c, shot['t0'], since)
        shots.append(shot)
        cover.append((shot['t0'], shot['t1']))

    filled, cursor = [], 0.0
    for g0, g1 in sorted(cover):
        if g0 > cursor + 1e-6:
            filled.append((cursor, g0))
            c.clip(cursor, g0, BLACK, 1)
        cursor = max(cursor, g1)
    if cursor < dur - 1e-6:
        c.clip(cursor, dur, BLACK, 1)
        filled.append((cursor, dur))
    if filled:
        warn(f'{len(filled)} gap(s) in the plan filled with black: '
             + ', '.join(f'{g0:.2f}-{g1:.2f}s' for g0, g1 in filled))

    bad = sorted(DEGRADED)
    if a.final and bad:                     # nothing is written: a final build has no fallbacks
        die(f'--final: refusing to write a final composition — degraded beats {bad}'
            f'{'; ' + '; '.join(WARNINGS) if WARNINGS else ''}', 3)

    c.write(str(comp / 'index.html'), 'assets/ev1/tokens.css',
            title=str(style.get('name') or 'Editor V1'))
    c.write_cues(str(comp / 'sfx-cues.txt'))
    shots.sort(key=lambda s: (s['t0'], s['t1']))
    (proj / 'work' / 'shots.json').write_text(json.dumps(shots, indent=1) + '\n')

    print(json.dumps({'ok': True, 'duration': round(c.dur, 4), 'beats': len(shots), 'cues': len(c.cues),
                      'shots': len(shots), 'out': 'comp/index.html'}, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
