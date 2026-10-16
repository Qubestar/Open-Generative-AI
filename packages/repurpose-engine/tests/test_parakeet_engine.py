"""Unit tests for Vidmyo Repurpose Parakeet ASR engine adapter."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from vidmyo_repurpose.parakeet_engine import (
    ParakeetEngine,
    get_bin_dir,
    get_parakeet_cli_path,
)


def test_get_bin_dir_and_cli():
    bin_dir = get_bin_dir()
    assert bin_dir.is_dir()
    cli = get_parakeet_cli_path()
    assert cli is not None
    assert cli.is_file()


def test_parakeet_engine_output_formatting(tmp_path: Path):
    fake_cli = tmp_path / "fake-cli"
    fake_cli.touch(mode=0o755)
    fake_model = tmp_path / "fake-model.gguf"
    fake_model.touch()
    fake_audio = tmp_path / "sample.wav"
    fake_audio.touch()

    raw_json = json.dumps({
        "words": [
            {"start": 0.0, "end": 0.5, "w": "Hello", "conf": 0.98},
            {"start": 0.6, "end": 1.1, "w": "world!", "conf": 0.99},
            {"start": 2.5, "end": 3.0, "w": "Next", "conf": 0.95},
            {"start": 3.1, "end": 3.5, "w": "line.", "conf": 0.97},
        ]
    })

    mock_run = MagicMock()
    mock_run.returncode = 0
    mock_run.stdout = raw_json
    mock_run.stderr = ""

    with patch("subprocess.run", return_value=mock_run):
        engine = ParakeetEngine(cli_path=fake_cli, model_path=fake_model)
        segments, info = engine.transcribe(fake_audio)

    assert len(segments) == 2
    assert segments[0]["text"] == "Hello world!"
    assert segments[0]["start"] == 0.0
    assert segments[0]["end"] == 1.1
    assert len(segments[0]["words"]) == 2

    assert segments[1]["text"] == "Next line."
    assert segments[1]["start"] == 2.5
    assert segments[1]["end"] == 3.5
    assert len(segments[1]["words"]) == 2
    assert info["engine"] == "parakeet"
