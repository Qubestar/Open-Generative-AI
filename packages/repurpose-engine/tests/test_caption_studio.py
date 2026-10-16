from __future__ import annotations

import copy
import json
import shutil
import subprocess

import numpy as np
import pytest
from PIL import Image

from test_render import RenderMedia, prepared_render
from vidmyo_repurpose.caption_styles import STYLES, animate_cues, build_studio_overlay, normalize_caption_color, normalize_caption_font
from vidmyo_repurpose.contracts import ContractValidationError, validate_document
from vidmyo_repurpose.render import build_caption_cues, render_platform_outputs


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="local FFmpeg/FFprobe required")
def test_real_captioned_4k_video_keeps_audio_duration_and_decodes(tmp_path):
    from vidmyo_repurpose.render import _run_output

    source, master, upscaled = tmp_path / "source.mp4", tmp_path / "master.mp4", tmp_path / "4k.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=0x304650:s=1080x1920:r=24:d=1",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-preset", "ultrafast",
                    "-threads", "2", "-c:a", "aac", "-pix_fmt", "yuv420p", "-shortest", str(source)], check=True, timeout=30)
    overlays = []
    for index in range(2):
        record = build_studio_overlay("Make every word count.", "studio_karaoke_middle_clear", tmp_path / f"cue{index}.png", index)
        overlays.append({**record, "start_seconds": index * .5, "end_seconds": (index + 1) * .5})
    probe = lambda command: subprocess.run(command, capture_output=True, text=True)
    _run_output(source, master, 1, .25, ffmpeg=None, ffprobe=probe, overlays=overlays,
                video_args=["-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p"])
    fractions = []
    result = _run_output(master, upscaled, 1, .25, ffmpeg=None, ffprobe=probe, output_size=(2160, 3840), progress=fractions.append,
                        video_args=["-vf", "scale=2160:3840:flags=lanczos,setsar=1,unsharp=5:5:0.35:5:5:0", "-filter_threads", "2",
                                    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p"])
    assert (result["width"], result["height"], result["audio_codec"]) == (2160, 3840, "aac")
    assert abs(result["duration_seconds"] - 1) < .25
    assert fractions[-1] == 1 and any(0 < value < 1 for value in fractions)
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(upscaled), "-f", "null", "-"], check=True, timeout=30)
    assert source.is_file() and master.is_file()


@pytest.mark.parametrize("style", STYLES)
def test_background_can_be_removed_from_every_style(tmp_path, style):
    box, clear = tmp_path / "box.png", tmp_path / "clear.png"
    backed = build_studio_overlay("Make every word count.", f"studio_{style}_middle_box", box, 1)
    floating = build_studio_overlay("Make every word count.", f"studio_{style}_middle_clear", clear, 1)
    with Image.open(box) as image:
        with_box = np.array(image)
    with Image.open(clear) as image:
        without_box = np.array(image)
    assert with_box.shape == without_box.shape == (1920, 1080, 4)
    assert np.count_nonzero(with_box[:, :, 3]) > np.count_nonzero(without_box[:, :, 3])
    assert backed["visible_padding_left"] == backed["visible_padding_right"] == 30
    assert floating["visible_padding_left"] == floating["visible_padding_right"] == 0
    assert np.count_nonzero(without_box[:, :, 3]) > 100
    # Black outline remains even when the box is off.
    assert np.any((without_box[:, :, 0] == 16) & (without_box[:, :, 3] > 0))


def test_actual_highlight_moves_without_moving_phrase(tmp_path):
    images = []
    for index in (0, 1):
        output = tmp_path / f"{index}.png"
        build_studio_overlay("Make every word count.", "studio_karaoke_middle_clear", output, index)
        with Image.open(output) as image:
            images.append(np.array(image))
    assert np.array_equal(images[0][:, :, 3], images[1][:, :, 3])
    assert not np.array_equal(images[0][:, :, :3], images[1][:, :, :3])


def test_caption_brand_font_and_color_change_real_renderer_output(tmp_path):
    default_path, branded_path = tmp_path / "default.png", tmp_path / "branded.png"
    build_studio_overlay("Make every word count.", "studio_clean_middle_clear", default_path)
    build_studio_overlay(
        "Make every word count.", "studio_clean_middle_clear", branded_path,
        caption_color="#7c5cff", caption_font="montserrat",
    )
    with Image.open(default_path) as image:
        default = np.array(image)
    with Image.open(branded_path) as image:
        branded = np.array(image)
    assert not np.array_equal(default, branded)
    assert normalize_caption_color("#7c5cff") == "#7C5CFF"
    assert normalize_caption_font("montserrat") == "montserrat"
    with pytest.raises(ContractValidationError, match="six-digit hex"):
        normalize_caption_color("purple")
    with pytest.raises(ContractValidationError, match="caption_font"):
        normalize_caption_font("/tmp/untrusted.ttf")


def test_caption_brand_change_preserves_the_previous_render_variant(tmp_path):
    request = prepared_render(tmp_path)
    request["options"] = {"caption_style": "studio_clean_middle_box", "platforms": ["youtube_shorts"]}
    media = RenderMedia()
    original = render_platform_outputs(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    original_path = original.artifact["candidates"][0]["exports"][0]["output"]["path"]
    request["options"].update(caption_color="#7C5CFF", caption_font="montserrat")
    branded = render_platform_outputs(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    branded_path = branded.artifact["candidates"][0]["exports"][0]["output"]["path"]
    assert original_path != branded_path
    assert (tmp_path / original_path).is_file()
    assert (tmp_path / branded_path).is_file()
    assert branded.artifact["settings"]["caption_color"] == "#7C5CFF"
    assert branded.artifact["settings"]["caption_font"] == "montserrat"


def test_ambiguous_simultaneous_word_timing_falls_back_without_losing_words():
    words = [{"id": f"word_{i:06d}", "text": text, "start_seconds": 0, "end_seconds": .5}
             for i, text in enumerate(["Both", "words."])]
    cues = build_caption_cues(words, clip_start=0, clip_duration=1)
    for style in ("karaoke", "pop"):
        expanded = animate_cues(cues, words, f"studio_{style}_middle_clear", 0)
        assert expanded == cues


@pytest.mark.parametrize("mode", ["karaoke", "pop"])
def test_word_timed_styles_use_transcript_timing_and_preserve_word_order(mode):
    words = [{"id": f"word_{i:06d}", "text": text, "start_seconds": 10 + i * .6, "end_seconds": 10.4 + i * .6}
             for i, text in enumerate(["Make", "every", "word", "count."])]
    phrases = build_caption_cues(words, clip_start=10, clip_duration=3)
    cues = animate_cues(phrases, words, f"studio_{mode}_middle_clear", 10)
    assert [cue["word_ids"][0] for cue in cues] == [word["id"] for word in words]
    assert [cue["start_seconds"] for cue in cues] == [0, .6, 1.2, 1.8]
    assert [cue["end_seconds"] for cue in cues] == [.4, 1, 1.6, 2.2]
    if mode == "karaoke":
        assert [cue["active_word_index"] for cue in cues] == [0, 1, 2, 3]
        assert all(cue["text"] == "Make every word count." for cue in cues)
    else:
        assert [cue["text"] for cue in cues] == [word["text"] for word in words]


@pytest.mark.parametrize("style", STYLES)
def test_new_styles_complete_render_and_cache_with_clear_background(tmp_path, style):
    request = prepared_render(tmp_path)
    request["options"] = {"caption_style": f"studio_{style}_upper_clear", "platforms": ["youtube_shorts"]}
    media = RenderMedia()
    result = render_platform_outputs(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    validate_document("render_artifact", result.artifact)
    assert result.artifact["candidates"][0]["state"] == "completed"
    assert len(media.ffmpeg_calls) == 2
    assert all(overlay["visible_padding_left"] == 0 for overlay in result.artifact["candidates"][0]["caption"]["overlays"])
    assert render_platform_outputs(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe).cache_hit
    assert len(media.ffmpeg_calls) == 2


class UpscaleMedia(RenderMedia):
    def ffprobe(self, command):
        result = super().ffprobe(command)
        if "lanczos_4k" in command[-1]:
            document = json.loads(result.stdout)
            document["streams"][0].update(width=2160, height=3840)
            return subprocess.CompletedProcess(command, 0, json.dumps(document), "")
        return result


@pytest.mark.parametrize("mode", ["lanczos_4k", "lanczos_4k_sharp"])
def test_upscale_reuses_master_preserves_original_and_validates_4k(tmp_path, mode):
    request = prepared_render(tmp_path)
    request["options"] = {"caption_style": "studio_karaoke_middle_clear", "platforms": ["youtube_shorts"]}
    media = UpscaleMedia()
    original = render_platform_outputs(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    original_output = original.artifact["candidates"][0]["exports"][0]["output"]
    original_bytes = (tmp_path / original_output["path"]).read_bytes()
    request["options"]["upscale_mode"] = mode
    result = render_platform_outputs(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    assert len(media.ffmpeg_calls) == 3  # one new export, NOT another captioned master
    entry = result.artifact["candidates"][0]
    assert entry["master"] == original.artifact["candidates"][0]["master"]
    assert entry["exports"][0]["output"]["width"] == 2160
    assert entry["exports"][0]["output"]["height"] == 3840
    assert (tmp_path / original_output["path"]).read_bytes() == original_bytes
    command = media.ffmpeg_calls[-1]
    filters = command[command.index("-vf") + 1]
    assert "flags=lanczos" in filters
    assert ("unsharp=" in filters) == (mode == "lanczos_4k_sharp")
    assert "overlay=" not in " ".join(command)
    assert render_platform_outputs(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe).cache_hit
    assert len(media.ffmpeg_calls) == 3
    invalid = copy.deepcopy(result.artifact)
    invalid["candidates"][0]["exports"][0]["output"]["height"] = 1920
    with pytest.raises(ContractValidationError, match="dimensions"):
        validate_document("render_artifact", invalid)


def test_upscale_rejects_wrong_dimensions_without_replacing_original(tmp_path):
    request = prepared_render(tmp_path)
    request["options"] = {"platforms": ["youtube_shorts"]}
    media = RenderMedia()
    result = render_platform_outputs(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    original = result.artifact["candidates"][0]["exports"][0]["output"]
    contents = (tmp_path / original["path"]).read_bytes()
    request["options"]["upscale_mode"] = "lanczos_4k"
    from vidmyo_repurpose.render import RenderError
    with pytest.raises(RenderError, match="dimension"):
        render_platform_outputs(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    assert (tmp_path / original["path"]).read_bytes() == contents
    assert not list((tmp_path / "artifacts/platform-exports").glob("*lanczos_4k*"))


def test_background_change_invalidates_master(tmp_path):
    request = prepared_render(tmp_path)
    request["options"] = {"caption_style": "studio_clean_middle_box", "platforms": ["youtube_shorts"]}
    media = RenderMedia()
    first = render_platform_outputs(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    request["options"]["caption_style"] = "studio_clean_middle_clear"
    second = render_platform_outputs(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    assert len(media.ffmpeg_calls) == 4
    assert second.artifact["candidates"][0]["master"]["path"] != first.artifact["candidates"][0]["master"]["path"]
    assert (tmp_path / first.artifact["candidates"][0]["master"]["path"]).is_file()
