"""Regenerate shipped style demos with the SAME renderer used by Finish.

Run from the repository: PYTHONPATH=packages/repurpose-engine/src python3
packages/repurpose-engine/scripts/generate_caption_previews.py
No provider calls. Keep generated JSON in sync when fonts/styles change.
"""
import base64
import io
import json
import tempfile
from pathlib import Path

from PIL import Image
from vidmyo_repurpose.caption_styles import STYLES, build_studio_overlay


def png_url(image):
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()


def generate():
    result = {}
    words = "Make every word count.".split()
    with tempfile.TemporaryDirectory(prefix="vidmyo-caption-swatches-") as directory:
        for name, spec in STYLES.items():
            result[name] = {"label": spec["label"], "backgrounds": {}}
            for backing in ("box", "clear"):
                frames = []
                thumbnail = None
                for index in range(len(words) if name in {"karaoke", "pop"} else 1):
                    output = Path(directory) / "frame.png"
                    text = words[index] if name == "pop" else " ".join(words)
                    build_studio_overlay(text, f"studio_{name}_middle_{backing}", output, index)
                    with Image.open(output) as image:
                        frames.append(png_url(image.resize((324, 576), Image.Resampling.LANCZOS)))
                        if index == 0:
                            thumbnail = png_url(image.crop((0, 1170, 1080, 1460)).resize((324, 87), Image.Resampling.LANCZOS))
                result[name]["backgrounds"][backing] = {"frames": frames, "thumbnail": thumbnail}
    destination = Path(__file__).resolve().parents[2] / "studio/src/captionPreviews.json"
    destination.write_text(json.dumps(result, separators=(",", ":")) + "\n")
    print(f"Generated 6 caption looks (with/without background): {destination}")


if __name__ == "__main__":
    generate()
