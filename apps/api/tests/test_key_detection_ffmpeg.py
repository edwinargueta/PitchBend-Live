"""Key detection through real ffmpeg: `decode()`, `detect_key()` and the time budget.

Skipped where ffmpeg isn't installed (the dev host); they run in the api container and CI:

    docker compose -f infra/docker-compose.dev.yml run --rm --no-deps api \\
        uv run pytest tests/test_key_detection_ffmpeg.py

`test_slow_*` encodes and analyzes 4 minutes of audio; deselect it with `-k "not slow"`.
"""

from __future__ import annotations

import shutil
import subprocess
import time
from pathlib import Path

import numpy as np
import pytest
from key_fixtures import synth

from keyshift.audio import key_detection as kd
from keyshift.audio.key_detection import KeyDetectionError, decode, detect_key

pytestmark = pytest.mark.skipif(
    shutil.which("ffmpeg") is None, reason="needs ffmpeg (runs in the api container)"
)

BUDGET_S = 5.0  # §10 A5: < 5 s for 4 minutes of audio on the VM


def encode(y: synth.Audio, path: Path, *args: str) -> Path:
    """Encode mono 22,050 Hz float samples to `path` with ffmpeg (output options `args`)."""
    argv = ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-f", "f32le", "-ar"]
    argv += [str(synth.SR), "-ac", "1", "-i", "pipe:0", *args, str(path)]
    subprocess.run(argv, input=y.astype("<f4").tobytes(), check=True, timeout=120)
    return path


def m4a(y: synth.Audio, path: Path) -> Path:
    """AAC in .m4a at 44.1 kHz stereo, like the pipeline's playback files (D8)."""
    return encode(y, path, "-ar", "44100", "-ac", "2", "-c:a", "aac", "-b:a", "192k")


def test_decode_downmixes_and_resamples_to_mono_22050(tmp_path: Path) -> None:
    y = synth.cadence_fixture("C", "major")
    samples, sr = decode(m4a(y, tmp_path / "song.m4a"))
    assert sr == 22_050
    assert samples.dtype == np.float32
    assert samples.ndim == 1
    assert abs(len(samples) - len(y)) < 0.1 * sr  # AAC adds a little priming/padding
    rms = float(np.sqrt(np.mean(samples**2)))
    assert rms == pytest.approx(float(np.sqrt(np.mean(y**2))), rel=0.1)


@pytest.mark.parametrize(
    ("suffix", "args"),
    [
        (".m4a", ("-ar", "44100", "-ac", "2", "-c:a", "aac", "-b:a", "192k")),
        (".wav", ("-ar", "48000", "-c:a", "pcm_s16le")),
        (".flac", ("-c:a", "flac")),
    ],
)
@pytest.mark.parametrize(("tonic", "mode"), [("D", "minor"), ("A#", "major")])
def test_detect_key_from_files(
    tmp_path: Path, suffix: str, args: tuple[str, ...], tonic: str, mode: kd.Mode
) -> None:
    path = encode(synth.cadence_fixture(tonic, mode, cents=-20), tmp_path / f"x{suffix}", *args)
    result = detect_key(path)
    assert (result.tonic, result.mode) == (tonic, mode)
    assert abs(result.tuning_cents + 20) <= 3


def test_paths_that_look_like_options_or_urls_are_plain_files(tmp_path: Path) -> None:
    y = synth.scale_fixture("E", "minor")
    for name in ("-i evil name.m4a", "http:x.m4a"):
        result = detect_key(m4a(y, tmp_path / "src.m4a").rename(tmp_path / name))
        assert (result.tonic, result.mode) == ("E", "minor")


def test_missing_file_raises(tmp_path: Path) -> None:
    with pytest.raises(KeyDetectionError, match="decode failed"):
        decode(tmp_path / "missing.m4a")


@pytest.mark.parametrize("content", [b"", b"this is not audio\n" * 100], ids=["empty", "text"])
def test_non_audio_file_raises(tmp_path: Path, content: bytes) -> None:
    path = tmp_path / "bad.m4a"
    path.write_bytes(content)
    with pytest.raises(KeyDetectionError, match="decode failed"):
        detect_key(path)


def test_silent_file_raises(tmp_path: Path) -> None:
    path = m4a(np.zeros(10 * synth.SR, np.float32), tmp_path / "silence.m4a")
    with pytest.raises(KeyDetectionError, match="silent"):
        detect_key(path)


def test_noise_file_raises(tmp_path: Path) -> None:
    path = m4a(synth.mix(synth.drums(10.0), synth.white_noise(10.0)), tmp_path / "noise.m4a")
    with pytest.raises(KeyDetectionError, match="tonal"):
        detect_key(path)


def test_slow_four_minutes_within_budget(tmp_path: Path) -> None:
    """§10 A5: < 5 s for a 4-minute song. Excludes the one-off librosa import and numba
    JIT of the process's first call (a few seconds; see scripts/bench_key_detection.py)."""
    rng = np.random.default_rng(240)
    y = synth.random_song(rng, "G", "major", dur=240.0, cents=-12, snr_db=20, with_drums=True)
    path = m4a(y, tmp_path / "song.m4a")
    detect_key(m4a(synth.cadence_fixture("C", "major"), tmp_path / "warm.m4a"))  # warm up
    start = time.perf_counter()
    result = detect_key(path)
    elapsed = time.perf_counter() - start
    assert (result.tonic, result.mode) == ("G", "major")
    assert elapsed < BUDGET_S, f"4-minute detection took {elapsed:.2f} s"
