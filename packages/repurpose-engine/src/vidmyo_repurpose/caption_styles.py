"""Local caption studio. The export and visual swatches use this same renderer.

Fonts are bundled under the SIL Open Font License; no network/font lookup occurs
while rendering. Legacy OpenCV styles remain readable in render.py.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

from .contracts import ContractValidationError
from .ingest import fingerprint_file

STYLES = {
    "clean": {"label": "Clean", "font": "BarlowCondensed-SemiBold.ttf", "size": 76, "color": "#ffffff", "stroke": 2},
    "bold": {"label": "Impact", "font": "Anton-Regular.ttf", "size": 86, "color": "#ffe34d", "stroke": 4},
    "outline": {"label": "Outline", "font": "Anton-Regular.ttf", "size": 82, "color": "#ffffff", "stroke": 6},
    "karaoke": {"label": "Word highlight", "font": "BarlowCondensed-SemiBold.ttf", "size": 86, "color": "#ffffff", "stroke": 3},
    "pop": {"label": "One word", "font": "Anton-Regular.ttf", "size": 112, "color": "#9bffbb", "stroke": 4},
    "editorial": {"label": "Editorial", "font": "BarlowCondensed-SemiBold.ttf", "size": 64, "color": "#fff0d4", "stroke": 2},
}
POSITIONS = {"upper": 1160, "middle": 1380, "lower": 1580}
STYLE_NAMES = {f"studio_{style}_{position}_{backing}" for style in STYLES for position in POSITIONS for backing in ("box", "clear")}
FONT_CHOICES = {
    "preset": None,
    "montserrat": "Montserrat-Variable.ttf",
    "barlow_condensed": "BarlowCondensed-SemiBold.ttf",
    "anton": "Anton-Regular.ttf",
}
COLOR_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")


def normalize_caption_color(value: Any) -> str:
    if value in (None, "preset"):
        return "preset"
    if not isinstance(value, str) or not COLOR_PATTERN.fullmatch(value):
        raise ContractValidationError("options.caption_color: must be preset or a six-digit hex color")
    return value.upper()


def normalize_caption_font(value: Any) -> str:
    value = "preset" if value is None else value
    if value not in FONT_CHOICES:
        raise ContractValidationError(
            "options.caption_font: must be preset, montserrat, barlow_condensed, or anton"
        )
    return value


def _contrast_stroke(color: str) -> str:
    red, green, blue = (int(color[index:index + 2], 16) for index in (1, 3, 5))
    luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255
    return "#FFFFFF" if luminance < 0.35 else "#101417"


def parse_style(name: str) -> tuple[str, str, bool]:
    if name not in STYLE_NAMES:
        raise ContractValidationError(f"options.caption_style: unsupported style {name!r}")
    _, style, position, backing = name.split("_")
    return style, position, backing == "box"


def animate_cues(cues: list[dict[str, Any]], words: list[dict[str, Any]], style: str,
                 clip_start: float) -> list[dict[str, Any]]:
    """Expand only timed styles; each authoritative word remains represented once.

    Highlight holds the whole phrase while advancing its accent on real word
    timestamps. One-word shows only the spoken word. Silence remains transparent.
    """
    name, _, _ = parse_style(style)
    if name not in {"karaoke", "pop"}:
        return cues
    by_id = {word["id"]: word for word in words}
    expanded = []
    for cue in cues:
        group = []
        for index, word_id in enumerate(cue["word_ids"]):
            word = by_id[word_id]
            start = max(cue["start_seconds"], float(word["start_seconds"]) - clip_start)
            end = min(cue["end_seconds"], float(word["end_seconds"]) - clip_start)
            if index + 1 < len(cue["word_ids"]):
                end = min(end, float(by_id[cue["word_ids"][index + 1]]["start_seconds"]) - clip_start)
            if end <= start:
                # Ambiguous simultaneous timestamps cannot drive a positive
                # per-word highlight. Preserve the complete readable phrase
                # instead of silently dropping words or inventing timings.
                group = [{**cue}]
                break
            item = {"start_seconds": round(start, 6),
                    "end_seconds": round(end, 6), "text": cue["text"] if name == "karaoke" else word["text"].strip(),
                    "word_ids": [word_id]}
            if name == "karaoke":
                # Provider words can contain whitespace; align to displayed tokens.
                item["active_word_index"] = sum(len(by_id[prior]["text"].split()) for prior in cue["word_ids"][:index])
            group.append(item)
        for item in group:
            expanded.append({**item, "id": f"cue_{len(expanded) + 1:04d}"})
    return expanded


def build_studio_overlay(text: str, style_name: str, destination: Path,
                         active_word_index: int | None = None,
                         caption_color: str = "preset", caption_font: str = "preset") -> dict[str, Any]:
    from PIL import Image, ImageDraw, ImageFont

    name, position, background = parse_style(style_name)
    spec = STYLES[name]
    caption_color = normalize_caption_color(caption_color)
    caption_font = normalize_caption_font(caption_font)
    display = text.upper() if name in {"bold", "outline", "pop"} else text
    tokens = display.split()
    if not tokens:
        raise ContractValidationError("caption text: phrase must contain visible text")
    font_path = Path(__file__).parent / "fonts" / (FONT_CHOICES[caption_font] or spec["font"])
    size = spec["size"]
    stroke = spec["stroke"]
    font = ImageFont.truetype(str(font_path), size)
    while font.getlength(display) > 880 and size > 24:
        size -= 2
        font = ImageFont.truetype(str(font_path), size)
    if font.getlength(display) > 880:
        raise ContractValidationError("caption text: phrase cannot fit inside the horizontal safe zone")
    # Measure actual glyphs, so box padding isn't skewed by font side bearings.
    glyphs = Image.new("RGBA", (1080, 250))
    draw = ImageDraw.Draw(glyphs)
    x = 50.0
    for index, token in enumerate(tokens):
        is_active = name == "karaoke" and index == active_word_index
        color = (caption_color if caption_color != "preset" else "#ffe34d") if is_active else spec["color"]
        if name != "karaoke" and caption_color != "preset":
            color = caption_color
        stroke_color = _contrast_stroke(color) if caption_color != "preset" else "#101417"
        draw.text((round(x), 40), token, font=font, fill=color, stroke_width=stroke, stroke_fill=stroke_color)
        x += font.getlength(token + " ")
    bbox = glyphs.getbbox()
    if bbox is None:
        raise ContractValidationError("caption text: phrase produced no visible pixels")
    glyphs = glyphs.crop(bbox)
    left = (1080 - glyphs.width) // 2
    bottom = POSITIONS[position]
    top = bottom - glyphs.height + 1
    pad_x, pad_y = (30, 18) if background else (0, 0)
    image = Image.new("RGBA", (1080, 1920))
    if background:
        ImageDraw.Draw(image).rounded_rectangle(
            (left - pad_x, top - pad_y, left + glyphs.width - 1 + pad_x, bottom + pad_y),
            radius=14, fill=(9, 13, 16, 210),
        )
    image.alpha_composite(glyphs, (left, top))
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.parent / f".{destination.name}.{os.getpid()}.tmp.png"
    try:
        image.save(temporary)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    right = left + glyphs.width - 1
    return {"path": destination.as_posix(), "fingerprint": fingerprint_file(destination),
            "text_left": left, "text_right": right, "backing_left": left - pad_x, "backing_right": right + pad_x,
            "visible_padding_left": pad_x, "visible_padding_right": pad_x}
