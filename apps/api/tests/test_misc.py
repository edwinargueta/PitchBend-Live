"""Small modules: sniffing, storage helpers, clock, and the api's import boundary."""

import errno
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from pitchbend_live import storage
from pitchbend_live.audio.sniff import sniff_audio
from pitchbend_live.clock import format_ts, now_ts, parse_ts, ts_after, utcnow
from pitchbend_live.settings import Settings


@pytest.mark.parametrize(
    ("head", "family"),
    [
        (b"ID3\x04\x00", "mp3"),
        (b"\xff\xfb\x90\x64", "mp3"),  # MPEG-1 layer III frame sync
        (b"\xff\xf3\x14\xc4", "mp3"),  # MPEG-2 layer III
        (b"\xff\xf1\x50\x80", "aac"),  # ADTS
        (b"\xff\xf9\x50\x80", "aac"),
        (b"ADIF\x00", "aac"),
        (b"RIFF\x24\x08\x00\x00WAVEfmt ", "wav"),
        (b"RF64\xff\xff\xff\xffWAVEds64", "wav"),
        (b"fLaC\x00\x00\x00\x22", "flac"),
        (b"OggS\x00\x02", "ogg"),
        (b"\x00\x00\x00\x20ftypM4A ", "mp4"),
        (b"\x00\x00\x00\x18ftypisom", "mp4"),
        (b"RIFF\x24\x08\x00\x00AVI LIST", None),
        (b"\x1aE\xdf\xa3", None),  # matroska/webm
        (b"\x89PNG\r\n\x1a\n", None),
        (b"%PDF-1.7", None),
        (b"<html>", None),
        (b"\xff", None),
        (b"\xff\x00", None),
        (b"", None),
    ],
)
def test_sniff(head: bytes, family: str | None) -> None:
    assert sniff_audio(head) == family


def test_clock_round_trip() -> None:
    now = utcnow()
    assert now.microsecond == 0
    text = format_ts(now)
    assert parse_ts(text) == now
    assert len(now_ts()) == 20 and now_ts().endswith("Z")
    assert ts_after("2026-09-26T12:00:00Z", hours=24) == "2026-09-27T12:00:00Z"
    assert ts_after("2026-09-26T12:00:00Z", seconds=-1) == "2026-09-26T11:59:59Z"


def test_ensure_dirs_creates_layout_with_modes(settings: Settings) -> None:
    storage.ensure_dirs(settings)
    storage.ensure_dirs(settings)  # idempotent
    assert stat.S_IMODE(os.stat(settings.MEDIA_DIR).st_mode) == 0o755
    assert stat.S_IMODE(os.stat(settings.TMP_DIR).st_mode) == 0o750
    assert stat.S_IMODE(os.stat(os.path.dirname(settings.DB_PATH)).st_mode) == 0o750


def test_paths(settings: Settings) -> None:
    job = "11111111-1111-4111-8111-111111111111"
    assert storage.job_dir(settings, job) == Path(settings.TMP_DIR) / job
    assert storage.staged_upload_path(settings, job).name == "upload"
    assert storage.cache_dir(settings, "deno") == Path(settings.TMP_DIR) / ".cache" / "deno"
    assert storage.media_url(settings, "a.m4a") == "/media/a.m4a"
    name = storage.new_media_name()
    assert name.endswith(".m4a") and len(name) == 40


def test_publish_media_is_atomic_readable_and_fresh(tmp_path: Path) -> None:
    src, dst = tmp_path / "src.m4a", tmp_path / "media" / "dst.m4a"
    dst.parent.mkdir()
    src.write_bytes(b"audio")
    os.chmod(src, 0o600)
    os.utime(src, (0, 0))
    storage.publish_media(src, dst)
    assert dst.read_bytes() == b"audio" and not src.exists()
    assert stat.S_IMODE(dst.stat().st_mode) == 0o644
    assert dst.stat().st_mtime > 1_000_000


def test_atomic_move_across_filesystems(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    src, dst = tmp_path / "src", tmp_path / "dst"
    src.write_bytes(b"data")
    real_replace = os.replace
    calls = {"n": 0}

    def exdev_once(a: object, b: object) -> None:
        calls["n"] += 1
        if calls["n"] == 1:
            raise OSError(errno.EXDEV, "cross-device link")
        real_replace(a, b)  # type: ignore[arg-type]

    monkeypatch.setattr(storage.os, "replace", exdev_once)
    storage.atomic_move(src, dst)
    assert dst.read_bytes() == b"data" and not src.exists()
    assert [p.name for p in tmp_path.iterdir()] == ["dst"]


def test_atomic_move_other_errors_propagate(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        storage.atomic_move(tmp_path / "missing", tmp_path / "dst")


def test_remove_path(tmp_path: Path) -> None:
    (tmp_path / "d" / "sub").mkdir(parents=True)
    (tmp_path / "d" / "sub" / "f").write_bytes(b"x")
    (tmp_path / "f").write_bytes(b"x")
    storage.remove_path(tmp_path / "d")
    storage.remove_path(tmp_path / "f")
    storage.remove_path(tmp_path / "missing")
    assert list(tmp_path.iterdir()) == []


def test_api_never_imports_worker_ytdlp_or_librosa() -> None:
    code = (
        "import sys, pitchbend_live.main\n"
        "bad = [m for m in ('librosa', 'numba', 'yt_dlp', 'pitchbend_live.worker',"
        " 'pitchbend_live.audio.key_detection') if m in sys.modules]\n"
        "assert not bad, bad\n"
    )
    subprocess.run([sys.executable, "-c", code], check=True, timeout=60)


def test_worker_import_does_not_load_librosa() -> None:
    code = (
        "import sys, pitchbend_live.worker\n"
        "assert 'librosa' not in sys.modules\n"
        "assert 'yt_dlp' in sys.modules\n"
    )
    subprocess.run([sys.executable, "-c", code], check=True, timeout=60)
