#!/usr/bin/env python3
"""Cover a bad baked-in caption with the sampled background color and redraw the
correct text in a marker font. Used to fix the few frames where Nano Banana
misspelled / invented the on-screen text."""
import sys
from PIL import Image, ImageDraw, ImageFont

FONT = "/System/Library/Fonts/Supplemental/MarkerFelt.ttc"


def avg(colors):
    n = len(colors)
    return tuple(sum(c[i] for c in colors) // n for i in range(3))


def fit_font(draw, text, max_w, max_h):
    size = max_h
    while size > 10:
        f = ImageFont.truetype(FONT, size)
        l, t, r, b = draw.textbbox((0, 0), text, font=f)
        if (r - l) <= max_w and (b - t) <= max_h:
            return f, (r - l), (b - t), t
        size -= 2
    return ImageFont.truetype(FONT, 12), 0, 0, 0


def fix(path, text, rgb, band_h):
    im = Image.open(path).convert("RGB")
    W, H = im.size
    px = im.load()
    bg = avg([px[5, 5], px[W - 6, 5], px[5, band_h - 5], px[W - 6, band_h - 5]])
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, band_h], fill=bg)
    f, tw, th, toff = fit_font(d, text, int(W * 0.92), int(band_h * 0.78))
    x = (W - tw) // 2
    y = (band_h - th) // 2 - toff
    d.text((x, y), text, font=f, fill=rgb)
    im.save(path)
    print(f"fixed {path}: '{text}' on bg{bg}")


JOBS = [
    ("s019.png", "81%", (20, 20, 20), 110),
    ("s040.png", "PEACEFUL CONSCIOUSNESS", (245, 197, 24), 170),
    ("s046.png", "CIRCADIAN RHYTHM", (217, 64, 64), 180),
]

if __name__ == "__main__":
    base = sys.argv[1].rstrip("/")
    for fn, txt, rgb, bh in JOBS:
        fix(f"{base}/{fn}", txt, rgb, bh)
